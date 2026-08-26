/**
 * bitable-board 看板插件：把 Agent OS 任务生命周期实时同步到飞书多维表格，
 * 并轮询表格记录反向拉起新任务。同步走内存队列 + 节流合并 + 失败重试，
 * API 异常绝不阻塞主任务与卡片响应；反向拉起通过轮询检测“待处理”记录，
 * 复用 ctx.tasks.startTask 启动完整执行链路。
 */
import type { Context } from "cordis";
import * as Lark from "@larksuiteoapi/node-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { IncomingMessage } from "../im/lark.js";
import {
  DEFAULT_BOARD_FIELDS,
  type BoardFields,
  type BoardRecord,
  type BoardSnapshot,
  type BitableFieldValue,
  type SeenBoardRecord,
  buildBoardFields,
  detectReverseTriggers,
  extractArtifactUrls,
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

/** 看板插件配置；appToken/tableId 必填，其余均可选。 */
export interface Config {
  /** 多维表格 app_token，必填。 */
  appToken: string;
  /** 多维表格数据表 ID，必填。 */
  tableId: string;
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
}

const ConfigSchema = z.object({
  appToken: z.string().trim().min(1),
  tableId: z.string().trim().min(1),
  botId: z.string().trim().min(1).optional(),
  fields: z.record(z.string(), z.string()).optional(),
  sync: z.boolean().optional(),
  pull: z.boolean().optional(),
  pollIntervalMs: z.number().int().min(1_000).optional(),
  batchDelayMs: z.number().int().min(100).optional(),
  fallbackChatId: z.string().trim().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
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

/**
 * 用飞书 SDK 的 appTableRecord 实现看板读写。请求经同一串行链调度，既避免
 * 并发读写越过 10 QPS，也保证某次请求失败后不会阻断后续请求。
 */
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
        if (response.code && response.code !== 0) {
          throw new Error(response.msg || "查询多维表格记录失败");
        }
        for (const item of response.data?.items ?? []) {
          records.push(parseBoardRecord(item, fields));
        }
        pageToken = response.data?.has_more ? response.data.page_token : undefined;
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
      if (response.code && response.code !== 0) {
        throw new Error(response.msg || "新增多维表格记录失败");
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
      if (response.code && response.code !== 0) {
        throw new Error(response.msg || "更新多维表格记录失败");
      }
    },
  };
}

/** 看板任务标题的合理长度上限，避免超长指令撑爆文本字段。 */
const MAX_TITLE_LENGTH = 300;

function fitTitle(title: string): string {
  const normalized = title.trim();
  return normalized.length <= MAX_TITLE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

/** 短睡辅助，供同步写重试退避使用。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 扫描失败的首次重试延迟；网络/权限恢复后自动补建索引，不阻塞启动。 */
const SCAN_RETRY_DELAY_MS = 15_000;

/**
 * 看板同步服务：维护 taskId→recordId 索引、节流合并队列与反向拉起轮询。
 * 构造后调用 init() 完成首次全量扫描并注册事件监听；扫描失败会降级并在
 * 后台重试，绝不阻塞 Agent OS 启动。
 */
export class BoardService {
  /** taskId → 已关联的看板记录 ID；create 后立即写入，重启后由全量扫描重建。 */
  readonly recordIndex = new Map<string, string>();
  /** 反向拉起轮询的状态快照；仅存内存，重启后旧记录不会自动触发。 */
  readonly seenRecords = new Map<string, SeenBoardRecord>();
  /** 节流窗口内待写入的任务快照；同一任务只保留最新一条。 */
  private readonly pending = new Map<string, BoardSnapshot>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private pollTimer?: ReturnType<typeof setInterval>;
  private pulling = false;
  private retryScanTimer?: ReturnType<typeof setTimeout>;
  /** 首次全量扫描成功后才允许写入，避免空索引把已有任务重复创建。 */
  private scanReady = false;
  private readonly resolvedConfig: Required<
    Pick<Config, "sync" | "pull" | "pollIntervalMs" | "batchDelayMs" | "maxRetries">
  >;

  constructor(
    private readonly ctx: Context,
    private readonly client: BitableRecordClient,
    private readonly config: Config,
    private readonly fields: BoardFields,
  ) {
    this.resolvedConfig = {
      sync: config.sync ?? true,
      pull: config.pull ?? true,
      pollIntervalMs: config.pollIntervalMs ?? 30_000,
      batchDelayMs: config.batchDelayMs ?? 1_500,
      maxRetries: config.maxRetries ?? 3,
    };
  }

  /** 全量扫描建立索引与 seen 快照，并注册事件监听和轮询。 */
  async init(): Promise<void> {
    await this.safeScan();
    if (this.resolvedConfig.sync) this.registerEventListeners();
    if (this.resolvedConfig.pull) {
      this.pollTimer = setInterval(() => {
        void this.pullOnce().catch((error) => {
          console.error("[看板] 反向拉起轮询失败:", (error as Error).message);
        });
      }, this.resolvedConfig.pollIntervalMs);
    }
  }

  /** 停止节流定时器、扫描重试与轮询；事件监听由 Cordis 在卸载时自动清理。 */
  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryScanTimer) clearTimeout(this.retryScanTimer);
    this.flushTimer = undefined;
    this.pollTimer = undefined;
    this.retryScanTimer = undefined;
  }

  /**
   * 容错扫描：Bitable 网络/权限/频控错误只记录日志并在后台延迟重试，
   * 不抛出、不阻塞插件装配。扫描未完成前事件快照只保存在内存，不执行写入；
   * 一旦重试成功即重建 taskId→recordId 索引并冲刷待写快照。
   */
  private async safeScan(): Promise<void> {
    try {
      await this.scan();
      this.scanReady = true;
      this.scheduleFlush();
    } catch (error) {
      console.error(
        "[看板] 全量扫描失败，稍后后台重试:",
        (error as Error).message,
      );
      this.retryScanTimer = setTimeout(() => {
        this.retryScanTimer = undefined;
        void this.safeScan().catch((retryError) => {
          console.error("[看板] 扫描后台重试异常:", (retryError as Error).message);
        });
      }, SCAN_RETRY_DELAY_MS);
    }
  }

  /** 全量扫描看板记录：重建 taskId→recordId 索引，并标记所有记录为已见。 */
  private async scan(): Promise<void> {
    const records = await this.client.list();
    for (const record of records) {
      if (record.taskId) this.recordIndex.set(record.taskId, record.recordId);
      this.seenRecords.set(record.recordId, {
        state: record.state,
        // 重启前已存在的记录不自动触发，避免把历史待处理记录全部拉起。
        triggered: true,
      });
    }
    console.log(
      `[看板] 全量扫描完成：${records.length} 条记录，${this.recordIndex.size} 个任务已关联`,
    );
  }

  private registerEventListeners(): void {
    this.ctx.on("task/started", (payload: TaskStartedPayload) => {
      if (!payload.taskId) return;
      this.enqueueSnapshot({
        taskId: payload.taskId,
        title: fitTitle(payload.requestedPrompt ?? ""),
        bot: payload.botConfig.id,
        owner: payload.senderOpenId ?? "",
        // Reviewer 审查轮从开始就展示“QA验收中”，Developer 返工仍是“开发中”。
        state: stateForEvent({
          kind: "started",
          qaStage: payload.collaboration?.qaReview?.stage,
        }),
      });
    });
    this.ctx.on(
      "task/tool-calls",
      async (
        payload: TaskToolCallsPayload,
      ): Promise<TaskToolCallsOutcome | undefined> => {
        if (!payload.taskId) return undefined;
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
      if (!payload.taskId) return;
      this.enqueueSnapshot({
        taskId: payload.taskId,
        title: fitTitle(payload.requestedPrompt),
        bot: payload.botConfig.id,
        owner: payload.senderOpenId ?? "",
        state: stateForEvent({
          kind: "result",
          // 与 QA Gate 的入口条件保持一致：suppressHandoff 禁止任何交接（含 QA），
          // 普通协作任务不会因目标 Bot 配置了 reviewBy 而自动进入 QA，只有顶层
          // 交付或既有 QA 链路需要等待结论。漏掉 suppressHandoff 会把任务永久
          // 卡在“QA验收中”而等不到 qa/result。
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
      });
    });
    this.ctx.on("task/failed", (payload: TaskResultPayload) => {
      if (!payload.taskId) return;
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
      });
    });
    this.ctx.on(
      "product-spec/approved",
      (payload: ProductSpecApprovedPayload) => {
        const { flow } = payload;
        this.enqueueSnapshot({
          taskId: flow.taskId,
          title: fitTitle(flow.request.title),
          bot: flow.botId,
          owner: flow.ownerOpenId,
          state: stateForEvent({ kind: "spec-approved" }),
          chatId: "",
        });
      },
    );
    this.ctx.on("qa/result", (payload: QAResultPayload) => {
      if (!payload.taskId) return;
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
      });
    });
  }

  /**
   * 入队一条同步快照：同一 taskId 在节流窗口内合并，只保留最新状态；
   * 首次扫描完成后按节流窗口启动 flush，扫描失败期间仅保留内存快照。
   */
  enqueueSnapshot(snapshot: BoardSnapshot): void {
    if (!this.resolvedConfig.sync) return;
    this.pending.set(snapshot.taskId, snapshot);
    this.scheduleFlush();
  }

  /** 索引就绪后调度一次冲刷；扫描失败期间只合并内存快照，不触发创建。 */
  private scheduleFlush(): void {
    if (
      !this.scanReady ||
      this.pending.size === 0 ||
      this.flushTimer ||
      this.flushing
    ) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch((error) => {
        console.error("[看板] 批量同步失败:", (error as Error).message);
      });
    }, this.resolvedConfig.batchDelayMs);
  }

  /** 立即冲刷队列（测试与反向拉起回写任务ID后使用）；失败不抛出。 */
  async flushNow(): Promise<void> {
    if (!this.scanReady || this.flushing) return;
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    this.flushing = true;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    try {
      for (const [taskId, snapshot] of batch) {
        // 一次逻辑创建的所有重试必须复用同一 client_token。若服务端已成功创建但
        // 响应丢失，飞书会返回同一结果而不是重复建行。
        const createToken = randomUUID();
        await this.withRetry(async () => {
          const recordId = this.recordIndex.get(taskId);
          if (recordId) {
            await this.client.update(
              recordId,
              buildBoardFields(snapshot, this.fields),
            );
          } else {
            const created = await this.client.create(
              buildBoardFields(snapshot, this.fields),
              createToken,
            );
            this.recordIndex.set(taskId, created.recordId);
          }
        }, taskId);
      }
    } finally {
      this.flushing = false;
      // flush 期间新入队的事件因 flushing 标志不会启动定时器，这里补一次调度，
      // 否则这批快照会一直滞留到下一次事件才被写入。
      this.scheduleFlush();
    }
  }

  /** 单条同步写重试；耗尽重试后丢弃并记录错误，绝不向调用方抛异常。 */
  private async withRetry(
    write: () => Promise<void>,
    taskId: string,
  ): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await write();
        return;
      } catch (error) {
        attempt += 1;
        if (attempt > this.resolvedConfig.maxRetries) {
          console.error(
            `[看板] 任务 ${taskId} 同步失败（已重试 ${attempt - 1} 次）:`,
            (error as Error).message,
          );
          return;
        }
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  /** 轮询一次看板：检测待处理记录并反向拉起任务。 */
  async pullOnce(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    try {
      const records = await this.client.list();
      const { triggers, nextSeen } = detectReverseTriggers(
        records,
        this.seenRecords,
      );
      // 先整体更新 seen，再逐个启动；启动失败的记录把 triggered 回滚以允许下轮重试。
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
    } finally {
      this.pulling = false;
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
    const botConfig = this.ctx.config.bot(trigger.bot);
    const runtime = this.ctx.lark.bot(trigger.bot);
    if (!botConfig || !runtime) {
      console.error(`[看板] 负责人 Bot 未注册: ${trigger.bot}`);
      return false;
    }
    const chatId = trigger.chatId || this.config.fallbackChatId || "";
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
    // 任务ID必须先写回记录；记录已预填任务ID（人工/历史）时跳过回写。
    // 无论任务ID是预填还是本轮生成，都必须建立 taskId→recordId 索引——
    // 否则该记录若在进程启动扫描之后新增/修改，后续 task/started 事件会在
    // 索引中查不到而调用 create 重复建行。
    if (!trigger.taskId) {
      try {
        await this.client.update(
          trigger.recordId,
          { [this.fields.taskId]: taskId },
        );
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
    this.ctx.tasks.startTask({
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
    console.log(
      `[看板] 已反向拉起任务 taskId=${taskId} bot=${trigger.bot} chat=${chatId} record=${trigger.recordId}`,
    );
    return true;
  }
}

export const name = "bitable-board";
export const inject = ["config", "lark", "sessions", "tasks"];

export async function apply(ctx: Context, rawConfig: Config) {
  const config = ConfigSchema.parse(rawConfig) as Config;
  const fields: BoardFields = {
    ...DEFAULT_BOARD_FIELDS,
    ...(config.fields ?? {}),
  };
  const botId = config.botId ?? ctx.config.teamLeaderId;
  const runtime = ctx.lark.bot(botId);
  if (!runtime) {
    throw new Error(`看板插件找不到用于调用 Bitable 的 bot: ${botId}`);
  }
  const client = createBitableRecordClient(
    runtime.bot.client,
    config.appToken,
    config.tableId,
    fields,
  );
  const service = new BoardService(ctx, client, config, fields);
  await service.init();
  ctx.effect(() => () => service.stop());
  console.log(
    `[看板] 已挂载 appToken=${config.appToken} tableId=${config.tableId} bot=${botId}`,
  );
}
