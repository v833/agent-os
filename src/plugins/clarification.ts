/**
 * clarification 澄清插件：注册 request_clarification MCP Server，认领对应工具结果，
 * 发送飞书问题表单并持久化 run/session 关联；用户提交后续接原 CLI 会话。
 */
import { Service, type Context } from "cordis";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  findClarificationRequest,
  type ClarificationRequest,
} from "../core/clarification.js";
import type { CardAction, CardActionResponse } from "../im/lark.js";
import type {
  TaskToolCallsOutcome,
  TaskToolCallsPayload,
} from "./types.js";
import {
  ClarificationStore,
  type PendingClarification,
} from "./clarification-store.js";
import { clarificationToolServer } from "./clarification-tool.js";

function answerPrompt(
  request: ClarificationRequest,
  answers: ReadonlyMap<string, string>,
): string {
  const rows = request.questions.map((question) => {
    const optionId = answers.get(question.id)!;
    const option = question.options.find((candidate) => candidate.id === optionId)!;
    return `- ${question.prompt}\n  用户选择：${option.label}（${option.id}）`;
  });
  return [
    "用户已经回答上一轮 request_clarification。",
    ...rows,
    "请基于这些答案继续原始任务，不要重复询问已经回答的问题。",
  ].join("\n\n");
}

/** 澄清生产链路服务：待回答记录以插件自己的 JSON 文件持久化。 */
export class ClarificationService extends Service {
  private readonly pending = new Map<string, PendingClarification>();

  constructor(
    ctx: Context,
    private readonly store: ClarificationStore,
  ) {
    super(ctx, "clarification");
  }

  async load(): Promise<void> {
    for (const record of await this.store.load()) {
      this.pending.set(record.id, record);
    }
  }

  private persist(): Promise<void> {
    return this.store.save([...this.pending.values()]);
  }

  async handleToolCalls(
    payload: TaskToolCallsPayload,
  ): Promise<TaskToolCallsOutcome | undefined> {
    const request = findClarificationRequest(payload.result.toolCalls);
    if (!request) return undefined;
    const cliSessionId = payload.result.sessionId ?? payload.session.cliSessionId;
    if (!cliSessionId) {
      throw new Error("澄清工具已调用，但执行引擎没有返回可恢复的会话 ID");
    }
    const pending: PendingClarification = {
      id: randomUUID(),
      botId: payload.botConfig.id,
      sessionId: payload.session.id,
      runId: payload.runId,
      cliSessionId,
      ownerOpenId: payload.senderOpenId,
      replyToMessageId: payload.replyToMessageId,
      hasThread: payload.hasThread,
      requestedPrompt: payload.requestedPrompt,
      request,
      collaboration: payload.collaboration,
      createdAt: new Date().toISOString(),
    };
    // 同一 session 只允许等待一份回答；新请求替换旧记录，旧卡片随后会被判失效。
    for (const [id, record] of this.pending) {
      if (record.sessionId === pending.sessionId) this.pending.delete(id);
    }
    this.pending.set(pending.id, pending);
    try {
      await this.persist();
    } catch (error) {
      this.pending.delete(pending.id);
      throw error;
    }
    return {
      card: this.ctx.cards.clarification({
        clarificationId: pending.id,
        runId: pending.runId,
        request: pending.request,
      }),
    };
  }

  async handleCardAction(
    action: CardAction,
    botId: string,
  ): Promise<CardActionResponse | undefined> {
    if (action.value.action !== "submit_clarification") return undefined;
    const id =
      typeof action.value.clarificationId === "string"
        ? action.value.clarificationId
        : "";
    const runId =
      typeof action.value.runId === "string" ? action.value.runId : "";
    const pending = this.pending.get(id);
    if (!pending || pending.botId !== botId || pending.runId !== runId) {
      return { toast: { type: "error", content: "这份澄清请求已经失效。" } };
    }
    if (action.operatorOpenId !== pending.ownerOpenId) {
      return {
        toast: { type: "warning", content: "只有任务发起人可以提交回答。" },
      };
    }
    const session = this.ctx.sessions.manager.get(pending.sessionId);
    if (!session || session.status === "closed") {
      return { toast: { type: "error", content: "原会话已经关闭或不存在。" } };
    }
    if (session.status === "active") {
      return { toast: { type: "warning", content: "当前会话正在执行，请稍后再提交。" } };
    }

    const answers = new Map<string, string>();
    for (const question of pending.request.questions) {
      const selected = action.formValue?.[question.id];
      if (
        typeof selected !== "string" ||
        !question.options.some((option) => option.id === selected)
      ) {
        return { toast: { type: "error", content: "请为每个问题选择一个有效答案。" } };
      }
      answers.set(question.id, selected);
    }

    // 先删除并落盘，防止重复回调并发启动两轮；启动失败仍可由用户提交新任务恢复。
    this.pending.delete(id);
    try {
      await this.persist();
      const updatedSession = await this.ctx.sessions.manager.setCliSessionId(
        pending.sessionId,
        pending.cliSessionId,
      );
      const runtime = this.ctx.lark.bot(pending.botId);
      if (!runtime) throw new Error(`澄清 bot 尚未就绪: ${pending.botId}`);
      this.ctx.tasks.startTask({
        bot: runtime.bot,
        botConfig: runtime.config,
        session: updatedSession,
        hasThread: pending.hasThread,
        replyToMessageId: pending.replyToMessageId,
        senderOpenId: pending.ownerOpenId,
        requestedPrompt: answerPrompt(pending.request, answers),
        originalRequestedPrompt: pending.requestedPrompt,
        isCompacting: false,
        collaboration: pending.collaboration,
        senderRuntime: pending.collaboration
          ? this.ctx.lark.bot(pending.collaboration.fromBotId)
          : undefined,
        resources: [],
      });
    } catch (error) {
      this.pending.set(id, pending);
      await this.persist().catch(() => undefined);
      return { toast: { type: "error", content: (error as Error).message } };
    }

    const answerRecord = Object.fromEntries(answers);
    return {
      toast: { type: "success", content: "回答已提交，正在继续执行。" },
      card: {
        type: "raw",
        data: this.ctx.cards.clarificationCompleted({
          request: pending.request,
          answers: answerRecord,
        }),
      },
    };
  }
}

export const name = "clarification";
export const inject = [
  "applicationTools",
  "sessions",
  "tasks",
  "lark",
  "cards",
];

export interface Config {
  storePath?: string;
}

export async function apply(ctx: Context, config: Config = {}) {
  const service = new ClarificationService(
    ctx,
    new ClarificationStore(
      resolve(process.cwd(), config.storePath ?? "data/clarifications.json"),
    ),
  );
  await service.load();
  const unregister = ctx.applicationTools.register(clarificationToolServer());
  ctx.on("task/tool-calls", (payload) => service.handleToolCalls(payload));
  ctx.on("bot/card-action", (action, _bot, botConfig) =>
    service.handleCardAction(action, botConfig.id),
  );
  return unregister;
}
