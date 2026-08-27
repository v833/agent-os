/**
 * bitable-board 看板插件：把 Agent OS 任务生命周期实时同步到飞书多维表格，
 * 并轮询表格记录反向拉起新任务。支持运行时通过 mount() 动态热挂载、本地持久化
 * (data/bitable-board.json) 与冷启动自愈。
 */
import { Service, type Context } from "cordis";
import * as Lark from "@larksuiteoapi/node-sdk";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import type { IncomingMessage } from "../im/lark.js";
import {
  BOARD_STATES,
  DEFAULT_BOARD_FIELDS,
  type BoardFields,
  type BoardRecord,
  type BoardSnapshot,
  type BitableFieldValue,
  type SeenBoardRecord,
  buildBoardFields,
  detectReverseTriggers,
  extractArtifactUrls,
  isBoardState,
  mergeBoardSnapshots,
  parseBoardRecord,
  reverseTaskId,
  stateForEvent,
} from "../core/bitable-board.js";
import type {
  ProductSpecApprovedPayload,
  QAResultPayload,
  TaskResultPayload,
  TaskStartedPayload,
  TaskToolCallsOutcome,
  TaskToolCallsPayload,
} from "./types.js";

/** 看板持久化缓存数据结构。 */
export interface BitableBoardStorage {
  appToken: string;
  tableId: string;
  url: string;
  name: string;
  botId?: string;
  /** 反向拉起时记录未填群聊ID的回退群聊；/board init 时绑定初始化群。 */
  fallbackChatId?: string;
  createdAt: string;
  updatedAt: string;
}

const StorageSchema = z.object({
  appToken: z.string().trim().min(1),
  tableId: z.string().trim().min(1),
  url: z.string().trim().min(1).refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "看板链接必须是 HTTPS URL"),
  name: z.string().trim().min(1),
  botId: z.string().trim().optional(),
  fallbackChatId: z.string().trim().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const DEFAULT_BOARD_STORAGE_PATH = "data/bitable-board.json";

/** 从本地持久化文件读取看板配置。 */
export function loadBoardStorage(
  filePath = DEFAULT_BOARD_STORAGE_PATH,
): BitableBoardStorage | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return StorageSchema.parse(parsed);
  } catch (error) {
    console.warn(`[看板] 读取本地看板配置失败 (${filePath}):`, (error as Error).message);
    return null;
  }
}

