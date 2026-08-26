/**
 * clarification 澄清插件：注册 request_clarification MCP Server，认领工具结果，
 * 在飞书逐题收集答案，并沿用原会话继续 CLI。流程只保存在内存，服务重启后旧卡失效。
 */
import { Service, type Context } from "cordis";
import {
  ClarificationFlowStore,
  findClarificationRequest,
  formatClarificationAnswers,
  formatClarificationMessage,
  type ClarificationFlow,
} from "../core/clarification.js";
import type { CardAction, CardActionResponse } from "../im/lark.js";
import { clarificationToolServer } from "./clarification-tool.js";
import { startClarificationHttpServer } from "../mcp/clarification-http-server.js";
import type {
  TaskMessageOutcome,
  TaskMessagePayload,
  TaskToolCallsOutcome,
  TaskToolCallsPayload,
} from "./types.js";

/** 逐题澄清生产链路；同一任务的新请求会替换旧 token。 */
export class ClarificationService extends Service {
  readonly flows = new ClarificationFlowStore();

  constructor(ctx: Context) {
    super(ctx, "clarification");
  }

  findForTask(taskId: string, botId: string): ClarificationFlow | undefined {
    return this.flows.findForTask(taskId, botId);
  }

  /** 同话题文字会使旧卡失效，并带着已确认答案续接原任务。 */
  async handleTaskMessage(
    payload: TaskMessagePayload,
  ): Promise<TaskMessageOutcome | undefined> {
    const flow = this.flows.findForTask(payload.taskId, payload.botConfig.id);
    if (!flow) return undefined;
    this.flows.delete(flow.token);
    if (flow.cardMessageId) {
      try {
        await payload.bot.updateCard(
          flow.cardMessageId,
          this.ctx.cards.clarificationSuperseded({ flow }),
        );
      } catch (error) {
        // 卡片状态更新失败不能吞掉用户的新消息；token 已失效，后续点击仍会被拒绝。
        console.error("[澄清] 旧卡片失效状态更新失败:", (error as Error).message);
      }
    }
    return {
      requestedPrompt: formatClarificationMessage(flow, payload.requestedPrompt),
      originalRequestedPrompt: flow.requestedPrompt,
    };
  }

  async handleToolCalls(
    payload: TaskToolCallsPayload,
  ): Promise<TaskToolCallsOutcome | undefined> {
    const request = findClarificationRequest(payload.result.toolCalls);
    if (!request) return undefined;
    if (!(payload.result.sessionId ?? payload.session.cliSessionId)) {
      throw new Error("澄清工具已调用，但执行引擎没有返回可恢复的会话 ID");
    }
    const flow = this.flows.create({
      taskId: payload.taskId ?? payload.session.id,
      botId: payload.botConfig.id,
      sessionId: payload.session.id,
      ownerOpenId:
        payload.collaboration?.ownerOpenId ?? payload.senderOpenId,
      ownerUnionId:
        payload.collaboration?.ownerUnionId ?? payload.senderUnionId,
      originalMessageId: payload.replyToMessageId,
      requestedPrompt: payload.requestedPrompt,
      cardMessageId: payload.cardMessageId,
      replyInThread: payload.hasThread,
      isDirect: payload.isDirect,
      request,
      collaboration: payload.collaboration,
    });
    return {
      card: this.ctx.cards.clarification({ flow }),
      completion: "paused",
    };
  }

