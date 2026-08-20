/**
 * ACP 常驻进程：为任意标准 ACP 接入引擎维护单个常驻 ACP server 子进程与
 * 持久 ACP 连接。多个任务在同一进程上并发执行（通知按 sessionId 路由隔离），
 * 空闲超时自动回收，进程崩溃后下次调用自动重建，Agent OS 退出时显式关闭。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { resolveCliCommand } from "./command-resolver.js";
import { stopProcessTree } from "./process-tree.js";
import type { CliAdapter, CliEvent, CliRunResult, CliRunStats } from "./types.js";

/** 无任务运行超过该时长即回收常驻进程；可在构造时覆盖。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
/** 常驻进程从拉起到底盘完成握手的最大时限，超时按启动失败处理并回收。 */
const INITIALIZE_TIMEOUT_MS = 30 * 1_000;

const TOOL_LABELS: Record<string, string> = {
  read: "读取文件",
  edit: "修改文件",
  delete: "删除文件",
  move: "移动文件",
  search: "搜索代码",
  execute: "运行命令",
  think: "分析任务",
  fetch: "读取网页",
  switch_mode: "切换模式",
  other: "调用工具",
};

/** ACP 失败时携带已经创建或恢复的 session ID，供 runner 包装成 CliRunError 后持久化。 */
class AcpRunError extends Error {
  constructor(
    message: string,
    readonly sessionId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AcpRunError";
  }
}

/** 在常驻 ACP 进程上执行一轮所需的最小参数；adapter 由 daemon 构造时持有。 */
export interface AcpTurnOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** 可选执行时限；未传入时不自动超时。 */
  timeoutMs?: number;
  onEvent?: (event: CliEvent) => void;
}

/** 单个进行中 turn 的通知收集状态；daemon 按 sessionId 路由到此。 */
interface TurnCollector {
  /** 绑定本轮 onEvent 的发射器；观察者异常按轮记录并在结束时抛出。 */
  emit: (event: CliEvent) => void;
  answer: string;
  stats?: CliRunStats;
  startedTools: Set<string>;
  completedTools: Set<string>;
}

function statsFromUsage(usage: acp.Usage | null | undefined): CliRunStats | undefined {
  if (!usage) return undefined;
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedReadTokens !== undefined && usage.cachedReadTokens !== null
      ? { cacheReadTokens: usage.cachedReadTokens }
      : {}),
    ...(usage.cachedWriteTokens !== undefined && usage.cachedWriteTokens !== null
      ? { cacheCreationTokens: usage.cachedWriteTokens }
      : {}),
  };
}