/** 原子写入本地持久化看板配置。 */
export function saveBoardStorage(
  data: BitableBoardStorage,
  filePath = DEFAULT_BOARD_STORAGE_PATH,
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // 清理失败不覆盖原始持久化错误。
    }
    throw new Error(
      `保存本地看板配置失败 (${filePath}): ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/** 看板插件配置；全部可选，支持冷启动从 storage 恢复或后续 /board init 热挂载。 */
export interface Config {
  /** 多维表格 app_token，可选。 */
  appToken?: string;
  /** 多维表格数据表 ID，可选。 */
  tableId?: string;
  /** 看板直达 URL，可选。 */
  url?: string;
  /** 看板名称，可选。 */
  name?: string;
  /** 调用 Bitable API 的 bot；缺省用 Team Leader。 */
  botId?: string;
  /** 表字段名覆盖；缺省使用 issue 规定的默认中文名。 */
  fields?: Partial<BoardFields>;
  /** 单向事件同步开关，默认开启。 */
  sync?: boolean;
  /** 反向拉起开关，默认开启。 */
  pull?: boolean;
  /** 反向拉起轮询间隔（毫秒），默认 30_000。 */
  pollIntervalMs?: number;
  /** 事件同步节流窗口（毫秒），窗口内同一任务合并为一次写入，默认 1_500。 */
  batchDelayMs?: number;
  /** 记录未填写群聊ID时反向拉起的回退群聊；留空则跳过无群聊的记录。 */
  fallbackChatId?: string;
  /** 单条同步写失败的最大重试次数，默认 3。 */
  maxRetries?: number;
  /** 本地持久化文件路径，默认 data/bitable-board.json。 */
  storagePath?: string;
}

const ConfigSchema = z.object({
  appToken: z.string().trim().optional(),
  tableId: z.string().trim().optional(),
  url: z.string().trim().optional(),
  name: z.string().trim().optional(),
  botId: z.string().trim().min(1).optional(),
  fields: z.record(z.string(), z.string()).optional(),
  sync: z.boolean().optional(),
  pull: z.boolean().optional(),
  pollIntervalMs: z.number().int().min(1_000).optional(),
  batchDelayMs: z.number().int().min(100).optional(),
  fallbackChatId: z.string().trim().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  storagePath: z.string().trim().optional(),
});

/** 看板 Bitable 读写的最小接口；测试用假实现替换，不依赖 SDK 类型。 */
export interface BitableRecordClient {
  list(): Promise<BoardRecord[]>;
  create(
    fields: Record<string, BitableFieldValue>,
    clientToken: string,
  ): Promise<{ recordId: string }>;
  update(
    recordId: string,
    fields: Record<string, BitableFieldValue>,
  ): Promise<void>;
}

/** 飞书 Bitable 记录接口的最小请求间隔；所有读写共享，严格限制为最多 10 QPS。 */
const BITABLE_REQUEST_INTERVAL_MS = 100;

function responseErrorMessage(
  response: { code?: unknown; msg?: unknown },
  fallback: string,
): string {
  const message = typeof response.msg === "string" ? response.msg.trim() : "";
  const rawCode = response.code;
  const code = rawCode === undefined || rawCode === null ? "" : String(rawCode);
  const numericCode = Number(rawCode);
  const hasCode =
    rawCode !== undefined &&
    rawCode !== null &&
    rawCode !== "" &&
    (Number.isFinite(numericCode) ? numericCode !== 0 : true);
  if (message) return hasCode ? `${message} (code: ${code})` : message;
  return hasCode ? `${fallback}(code: ${code})` : fallback;
}

function hasApiErrorCode(code: unknown): boolean {
  if (code === undefined || code === null || code === "") return false;
  const numeric = Number(code);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

function isMissingBoardError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("1254001") || message.includes("1254003");
}

function isBitablePermissionError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; data?: { code?: unknown; msg?: unknown } };
  };
  const status = Number(
    candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status,
  );
  const code = String(candidate?.code ?? candidate?.response?.data?.code ?? "");
  const message = String(
    error instanceof Error
      ? error.message
      : candidate?.response?.data?.msg ?? String(error)
  ).toLowerCase();
  return (
    status === 403 ||
    code === "99991663" ||
    code === "99991664" ||
    message.includes("403") ||
    message.includes("99991663") ||
    message.includes("99991664") ||
    message.includes("bitable:app")
  );
}

function normalizeBoardUrl(url: string | undefined, appToken: string): string {
  const value = url?.trim() || `https://feishu.cn/base/${appToken}`;
  try {
    if (new URL(value).protocol !== "https:") throw new Error("协议不是 HTTPS");
  } catch (error) {
    throw new Error(`看板链接必须是 HTTPS URL: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return value;
}

export function createBitableRecordClient(
  lark: Lark.Client,
  appToken: string,
  tableId: string,
  fields: BoardFields,
): BitableRecordClient {
  let requestTail = Promise.resolve();
  let lastRequestStartedAt = 0;

  const request = <T>(operation: () => Promise<T>): Promise<T> => {
    const scheduled = requestTail.then(async () => {
      let remaining =
        BITABLE_REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt);
      while (remaining > 0) {
        await sleep(remaining);
        remaining =
          BITABLE_REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt);
      }
      lastRequestStartedAt = Date.now();
      return operation();
    });
    requestTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };

  return {
    async list() {
      const records: BoardRecord[] = [];
      let pageToken: string | undefined;
      do {
        const response = await request(() =>
          lark.bitable.v1.appTableRecord.list({
            path: { app_token: appToken, table_id: tableId },
            params: {
              page_size: 100,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          }),
        );
        if (hasApiErrorCode(response.code)) {
          throw new Error(responseErrorMessage(response, "查询多维表格记录失败"));
        }
        for (const item of response.data?.items ?? []) {
          records.push(parseBoardRecord(item, fields));
        }
        const pageData = response.data as
          | (typeof response.data & { next_page_token?: string })
          | undefined;
        pageToken = pageData?.has_more
          ? pageData.page_token || pageData.next_page_token
          : undefined;
      } while (pageToken);
      return records;
    },
    async create(fieldsData, clientToken) {
      const response = await request(() =>
        lark.bitable.v1.appTableRecord.create({
          path: { app_token: appToken, table_id: tableId },
          params: { client_token: clientToken },
          data: { fields: fieldsData },
        }),
      );
      if (hasApiErrorCode(response.code)) {
        throw new Error(responseErrorMessage(response, "新增多维表格记录失败"));
      }
      const recordId = response.data?.record?.record_id;
      if (!recordId) throw new Error("多维表格未返回 record_id");
      return { recordId };
    },
    async update(recordId, fieldsData) {
      const response = await request(() =>
        lark.bitable.v1.appTableRecord.update({
          path: { app_token: appToken, table_id: tableId, record_id: recordId },
          data: { fields: fieldsData },
        }),
      );
      if (hasApiErrorCode(response.code)) {
        throw new Error(responseErrorMessage(response, "更新多维表格记录失败"));
      }
    },
  };
}

const MAX_TITLE_LENGTH = 300;

function fitTitle(title: string): string {
  const normalized = title.trim();
  return normalized.length <= MAX_TITLE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SCAN_RETRY_DELAY_MS = 15_000;
const MAX_COUNTED_RUNS_PER_TASK = 64;

export interface MountBoardOptions {
  appToken: string;
  tableId: string;
  url?: string;
  name?: string;
  botId?: string;
  fields?: Partial<BoardFields>;
  /** 反向拉起时记录未填群聊ID的回退群聊；/board init 绑定初始化群。 */
  fallbackChatId?: string;
  /** 沿用既有持久化时间；冷启动恢复时传入缓存值保证 /board link 一致。 */
  createdAt?: string;
  updatedAt?: string;
  saveToStorage?: boolean;
}

export interface BitableBoardStatus {
  mounted: boolean;
  appToken?: string;
  tableId?: string;
  url?: string;
  name?: string;
  indexedTasksCount: number;
  seenRecordsCount: number;
  pendingSyncCount: number;
  syncEnabled: boolean;
  pullEnabled: boolean;
  initializing: boolean;
  degraded: boolean;
}

/**
 * 看板同步服务：维护 taskId→recordId 索引、节流合并队列与反向拉起轮询。
 * 继承 Cordis Service，支持运行时通过 mount() 热挂载与动态切换。
 */
export class BitableBoardService extends Service {
  readonly recordIndex = new Map<string, string>();
  readonly seenRecords = new Map<string, SeenBoardRecord>();
  private readonly pending = new Map<string, BoardSnapshot>();
  private readonly snapshots = new Map<string, BoardSnapshot>();
  private readonly countedRuns = new Map<string, Set<string>>();
  /** 表格里 title/bot/state/任务ID 全空的空记录 recordId 池；新建任务记录优先复用。 */
  private emptyRecordIds: string[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private flushPromise?: Promise<void>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private pulling = false;
  private pullPromise?: Promise<void>;
  private retryScanTimer?: ReturnType<typeof setTimeout>;
  private scanReady = false;

  private client?: BitableRecordClient;
  private currentConfig: Config;
  private currentFields: BoardFields;
  private currentStorage: BitableBoardStorage | null = null;
  private storagePath: string;
  private listenersRegistered = false;
  private mountPromise: Promise<void> | undefined;
  private initializing = false;
  private degraded = false;
  private degradedNotified = false;
  // 热切换不等待后台扫描；代际用于阻止旧请求返回后覆盖新看板状态。
  private scanGeneration = 0;

  constructor(ctx: Context, initialConfig: Config = {}) {
    super(ctx, "bitableBoard");
    this.currentConfig = { ...initialConfig };
    this.storagePath = initialConfig.storagePath || DEFAULT_BOARD_STORAGE_PATH;
    this.currentFields = {
      ...DEFAULT_BOARD_FIELDS,
      ...(initialConfig.fields ?? {}),
    };
  }

  /** 获取当前挂载配置的存储信息。 */
  getStorage(): BitableBoardStorage | null {
    return this.currentStorage;
  }

  /** 是否已成功挂载看板。 */
  isMounted(): boolean {
    return Boolean(this.client && this.currentStorage?.appToken);
  }

  /** 获取当前服务状态。 */
  getStatus(): BitableBoardStatus {
    return {
      mounted: this.isMounted(),
      appToken: this.currentStorage?.appToken,
      tableId: this.currentStorage?.tableId,
      url: this.currentStorage?.url,
      name: this.currentStorage?.name,
      indexedTasksCount: this.recordIndex.size,
      seenRecordsCount: this.seenRecords.size,
      pendingSyncCount: this.pending.size,
      syncEnabled: this.currentConfig.sync ?? true,
      pullEnabled: this.currentConfig.pull ?? true,
      initializing: this.initializing,
      degraded: this.degraded,
    };
  }

  /** 抢占一次建表初始化；并发调用只允许第一个进入 OpenAPI 流程。 */
  beginInitialization(): boolean {
    if (this.initializing) return false;
    this.initializing = true;
    return true;
  }

  /** 释放建表初始化锁，供命令插件在 finally 中调用。 */
  endInitialization(): void {
    this.initializing = false;
  }

  /** 热挂载/重新挂载看板。 */
  async mount(options: MountBoardOptions, customClient?: BitableRecordClient): Promise<void> {
    const previous = this.mountPromise ?? Promise.resolve();
    const current = previous.then(() => this.mountInternal(options, customClient)).catch((error) => {
      if (!this.currentStorage) this.degraded = true;
      throw error;
    });
    this.mountPromise = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async mountInternal(
    options: MountBoardOptions,
    customClient?: BitableRecordClient,
  ): Promise<void> {

    const botId = options.botId || this.currentConfig.botId || this.ctx.config.teamLeaderId;
    const runtime = this.ctx.lark.bot(botId);
    if (!runtime && !customClient) {
      throw new Error(`看板插件找不到用于调用 Bitable 的 bot: ${botId}`);
    }

    // 注意：fallbackChatId 只在挂载提交成功后写入 currentConfig，避免候选表
    // 扫描/持久化失败（保留旧看板）时污染旧看板的回退群，导致反向任务跑错群。
    // 候选 storage 里仍用 options 的新值，提交成功后才生效。

    const candidateFields: BoardFields = {
      ...DEFAULT_BOARD_FIELDS,
      ...(options.fields ?? this.currentConfig.fields ?? {}),
    };
    const candidateClient = customClient ?? (runtime
      ? createBitableRecordClient(
        runtime.bot.client,
        options.appToken,
        options.tableId,
        candidateFields,
      )
      : undefined);
    if (!candidateClient) {
      throw new Error(`看板插件找不到用于调用 Bitable 的 bot: ${botId}`);
    }

    const now = new Date().toISOString();
    const sameBoard =
      this.currentStorage?.appToken === options.appToken &&
      this.currentStorage?.tableId === options.tableId;
    const candidateStorage: BitableBoardStorage = {
      appToken: options.appToken,
      tableId: options.tableId,
      url: normalizeBoardUrl(options.url, options.appToken),
      name: options.name || "Agent OS 任务看板",
      botId,
      // 冷启动恢复（options.createdAt/updatedAt 来自缓存）时沿用原时间，
      // 保证 /board link 重启前后输出一致；否则用当前时间。
      fallbackChatId: options.fallbackChatId || this.currentConfig.fallbackChatId,
      createdAt: options.createdAt ?? (sameBoard ? this.currentStorage?.createdAt : undefined) ?? now,
      updatedAt: options.updatedAt ?? now,
    };

    // 先验证候选表并构建索引；已有看板切换时任何失败都保留旧看板。
    // 首次挂载若遇到临时网络/资源故障，则先以 degraded 状态接管，保留事件
    // 快照；权限错误必须交给命令层展示开通指引，不能伪装成可恢复降级。
    const hadPreviousBoard = Boolean(this.currentStorage && this.client);
    // 记录候选表扫描开始时的待冲刷快照。扫描、持久化和等待旧请求期间仍可能收到
    // 任务事件；切换成功后只把这段窗口内新增/更新的快照转移到新表，避免丢事件，
    // 同时丢弃切换前已经属于旧表的积压数据。
    const pendingAtScanStart = new Map(this.pending);
    let candidateDegraded = false;
    let candidateError: unknown;
    let scanned: Awaited<ReturnType<typeof this.scanClient>>;
    try {
      scanned = await this.scanClient(candidateClient, false);
    } catch (error) {
      if (hadPreviousBoard || isBitablePermissionError(error)) throw error;
      candidateDegraded = true;
      candidateError = error;
      scanned = {
        recordIndex: new Map(),
        seenRecords: new Map(),
        snapshots: new Map(),
        emptyRecordIds: [],
      };
      console.error(
        "[看板] 首次扫描失败，先以降级状态挂载并后台重试:",
        (error as Error).message,
      );
    }
    if (options.saveToStorage !== false) {
      saveBoardStorage(candidateStorage, this.storagePath);
    }
    // 候选表验证和持久化完成后，等待旧看板正在进行的读写收尾，
    // 避免热切换后在途请求把旧快照写入新看板或改写新索引。
    const activeOperations = [this.flushPromise, this.pullPromise].filter(
      (operation): operation is Promise<void> => Boolean(operation),
    );
    if (activeOperations.length > 0) await Promise.allSettled(activeOperations);
    const pendingDuringMount = new Map<string, BoardSnapshot>();
    const countedRunsDuringMount = new Map<string, Set<string>>();
    for (const [taskId, snapshot] of this.pending) {
      if (pendingAtScanStart.get(taskId) !== snapshot) {
        pendingDuringMount.set(taskId, snapshot);
        const counted = this.countedRuns.get(taskId);
        if (counted) countedRunsDuringMount.set(taskId, new Set(counted));
      }
    }
    this.stop();
    this.client = candidateClient;
    this.currentFields = candidateFields;
    this.currentStorage = candidateStorage;
    // 挂载提交成功后才切换回退群，候选失败时旧看板保持原配置。
    if (options.fallbackChatId) {
      this.currentConfig.fallbackChatId = options.fallbackChatId;
    }
    this.recordIndex.clear();
    for (const [taskId, recordId] of scanned.recordIndex) {
      this.recordIndex.set(taskId, recordId);
    }
    this.emptyRecordIds = [...scanned.emptyRecordIds];
    this.seenRecords.clear();
    for (const [recordId, seen] of scanned.seenRecords) {
      this.seenRecords.set(recordId, seen);
    }
    this.pending.clear();
    this.snapshots.clear();
    for (const [taskId, snapshot] of scanned.snapshots) {
      this.snapshots.set(taskId, snapshot);
    }
    for (const [taskId, snapshot] of pendingDuringMount) {
      const merged = mergeBoardSnapshots(
        this.snapshots.get(taskId),
        snapshot,
        false,
      );
      this.snapshots.set(taskId, merged);
      this.pending.set(taskId, merged);
    }
    this.countedRuns.clear();
    for (const [taskId, counted] of countedRunsDuringMount) {
      this.countedRuns.set(taskId, counted);
    }
    this.scanReady = !candidateDegraded;
    this.degraded = candidateDegraded;
    this.degradedNotified = false;
    if (!this.listenersRegistered) {
      this.registerEventListeners();
      this.listenersRegistered = true;
    }
    this.startPolling();
    if (candidateDegraded) {
      this.scheduleScanRetry();
      if (candidateError && isMissingBoardError(candidateError)) {
        void this.notifyDegraded(candidateError);
      }
    }
    if (process.env.DEBUG_BOARD) {
      console.log(
        `[看板] 热挂载完成 appToken=${options.appToken} tableId=${options.tableId} name=${this.currentStorage.name}`,
      );
    }
  }

  /** 全量扫描建立索引与 seen 快照，并启动定时轮询。 */
  async init(): Promise<void> {
    // mount() 的候选表扫描是异步的；调用方可能在它完成前进入 init()。
    // 先等待当前挂载队列，避免事件监听、索引和 scanReady 出现竞态。
    if (this.mountPromise) await this.mountPromise;
    if (!this.client) return;
    if (!this.listenersRegistered) {
      this.registerEventListeners();
      this.listenersRegistered = true;
    }
    await this.safeScan();
    this.startPolling();
  }

  private startPolling(): void {
    const pullEnabled = this.currentConfig.pull ?? true;
    const pollInterval = this.currentConfig.pollIntervalMs ?? 30_000;
    if (pullEnabled && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.pullOnce().catch((error) => {
          console.error("[看板] 反向拉起轮询失败:", (error as Error).message);
        });
      }, pollInterval);
    }
  }

  /** 停止节流定时器、扫描重试与轮询。 */
  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryScanTimer) clearTimeout(this.retryScanTimer);
    this.flushTimer = undefined;
    this.pollTimer = undefined;
    this.retryScanTimer = undefined;
    this.scanGeneration += 1;
    this.scanReady = false;
  }

  private async safeScan(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const generation = this.scanGeneration;
    try {
      const scanned = await this.scanClient(client, true);
      if (generation !== this.scanGeneration || client !== this.client) return;
      this.applyScan(scanned);
      this.scanReady = true;
      this.degraded = false;
      this.degradedNotified = false;
      this.scheduleFlush();
    } catch (error) {
      if (generation !== this.scanGeneration || client !== this.client) return;
      this.degraded = true;
      if (isMissingBoardError(error)) {
        void this.notifyDegraded(error);
      }
      console.error(
        "[看板] 全量扫描失败，稍后后台重试:",
        (error as Error).message,
      );
      this.scheduleScanRetry();
    }
  }

  /** 安排单个后台扫描重试，避免挂载失败时创建多个定时器。 */
  private scheduleScanRetry(): void {
    if (this.retryScanTimer || !this.client) return;
    this.retryScanTimer = setTimeout(() => {
      this.retryScanTimer = undefined;
      void this.safeScan().catch((retryError) => {
        console.error("[看板] 扫描后台重试异常:", (retryError as Error).message);
      });
    }, SCAN_RETRY_DELAY_MS);
  }

  private async scanClient(
    client: BitableRecordClient,
    preserveSnapshots: boolean,
  ): Promise<{
    recordIndex: Map<string, string>;
    seenRecords: Map<string, SeenBoardRecord>;
    snapshots: Map<string, BoardSnapshot>;
    emptyRecordIds: string[];
  }> {
    const records = await client.list();
    const recordIndex = new Map<string, string>();
    const seenRecords = new Map<string, SeenBoardRecord>();
    const snapshots = new Map<string, BoardSnapshot>();
    const emptyRecordIds: string[] = [];
    for (const record of records) {
      if (record.taskId) {
        recordIndex.set(record.taskId, record.recordId);
        if (isBoardState(record.state)) {
          const stored: BoardSnapshot = {
            taskId: record.taskId,
            title: record.title,
            bot: record.bot,
            owner: record.owner,
            state: record.state,
            round: record.round,
            artifact: record.artifact,
            tokens: record.tokens,
            durationMs: record.durationMs,
            chatId: record.chatId,
          };
          const pending = preserveSnapshots ? this.snapshots.get(record.taskId) : undefined;
          // stored（表格副本）与 pending（内存累计）是同一份数据的两个表示，
          // 合并时 accumulateStats 必须为 false，否则 Token/耗时每次重扫翻倍。
          const merged = pending
            ? mergeBoardSnapshots(stored, pending, false)
            : stored;
          snapshots.set(record.taskId, merged);
        }
      } else if (
        record.recordId &&
        !record.title &&
        !record.bot &&
        !record.state
      ) {
        // 飞书新建多维表格会预置空白行；收集为可复用落点，让正向同步
        // 新建任务记录时优先填进空行，而不是一直追加到表格末尾。
        emptyRecordIds.push(record.recordId);
      }
      seenRecords.set(record.recordId, {
        state: record.state,
        triggered: record.state !== BOARD_STATES.TODO,
      });
    }
    return { recordIndex, seenRecords, snapshots, emptyRecordIds };
  }

  private applyScan(scanned: {
    recordIndex: Map<string, string>;
    seenRecords: Map<string, SeenBoardRecord>;
    snapshots: Map<string, BoardSnapshot>;
    emptyRecordIds: string[];
  }): void {
    this.recordIndex.clear();
    for (const [taskId, recordId] of scanned.recordIndex) {
      this.recordIndex.set(taskId, recordId);
    }
    this.emptyRecordIds = [...scanned.emptyRecordIds];
    this.seenRecords.clear();
    for (const [recordId, seen] of scanned.seenRecords) {
      this.seenRecords.set(recordId, seen);
    }
    for (const [taskId, snapshot] of scanned.snapshots) {
      this.snapshots.set(taskId, snapshot);
      if (this.pending.has(taskId)) this.pending.set(taskId, snapshot);
    }
    if (process.env.DEBUG_BOARD) {
      console.log(
        `[看板] 全量扫描完成：${scanned.seenRecords.size} 条记录，${this.recordIndex.size} 个任务已关联`,
      );
    }
  }

  private registerEventListeners(): void {
    this.ctx.on("task/started", (payload: TaskStartedPayload) => {
      if (!payload.taskId || !(this.currentConfig.sync ?? true)) return;
      this.enqueueSnapshot({
        taskId: payload.taskId,
        title: fitTitle(payload.requestedPrompt ?? ""),
        bot: payload.botConfig.id,
        owner: payload.senderOpenId ?? "",
        state: stateForEvent({
          kind: "started",
          qaStage: payload.collaboration?.qaReview?.stage,
        }),
        round: payload.collaboration?.round,
        chatId: payload.session.chatId,
      });
    });
    this.ctx.on(
      "task/tool-calls",
      async (
        payload: TaskToolCallsPayload,
      ): Promise<TaskToolCallsOutcome | undefined> => {
        if (!payload.taskId || !(this.currentConfig.sync ?? true)) return undefined;
        this.enqueueSnapshot({
          taskId: payload.taskId,
          title: fitTitle(payload.requestedPrompt),
          bot: payload.botConfig.id,
          owner: payload.senderOpenId ?? "",
          state: stateForEvent({
            kind: "tool-calls",
            toolCalls: payload.result.toolCalls,
          }),
          round: payload.collaboration?.round,
          artifact: extractArtifactUrls(payload.result.toolCalls),
          chatId: payload.session.chatId,
        });
        return undefined;
      },
    );
    this.ctx.on("task/result", (payload: TaskResultPayload) => {
      if (!payload.taskId || !(this.currentConfig.sync ?? true)) return;
      this.enqueueSnapshot({
        taskId: payload.taskId,
        title: fitTitle(payload.requestedPrompt),
        bot: payload.botConfig.id,
        owner: payload.senderOpenId ?? "",
        state: stateForEvent({
          kind: "result",
          awaitingQa:
            !payload.suppressHandoff &&
            (Boolean(payload.collaboration?.qaReview) ||
              (!payload.collaboration && Boolean(payload.botConfig.reviewBy))),
        }),
        round: payload.collaboration?.round,
        artifact: extractArtifactUrls(payload.toolCalls),
        tokens: payload.stats?.totalTokens,
        durationMs: payload.durationMs,
        chatId: payload.session.chatId,
      }, this.statsKey(payload));
    });
    this.ctx.on("task/failed", (payload: TaskResultPayload) => {
      if (!payload.taskId || !(this.currentConfig.sync ?? true)) return;
      this.enqueueSnapshot({
        taskId: payload.taskId,
        title: fitTitle(payload.requestedPrompt),
        bot: payload.botConfig.id,
        owner: payload.senderOpenId ?? "",
        state: stateForEvent({ kind: "failed" }),
        round: payload.collaboration?.round,
        tokens: payload.stats?.totalTokens,
        durationMs: payload.durationMs,
        chatId: payload.session.chatId,
      }, this.statsKey(payload));
    });
    this.ctx.on("task/cancelled", (payload: TaskResultPayload) => {
      if (!payload.taskId || !(this.currentConfig.sync ?? true)) return;
      this.enqueueSnapshot({
        taskId: payload.taskId,
        title: fitTitle(payload.requestedPrompt),
        bot: payload.botConfig.id,
        owner: payload.senderOpenId ?? "",
        state: stateForEvent({ kind: "cancelled" }),
        round: payload.collaboration?.round,
        tokens: payload.stats?.totalTokens,
        durationMs: payload.durationMs,
        chatId: payload.session.chatId,
      }, this.statsKey(payload));
    });
    this.ctx.on(
      "product-spec/approved",
      (payload: ProductSpecApprovedPayload) => {
        if (!(this.currentConfig.sync ?? true)) return;
        const { flow } = payload;
        this.enqueueSnapshot({
          taskId: flow.taskId,
          title: fitTitle(flow.request.title),
          bot: flow.botId,
          owner: flow.ownerOpenId,
          state: stateForEvent({
            kind: "spec-approved",
            continues: Boolean(flow.collaboration),
          }),
          chatId: "",
        });
      },
    );
    this.ctx.on("qa/result", (payload: QAResultPayload) => {
      if (!payload.taskId || !(this.currentConfig.sync ?? true)) return;
      this.enqueueSnapshot({
        taskId: payload.taskId,
        title: fitTitle(payload.requestedPrompt),
        bot: payload.botConfig.id,
        owner: payload.senderOpenId ?? "",
        state: stateForEvent({
          kind: "qa-result",
          verdict: payload.qaResult.verdict,
        }),
        round: payload.collaboration?.round,
        artifact: extractArtifactUrls(payload.toolCalls),
        tokens: payload.stats?.totalTokens,
        durationMs: payload.durationMs,
        chatId: payload.session.chatId,
      }, this.statsKey(payload));
    });
  }

  private statsKey(payload: TaskResultPayload): string {
    return payload.traceId ?? [
      payload.session.id,
      payload.botConfig.id,
      payload.collaboration?.dispatchId ?? "direct",
      payload.durationMs ?? "unknown",
      payload.stats?.totalTokens ?? "unknown",
    ].join(":");
  }

  enqueueSnapshot(snapshot: BoardSnapshot, statsKey?: string): void {
    if (!(this.currentConfig.sync ?? true) || !this.client) return;
    let accumulateStats = true;
    if (statsKey) {
      const counted = this.countedRuns.get(snapshot.taskId) ?? new Set<string>();
      accumulateStats = !counted.has(statsKey);
      counted.add(statsKey);
      if (counted.size > MAX_COUNTED_RUNS_PER_TASK) {
        const oldest = counted.values().next().value;
        if (oldest !== undefined) counted.delete(oldest);
      }
      this.countedRuns.set(snapshot.taskId, counted);
    }
    const merged = mergeBoardSnapshots(
      this.snapshots.get(snapshot.taskId),
      snapshot,
      accumulateStats,
    );
    this.snapshots.set(snapshot.taskId, merged);
    this.pending.set(snapshot.taskId, merged);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (
      !this.scanReady ||
      this.pending.size === 0 ||
      this.flushTimer ||
      this.flushing
    ) {
      return;
    }
    const batchDelay = this.currentConfig.batchDelayMs ?? 1_500;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch((error) => {
        console.error("[看板] 批量同步失败:", (error as Error).message);
      });
    }, batchDelay);
  }

  async flushNow(): Promise<void> {
    if (!this.scanReady || this.flushing || !this.client) return;
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.pending.size === 0 || !this.client) return;
    const operation = this.flushInternal();
    this.flushPromise = operation;
    try {
      await operation;
    } finally {
      if (this.flushPromise === operation) this.flushPromise = undefined;
    }
  }

  private async flushInternal(): Promise<void> {
    this.flushing = true;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    try {
      for (let i = 0; i < batch.length; i++) {
        const [taskId, snapshot] = batch[i];
        const createToken = randomUUID();
        // 每个未关联记录的任务取一次空行落点；重试不重复消耗空行池。
        const reuseRecordId = this.recordIndex.get(taskId)
          ? undefined
          : this.emptyRecordIds.shift();
        // 返回 true 表示本任务因表失效放弃：剩余快照也全部保留，终止批次，
        // 避免对已知失效的表继续发出 N×4 次无效请求。
        const gaveUpOnMissingBoard = await this.withRetry(async () => {
          if (!this.client) return;
          const fields = buildBoardFields(snapshot, this.currentFields);
          const recordId = this.recordIndex.get(taskId);
          if (recordId) {
            await this.client.update(recordId, fields);
            return;
          }
          if (reuseRecordId) {
            try {
              // 优先把新任务记录填进表格里已有的空行，而不是追加到末尾。
              await this.client.update(reuseRecordId, fields);
              this.recordIndex.set(taskId, reuseRecordId);
              return;
            } catch {
              // 该空行可能已被删除或占用：不再追回，回退到追加新行。
            }
          }
          const created = await this.client.create(fields, createToken);
          this.recordIndex.set(taskId, created.recordId);
        }, taskId, snapshot);
        if (gaveUpOnMissingBoard) {
          for (let j = i + 1; j < batch.length; j++) {
            const [remainingTaskId, remainingSnapshot] = batch[j];
            const newer = this.pending.get(remainingTaskId);
            this.pending.set(remainingTaskId, newer ?? remainingSnapshot);
          }
          break;
        }
      }
    } finally {
      this.flushing = false;
      this.scheduleFlush();
    }
  }

  /**
   * 单条记录写入重试；返回 true 表示因表失效重试耗尽而放弃（调用方应终止整批）。
   * 表失效时把快照保留回 pending，等扫描恢复后统一冲刷，避免丢事件。
   */
  private async withRetry(
    write: () => Promise<void>,
    taskId: string,
    snapshot?: BoardSnapshot,
  ): Promise<boolean> {
    const maxRetries = this.currentConfig.maxRetries ?? 3;
    let attempt = 0;
    while (true) {
      try {
        await write();
        return false;
      } catch (error) {
        attempt += 1;
        if (isMissingBoardError(error)) {
          // 看板失效：暂停后续冲刷与轮询（scanReady=false），等待扫描恢复。
          this.degraded = true;
          this.scanReady = false;
          this.scheduleScanRetry();
          await this.notifyDegraded(error);
        }
        if (attempt > maxRetries) {
          if (isMissingBoardError(error) && snapshot) {
            const newer = this.pending.get(taskId);
            this.pending.set(taskId, newer ?? snapshot);
          }
          console.error(
            `[看板] 任务 ${taskId} 同步失败（已重试 ${attempt - 1} 次）:`,
            (error as Error).message,
          );
          return isMissingBoardError(error);
        }
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  async pullOnce(): Promise<void> {
    // scanReady=false（看板失效/扫描未就绪）时暂停反向拉起，避免持续请求失效 API。
    if (!this.scanReady || this.pullPromise) return this.pullPromise;
    const operation = this.pullInternal();
    this.pullPromise = operation;
    try {
      await operation;
    } finally {
      if (this.pullPromise === operation) this.pullPromise = undefined;
    }
  }

  private async pullInternal(): Promise<void> {
    if (this.pulling || !this.client) return;
    this.pulling = true;
    try {
      const records = await this.client.list();
      const { triggers, nextSeen } = detectReverseTriggers(
        records,
        this.seenRecords,
      );
      this.seenRecords.clear();
      for (const [recordId, seen] of nextSeen) {
        this.seenRecords.set(recordId, seen);
      }
      for (const trigger of triggers) {
        const launched = await this.launchReverseTask(trigger);
        if (!launched) {
          const seen = this.seenRecords.get(trigger.recordId);
          if (seen) this.seenRecords.set(trigger.recordId, { ...seen, triggered: false });
        }
      }
      // 轮询成功说明表格可访问；临时网络错误触发的降级在这里恢复，
      // 并重启被暂停的冲刷（若期间有快照积压）。
      this.degraded = false;
      this.degradedNotified = false;
      if (!this.scanReady) {
        this.scanReady = true;
        this.scheduleFlush();
      }
    } catch (error) {
      this.degraded = true;
      if (isMissingBoardError(error)) {
        // 看板失效：暂停后续轮询与冲刷，等待扫描恢复。
        this.scanReady = false;
        this.scheduleScanRetry();
        await this.notifyDegraded(error);
      }
      throw error;
    } finally {
      this.pulling = false;
    }
  }

  /**
   * 看板表被删除或失效时向可确定的任务群发送一次提醒；没有群聊上下文时仅记录日志，
   * 避免把告警发到任意群。通知去重直到下一次扫描成功，防止轮询期间刷屏。
   */
  private async notifyDegraded(error: unknown): Promise<void> {
    if (this.degradedNotified) return;
    this.degradedNotified = true;
    const chatId = this.currentConfig.fallbackChatId?.trim() ||
      [...this.snapshots.values()].find((snapshot) => snapshot.chatId)?.chatId;
    if (!chatId) {
      console.error("[看板] 看板已失效，但没有可用群聊ID发送提醒");
      return;
    }
    const botId =
      this.currentStorage?.botId ||
      this.currentConfig.botId ||
      this.ctx.config.teamLeaderId ||
      this.ctx.config.bots[0]?.id;
    const runtime = this.ctx.lark.bot(botId);
    if (!runtime) {
      console.error(`[看板] 看板已失效，告警 bot 不可用: ${botId}`);
      return;
    }
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    try {
      await runtime.bot.send(
        chatId,
        `⚠️ 任务看板「${this.currentStorage?.name || "Agent OS 任务看板"}」已失效，事件同步与反向拉起暂时暂停。错误：${detail}。请检查多维表格是否被删除，并使用 /board init --force 重新挂载。`,
      );
    } catch (sendError) {
      console.error("[看板] 发送失效提醒失败:", (sendError as Error).message);
    }
  }

  private async launchReverseTask(trigger: {
    recordId: string;
    title: string;
    bot: string;
    owner: string;
    chatId: string;
    taskId?: string;
  }): Promise<boolean> {
    if (!this.client) return false;
    const botConfig = this.ctx.config.bot(trigger.bot);
    const runtime = this.ctx.lark.bot(trigger.bot);
    if (!botConfig || !runtime) {
      console.error(`[看板] 负责人 Bot 未注册: ${trigger.bot}`);
      return false;
    }
    const chatId = trigger.chatId || this.currentConfig.fallbackChatId || "";
    if (!chatId) {
      console.error(
        `[看板] 记录 ${trigger.recordId} 缺少群聊ID且未配置 fallbackChatId，跳过`,
      );
      return false;
    }
    const taskId = trigger.taskId || reverseTaskId(trigger.recordId);
    const address: IncomingMessage = {
      messageId: `bitable-${trigger.recordId}`,
      chatId,
      threadId: `bitable:${trigger.recordId}`,
      rootId: "",
      chatType: "group",
      messageType: "text",
      text: trigger.title,
      rawContent: "",
      senderType: "user",
      senderOpenId: trigger.owner || "",
      mentions: [],
    };
    const resolved = await this.ctx.sessions.manager.resolve(
      address,
      botConfig.defaultCliId,
      botConfig.id,
      botConfig.workspaceDir,
      botConfig.accessMode ?? "headless",
    );
    const session = resolved.session;
    if (session.status === "active" || session.status === "closed") {
      console.log(`[看板] 记录 ${trigger.recordId} 的会话处于 ${session.status}，跳过`);
      return false;
    }
    if (!trigger.taskId) {
      try {
        // 回写任务ID与执行群聊（fallback 生效时记录原本为空），
        // 保证表格记录自洽，重启后反向拉起与事件同步仍能命中。
        const backfill: Record<string, BitableFieldValue> = {
          [this.currentFields.taskId]: taskId,
        };
        if (chatId) backfill[this.currentFields.chatId] = chatId;
        await this.client.update(trigger.recordId, backfill);
      } catch (error) {
        console.error(
          `[看板] 记录 ${trigger.recordId} 回写任务ID失败，本轮不启动:`,
          (error as Error).message,
        );
        return false;
      }
    }
    this.recordIndex.set(taskId, trigger.recordId);
    let messageId: string | undefined;
    try {
      messageId = await runtime.bot.send(
        chatId,
        `📋 看板任务「${trigger.title}」已收到，开始处理…`,
      );
    } catch (error) {
      console.error(
        `[看板] 向群 ${chatId} 发送开工消息失败:`,
        (error as Error).message,
      );
      return false;
    }
    if (!messageId) {
      console.error(`[看板] 向群 ${chatId} 发送开工消息未返回 message_id`);
      return false;
    }
    const started = await this.ctx.tasks.startTask({
      bot: runtime.bot,
      botConfig,
      session,
      hasThread: false,
      replyToMessageId: messageId,
      senderOpenId: trigger.owner || "bitable",
      taskId,
      isDirect: false,
      requestedPrompt: trigger.title,
      isCompacting: false,
      resources: [],
    });
    if (!started) {
      console.error(`[看板] 记录 ${trigger.recordId} 的任务未能进入执行链`);
      return false;
    }
    console.log(
      `[看板] 已反向拉起任务 taskId=${taskId} bot=${trigger.bot} chat=${chatId} record=${trigger.recordId}`,
    );
    return true;
  }
}

/** 兼容旧代码引用的 BoardService 别名。 */
export { BitableBoardService as BoardService };

export const name = "bitable-board";
export const inject = ["config", "lark", "sessions", "tasks"];

export async function apply(ctx: Context, rawConfig: Config = {}) {
  const config = ConfigSchema.parse(rawConfig) as Config;
  const storagePath = config.storagePath || DEFAULT_BOARD_STORAGE_PATH;
  const service = new BitableBoardService(ctx, config);

  const configuredAppToken = config.appToken?.trim();
  const configuredTableId = config.tableId?.trim();
  const hasPartialConfig =
    Boolean(configuredAppToken) !== Boolean(configuredTableId);

  let targetAppToken = configuredAppToken;
  let targetTableId = configuredTableId;
  let targetUrl = config.url?.trim();
  let targetName = config.name?.trim();
  let targetBotId = config.botId;
  let targetFallbackChatId = config.fallbackChatId;
  let targetCreatedAt: string | undefined;
  let targetUpdatedAt: string | undefined;

  // 仅当 appToken 与 tableId 同时缺失时才读取本地缓存自愈；任一缺失视为
  // 配置错误，避免缓存静默覆盖用户显式配置的另一半。
  if (!configuredAppToken && !configuredTableId) {
    const saved = loadBoardStorage(storagePath);
    if (saved) {
      targetAppToken = saved.appToken;
      targetTableId = saved.tableId;
      targetUrl = saved.url;
      targetName = saved.name;
      targetBotId = saved.botId;
      targetFallbackChatId = saved.fallbackChatId;
      // 沿用缓存时间，保证 /board link 重启前后输出一致。
      targetCreatedAt = saved.createdAt;
      targetUpdatedAt = saved.updatedAt;
      console.log(`[看板] 从本地存储恢复配置: appToken=${targetAppToken}, tableId=${targetTableId}`);
    }
  } else if (hasPartialConfig) {
    console.error(
      "[看板] 静态配置 appToken 与 tableId 必须同时提供或同时留空，已跳过自动挂载",
    );
  }

  if (targetAppToken && targetTableId) {
    try {
      await service.mount({
        appToken: targetAppToken,
        tableId: targetTableId,
        url: targetUrl,
        name: targetName,
        botId: targetBotId,
        fallbackChatId: targetFallbackChatId,
        createdAt: targetCreatedAt,
        updatedAt: targetUpdatedAt,
        fields: config.fields,
        saveToStorage: false,
      });
    } catch (error) {
      console.error("[看板] 自动挂载失败:", (error as Error).message);
    }
  } else {
    console.log("[看板] 未配置 appToken/tableId，等待 /board init 指令初始化挂载");
  }

  ctx.effect(() => () => service.stop());
}
