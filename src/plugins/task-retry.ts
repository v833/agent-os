/**
 * task-retry 任务重试插件：订阅普通任务失败动作扩展点，为失败卡片贡献一次性重试按钮，
 * 并在飞书回调中完成发起人鉴权、轮次校验、并发防重与原任务重新拉起。
 * 插件只通过 tasks/sessions 服务和类型化事件协作；从 cordis.yml 移除后，任务失败主流程
 * 保持不变，仅不再渲染或响应一键重试。上下文只存内存，重启后旧卡自然失效。
 */
import { randomUUID } from "node:crypto";
import { type Context } from "cordis";
import { z } from "zod";
import type { CardActionResponse } from "../im/lark.js";
import type {
  StartTaskInput,
  TaskClaimedPayload,
  TaskFailureActionCollector,
  TaskFailureActionPayload,
} from "./types.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_CONTEXTS = 500;

export interface Config {
  /** 失败按钮有效期，默认 1 小时。 */
  ttlMs?: number;
  /** 内存中最多保留的失败上下文数，默认 500。 */
  maxContexts?: number;
}

const ConfigSchema = z.object({
  ttlMs: z.number().int().positive().max(24 * 60 * 60 * 1000).default(DEFAULT_TTL_MS),
  maxContexts: z.number().int().positive().max(10_000).default(DEFAULT_MAX_CONTEXTS),
});

type RetryState = "available" | "starting";

interface TaskRetryContext {
  input: StartTaskInput;
  failedRunId: string;
  retryToken: string;
  expiresAt: number;
  state: RetryState;
  timer: ReturnType<typeof setTimeout>;
}

export type RetryTaskOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "forbidden" | "already_running" | "start_failed";
      message?: string;
    };

/** 任务重试插件内部控制器；状态不挂到 ctx，插件间只通过事件和 tasks 服务协作。 */
class TaskRetryController {
  private readonly contexts = new Map<string, TaskRetryContext>();
  private readonly ttlMs: number;
  private readonly maxContexts: number;

  constructor(
    private readonly ctx: Context,
    config: Config = {},
  ) {
    const parsed = ConfigSchema.parse(config);
    this.ttlMs = parsed.ttlMs;
    this.maxContexts = parsed.maxContexts;
  }

  /** 插件卸载时释放全部定时器和任务输入引用。 */
  stop(): void {
    for (const context of this.contexts.values()) clearTimeout(context.timer);
    this.contexts.clear();
  }

  /** 记录最新失败轮次，并向失败卡片贡献通用回调按钮。 */
  registerFailureAction(
    collector: TaskFailureActionCollector,
    payload: TaskFailureActionPayload,
  ): void {
    this.pruneExpired();
    this.deleteContext(payload.sessionId);
    while (this.contexts.size >= this.maxContexts) {
      const oldestSessionId = this.contexts.keys().next().value as string | undefined;
      if (!oldestSessionId) break;
      this.deleteContext(oldestSessionId);
    }

    const retryToken = randomUUID();
    const expiresAt = Date.now() + this.ttlMs;
    const context: TaskRetryContext = {
      input: {
        ...payload.input,
        session:
          this.ctx.sessions.manager.get(payload.sessionId) ?? payload.input.session,
        resources: [...payload.input.resources],
      },
      failedRunId: payload.runId,
      retryToken,
      expiresAt,
      state: "available",
      timer: setTimeout(() => {
        const current = this.contexts.get(payload.sessionId);
        if (current === context) this.deleteContext(payload.sessionId);
      }, this.ttlMs),
    };
    context.timer.unref();
    this.contexts.set(payload.sessionId, context);

    collector.add({
      label: "重试任务",
      type: "primary",
      value: {
        action: "retry_task",
        sessionId: payload.sessionId,
        runId: payload.runId,
        retryToken,
      },
    });
  }

  /**
   * 任意新任务成功占用会话时废弃旧失败卡。若当前正由该上下文发起重试，则保留到
   * startTask 明确返回，保证卡片/提示词等前置启动失败后可以恢复原按钮。
   */
  handleTaskClaimed(payload: TaskClaimedPayload): void {
    const context = this.contexts.get(payload.sessionId);
    if (context?.state === "available") this.deleteContext(payload.sessionId);
  }

  /** 会话结束或新任务推进后，立即废弃对应失败卡。 */
  discard(sessionId: string): void {
    this.deleteContext(sessionId);
  }