  async handleCardAction(
    action: CardAction,
    botId: string,
  ): Promise<CardActionResponse | undefined> {
    if (action.value.action !== "answer_clarification") return undefined;
    const token =
      typeof action.value.flowToken === "string" ? action.value.flowToken : "";
    const questionId =
      typeof action.value.questionId === "string" ? action.value.questionId : "";
    const flow = this.flows.get(token);
    if (
      !flow ||
      flow.botId !== botId ||
      (flow.cardMessageId && flow.cardMessageId !== action.messageId)
    ) {
      return { toast: { type: "error", content: "这组澄清问题已经失效。" } };
    }
    if (
      action.operatorOpenId !== flow.ownerOpenId &&
      (!flow.ownerUnionId || action.operatorUnionId !== flow.ownerUnionId)
    ) {
      return { toast: { type: "warning", content: "只有任务发起人可以回答。" } };
    }

    const question = flow.request.questions[flow.currentIndex];
    if (!question || question.id !== questionId) {
      return {
        toast: { type: "warning", content: "问题已经更新，请按当前卡片作答。" },
      };
    }
    const decisionMode =
      action.value.decisionMode === "current" ||
      action.value.decisionMode === "remaining"
        ? action.value.decisionMode
        : undefined;
    const willComplete =
      decisionMode === "remaining" ||
      flow.currentIndex === flow.request.questions.length - 1;
    if (willComplete) {
      const session = this.ctx.sessions.manager.get(flow.sessionId);
      if (!session || session.status === "closed" || !this.ctx.lark.bot(botId)) {
        return { toast: { type: "error", content: "对应的 CLI 会话已经失效。" } };
      }
      if (session.status === "active") {
        return {
          toast: { type: "warning", content: "当前会话仍在执行，请稍后重试。" },
        };
      }
    }

    let answered;
    if (decisionMode) {
      answered = this.flows.answerWithRecommendation(
        token,
        decisionMode === "remaining",
      );
    } else {
      const custom = action.value.custom === true;
      const optionId =
        typeof action.value.optionId === "string" ? action.value.optionId : "";
      const selected = question.options.find((option) => option.id === optionId);
      const customAnswer =
        typeof action.formValue?.custom_answer === "string"
          ? action.formValue.custom_answer.trim()
          : "";
      const answer = custom ? customAnswer : (selected?.label ?? "");
      if (!answer) {
        return {
          toast: {
            type: "warning",
            content: custom ? "请先输入你的答案。" : "这个选项已经失效。",
          },
        };
      }
      answered = this.flows.answer(token, questionId, answer);
    }
    if (!answered) {
      return { toast: { type: "warning", content: "答案没有保存，请重试。" } };
    }
    if (!answered.complete) {
      return {
        toast: { type: "success", content: "已记录，继续下一题。" },
        card: {
          type: "raw",
          data: this.ctx.cards.clarification({ flow: answered.flow }),
        },
      };
    }

    const session = this.ctx.sessions.manager.get(answered.flow.sessionId)!;
    const runtime = this.ctx.lark.bot(botId)!;
    this.flows.delete(token);
    this.ctx.tasks.startTask({
      bot: runtime.bot,
      botConfig: runtime.config,
      session,
      hasThread: answered.flow.replyInThread,
      replyToMessageId: answered.flow.originalMessageId,
      senderOpenId: answered.flow.ownerOpenId,
      senderUnionId: answered.flow.ownerUnionId,
      taskId: answered.flow.taskId,
      isDirect: answered.flow.isDirect,
      requestedPrompt: formatClarificationAnswers(answered.flow),
      originalRequestedPrompt: answered.flow.requestedPrompt,
      isCompacting: false,
      collaboration: answered.flow.collaboration,
      senderRuntime: answered.flow.collaboration
        ? this.ctx.lark.bot(answered.flow.collaboration.fromBotId)
        : undefined,
      resources: [],
      // 仍广播 task/result 给编排汇总，但普通协作与 QA 自动交接到此为止。
      suppressHandoff: true,
    });
    return {
      toast: { type: "success", content: "答案已收到。" },
      card: {
        type: "raw",
        data: this.ctx.cards.clarificationContinuing({ flow: answered.flow }),
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

export async function apply(ctx: Context) {
  const service = new ClarificationService(ctx);
  // DimAgent ACP 只声明 HTTP/SSE MCP；stdio 继续服务 Claude/Codex/Dim headless/agy。
  // HTTP 入口仅绑定 loopback，并随插件卸载关闭，避免扩大工具暴露面。
  const httpServer = await startClarificationHttpServer();
  const unregister = ctx.applicationTools.register(
    clarificationToolServer(httpServer.url),
  );
  ctx.effect(() => () => httpServer.close(), "clarification MCP HTTP");
  ctx.on("task/tool-calls", (payload) => service.handleToolCalls(payload));
  ctx.on("task/message", (payload) => service.handleTaskMessage(payload));
  ctx.on("bot/card-action", (action, _bot, botConfig) =>
    service.handleCardAction(action, botConfig.id),
  );
  return unregister;
}