function permissionResponse(
  params: acp.RequestPermissionRequest,
): acp.RequestPermissionResponse {
  // 飞书任务没有同步审批通道；与 dim exec 的 full-access 默认行为一致，
  // 优先选择允许选项，不能安全选择时明确取消本次请求。
  const option =
    params.options.find((item) => item.kind === "allow_always") ??
    params.options.find((item) => item.kind === "allow_once");
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function toolEventLabel(update: acp.ToolCall | acp.ToolCallUpdate): string {
  return TOOL_LABELS[update.kind ?? "other"] ?? "调用工具";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 单个常驻 ACP server 进程。连接一旦建立便持续复用（initialize 只做一次），
 * 每个 turn 在独立 session 上运行；进程异常退出后自动标记失效并在下次调用时重建。
 */
export class AcpDaemon {
  private child: ChildProcess | undefined;
  private connection: acp.ClientConnection | undefined;
  private client: acp.ClientContext | undefined;
  private capabilities: acp.InitializeResponse["agentCapabilities"] | undefined;
  /** 连接已失效（进程退出或被主动关闭），下次 acquire 需要重建。 */
  private broken = false;
  /** 并发 acquire 的去重句柄，避免多个任务同时拉起两个进程。 */
  private acquiring: Promise<acp.ClientContext> | undefined;
  private stderr = "";
  /** 进行中的 turn 收集器；session/update 通知按 sessionId 路由。 */
  private readonly turns = new Map<string, TurnCollector>();
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly adapter: CliAdapter,
    private readonly idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
    /** 常驻进程启动环境；同一 daemon 生命周期内保持不变。 */
    private readonly env?: Record<string, string>,
  ) {}

  /** 当前常驻子进程 PID；未启动或已回收时为 undefined（也用于测试断言）。 */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** 空闲定时器：无活跃 turn 时在 idleTimeoutMs 后回收进程；到点若已有新任务则重排。 */
  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.closed) return;
      if (this.turns.size > 0) {
        this.scheduleIdleClose();
        return;
      }
      void this.close();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** 建立子进程与 ACP 连接并完成握手；仅由 acquire 在无可用连接时调用。 */
  private async spawnConnection(): Promise<acp.ClientContext> {
    const executable = resolveCliCommand(this.adapter.command);
    const child = spawn(
      executable.command,
      [...executable.argsPrefix, ...this.adapter.buildArgs("")],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(this.env ? { env: { ...process.env, ...this.env } } : {}),
      },
    );
    this.child = child;
    this.stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr += chunk.toString();
    });

    // spawn 失败（如命令不存在）时 SDK 请求会挂起；显式关闭连接让挂起请求
    // 立即失败，也避免未监听的 error 事件泄漏到事件循环。
    child.once("error", (error) => {
      if (this.closed) return;
      const stale = this.connection;
      this.markBroken();
      if (stale) stale.close(asError(error));
    });

    const app = acp
      .client({ name: "agent-os" })
      .onRequest(acp.methods.client.session.requestPermission, (context) =>
        permissionResponse(context.params),
      )
      .onNotification(acp.methods.client.session.update, (context) => {
        this.handleSessionUpdate(context.params);
      });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    this.connection = connection;
    this.client = connection.agent;
    this.broken = false;

    // 进程崩溃时显式关闭连接，让所有在途 prompt 请求立刻失败，
    // 不依赖 SDK 对 stdin/stdout EOF 的感知时序。
    child.once("close", () => {
      if (this.closed) return;
      const stale = this.connection;
      this.markBroken();
      if (stale) {
        stale.close(
          new Error(
            this.stderr.trim() || `${this.adapter.displayName} ACP 常驻进程提前退出`,
          ),
        );
      }
    });
    // 连接层关闭（主动 close 或传输断开）同样标记失效。
    void connection.closed.then(
      () => this.markBroken(),
      () => this.markBroken(),
    );

    try {
      const initialized = await Promise.race([
        this.client.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: "agent-os",
            title: "Agent OS",
            version: "0.1.0",
          },
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`${this.adapter.displayName} ACP 启动超时`)),
            INITIALIZE_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
      this.capabilities = initialized.agentCapabilities;
      return this.client;
    } catch (error) {
      // 启动失败（命令缺失/握手超时/协议错误）：关闭连接并结束子进程，
      // 让挂起的 acquire 立即失败，后续调用可重新拉起。
      const stale = this.connection;
      this.markBroken();
      if (stale) stale.close(asError(error));
      await stopProcessTree(child);
      throw error;
    }
  }

  /** 连接失效后清理句柄；在途 turn 由连接关闭触发失败，无需在此主动干预。 */
  private markBroken(): void {
    if (this.broken) return;
    this.broken = true;
    this.connection = undefined;
    this.client = undefined;
    this.child = undefined;
    this.capabilities = undefined;
  }

  /** 获取可用连接；首次调用拉起进程，崩溃后自动重建，并发调用共享同一次启动。 */
  private async acquire(): Promise<acp.ClientContext> {
    if (this.closed) {
      throw new Error(`${this.adapter.displayName} ACP 常驻进程已关闭`);
    }
    if (this.client && !this.broken) return this.client;
    this.acquiring ??= this.spawnConnection().finally(() => {
      this.acquiring = undefined;
    });
    return this.acquiring;
  }

  /** 将 agent 的 session/update 通知按 sessionId 路由到对应 turn 的收集器。 */
  private handleSessionUpdate(params: acp.SessionNotification): void {
    const { sessionId, update } = params;
    const turn = this.turns.get(sessionId);
    if (!turn) return;

    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") turn.answer += update.content.text;
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      turn.emit({ type: "context", usedTokens: update.used });
      turn.stats = {
        ...turn.stats,
        contextUsedTokens: update.used,
        contextWindowTokens: update.size,
      };
      return;
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return;
    }
    if (!turn.startedTools.has(update.toolCallId)) {
      turn.startedTools.add(update.toolCallId);
      turn.emit({
        type: "tool_start",
        toolUseId: update.toolCallId,
        toolName: update.name ?? update.kind ?? "Tool",
        label: toolEventLabel(update),
        ...(update.title ? { detail: update.title } : {}),
      });
    }
    if (
      !turn.completedTools.has(update.toolCallId) &&
      (update.status === "completed" || update.status === "failed")
    ) {
      turn.completedTools.add(update.toolCallId);
      turn.emit({
        type: "tool_end",
        toolUseId: update.toolCallId,
        failed: update.status === "failed",
      });
    }
  }

  /** 在常驻进程上执行一轮 prompt：新建/恢复会话、收集通知、软取消与超时。 */
  async runTurn(options: AcpTurnOptions): Promise<CliRunResult> {
    const { prompt, cwd, sessionId, signal, timeoutMs, onEvent } = options;
    if (signal?.aborted) {
      throw new Error(`${this.adapter.displayName} 执行已取消`);
    }
    this.clearIdleTimer();

    const client = await this.acquire();
    let observedSessionId = sessionId;
    let observerError: Error | undefined;
    const emit = (event: CliEvent) => {
      try {
        onEvent?.(event);
      } catch (error) {
        observerError = asError(error);
      }
    };

    // 恢复已有会话优先用 resume（不重放历史）；server 不支持时退回 load。
    if (observedSessionId) {
      if (this.capabilities?.sessionCapabilities?.resume) {
        await client.request(acp.methods.agent.session.resume, {
          sessionId: observedSessionId,
          cwd,
          mcpServers: [],
        });
      } else if (this.capabilities?.loadSession) {
        await client.request(acp.methods.agent.session.load, {
          sessionId: observedSessionId,
          cwd,
          mcpServers: [],
        });
      } else {
        throw new Error(`${this.adapter.displayName} ACP server 不支持恢复已有会话`);
      }
    } else {
      const created = await client.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      observedSessionId = created.sessionId;
      emit({ type: "session", sessionId: created.sessionId });
    }

    const turn: TurnCollector = { emit, answer: "", startedTools: new Set(), completedTools: new Set() };
    this.turns.set(observedSessionId, turn);
    try {
      const response = await this.racePrompt(client, observedSessionId, prompt, signal, timeoutMs);
      turn.stats = { ...turn.stats, ...statsFromUsage(response.usage) };
      if (observerError) throw observerError;
      if (response.stopReason === "cancelled") {
        throw new Error(`${this.adapter.displayName} 执行已取消`);
      }
      if (!turn.answer) throw new Error(`${this.adapter.displayName} 没有返回最终结果`);
      const result: CliRunResult = {
        answer: turn.answer,
        sessionId: observedSessionId,
        ...(turn.stats ? { stats: turn.stats } : {}),
      };
      emit({ type: "result", answer: result.answer, ...(result.stats ? { stats: result.stats } : {}) });
      return result;
    } catch (error) {
      // 会话已在常驻进程中建立；即使本轮失败也能续接，交给会话层持久化。
      throw observedSessionId
        ? new AcpRunError(asError(error).message, observedSessionId, { cause: error })
        : error;
    } finally {
      this.turns.delete(observedSessionId);
      this.scheduleIdleClose();
    }
  }

  /**
   * 等待 prompt 响应，同时处理超时、取消与连接断开。
   * 常驻进程为多任务共享，取消只能发送 session/cancel 通知做软取消，
   * 不能像一次性进程那样直接杀掉整个进程树。
   */
  private async racePrompt(
    client: acp.ClientContext,
    sessionId: string,
    prompt: string,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<acp.PromptResponse> {
    const promptPromise = client.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });

    let timeout: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => {
        // 软取消：通知 agent 停止本轮，本地立即失败；prompt 响应稍后到达时已被忽略。
        void client.notify(acp.methods.agent.session.cancel, { sessionId });
        reject(new Error(`${this.adapter.displayName} 执行已取消`));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      if (timeoutMs !== undefined) {
        timeout = setTimeout(
          () => reject(new Error(`${this.adapter.displayName} 执行超时`)),
          timeoutMs,
        );
      }
    });

    // 本轮持有的连接意外关闭时，prompt 请求会被 SDK 拒绝；这里兜底提供稳定错误。
    const connectionClosed = new Promise<never>((_, reject) => {
      void this.connection?.closed.then(
        () =>
          reject(
            new Error(
              this.stderr.trim() || `${this.adapter.displayName} ACP 常驻进程已退出`,
            ),
          ),
        (error) => reject(asError(error)),
      );
    });

    try {
      return await Promise.race([promptPromise, interrupted, connectionClosed]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }

  /** 关闭常驻进程并释放连接；幂等，供空闲回收与 Agent OS 退出时调用。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    const connection = this.connection;
    const child = this.child;
    this.markBroken();
    if (connection) {
      connection.close(new Error(`${this.adapter.displayName} ACP 常驻进程已关闭`));
    }
    if (child) {
      await stopProcessTree(child);
    }
  }
}