  /** 严格校验操作者与失败轮次后重新拉起任务。 */
  async retryTask(
    sessionId: string,
    failedRunId: string,
    retryToken: string,
    operatorOpenId: string,
    botId: string,
  ): Promise<RetryTaskOutcome> {
    this.pruneExpired();
    const context = this.contexts.get(sessionId);
    if (
      !context ||
      context.failedRunId !== failedRunId ||
      context.retryToken !== retryToken ||
      context.input.botConfig.id !== botId
    ) {
      return { ok: false, reason: "not_found" };
    }
    // 身份只能来自飞书回调。缺失身份也必须拒绝，不能因为解析为空串而绕过鉴权。
    if (!operatorOpenId || operatorOpenId !== context.input.senderOpenId) {
      return { ok: false, reason: "forbidden" };
    }
    if (context.state === "starting" || this.ctx.tasks.hasActiveRun(sessionId)) {
      return { ok: false, reason: "already_running" };
    }

    const latestSession = this.ctx.sessions.manager.get(sessionId);
    if (!latestSession || latestSession.status === "closed") {
      this.deleteContext(sessionId);
      return { ok: false, reason: "not_found" };
    }
    if (latestSession.status === "active") {
      return { ok: false, reason: "already_running" };
    }

    // 先置 starting，保证并发点击只有一个入口能调用 startTask；前置失败时再恢复 available。
    context.state = "starting";
    const started = await this.ctx.tasks.startTask({
      ...context.input,
      session: latestSession,
      resources: [...context.input.resources],
    });
    if (started) {
      if (this.contexts.get(sessionId) === context) this.deleteContext(sessionId);
      return { ok: true };
    }

    const current = this.contexts.get(sessionId);
    const currentSession = this.ctx.sessions.manager.get(sessionId);
    if (
      current === context &&
      currentSession &&
      currentSession.status !== "closed" &&
      Date.now() < context.expiresAt
    ) {
      context.state = "available";
    } else if (current === context) {
      this.deleteContext(sessionId);
    }
    return {
      ok: false,
      reason: "start_failed",
      message: "重新拉起任务失败，请检查会话状态后重试。",
    };
  }

  /** 将重试结果映射为飞书 toast；非本插件动作返回 undefined 继续 serial 分发。 */
  async handleCardAction(
    action: { operatorOpenId: string; value: Record<string, unknown> },
    botId: string,
  ): Promise<CardActionResponse | undefined> {
    if (action.value.action !== "retry_task") return undefined;
    const sessionId =
      typeof action.value.sessionId === "string" ? action.value.sessionId : "";
    const failedRunId =
      typeof action.value.runId === "string" ? action.value.runId : "";
    const retryToken =
      typeof action.value.retryToken === "string" ? action.value.retryToken : "";
    const outcome = await this.retryTask(
      sessionId,
      failedRunId,
      retryToken,
      action.operatorOpenId,
      botId,
    );
    if (outcome.ok) {
      return { toast: { type: "success", content: "已重新发起任务，正在执行..." } };
    }
    if (outcome.reason === "forbidden") {
      return { toast: { type: "warning", content: "只有任务发起人可以重试任务。" } };
    }
    if (outcome.reason === "already_running") {
      return { toast: { type: "info", content: "该任务已经在执行中，请勿重复点击。" } };
    }
    if (outcome.reason === "start_failed") {
      return {
        toast: {
          type: "error",
          content: outcome.message ?? "重新启动任务失败。",
        },
      };
    }
    return {
      toast: {
        type: "info",
        content: "该重试请求已失效，请在话题中直接发消息。",
      },
    };
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, context] of this.contexts) {
      if (context.expiresAt <= now) this.deleteContext(sessionId);
    }
  }

  private deleteContext(sessionId: string): void {
    const context = this.contexts.get(sessionId);
    if (!context) return;
    clearTimeout(context.timer);
    this.contexts.delete(sessionId);
  }
}

export const name = "task-retry";
export const inject = ["tasks", "sessions"];

export function apply(ctx: Context, config: Config = {}) {
  const service = new TaskRetryController(ctx, config);
  ctx.on("task/failure-actions", (collector, payload) => {
    service.registerFailureAction(collector, payload);
  });
  ctx.on("task/claimed", (payload) => service.handleTaskClaimed(payload));
  ctx.on("session/closed", (sessionId) => service.discard(sessionId));
  ctx.on("bot/card-action", (action, _bot, botConfig) =>
    service.handleCardAction(action, botConfig.id),
  );
  ctx.effect(() => () => service.stop());
}
