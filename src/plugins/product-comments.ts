/**
 * product-comments 产品评审插件：消费云文档评论事件，按文档 token 找回待确认的
 * 产品 Flow，续接原 CLI 会话让产品经理修改文档，并把简短结果回复到同一条评论。
 * 评论处理与平台适配、产品 Flow、CLI 会话通过 ctx 服务和类型化事件协作。
 */
import { Service, type Context } from "cordis";
import { randomUUID } from "node:crypto";
import { CliRunError } from "../cli/runner.js";
import type { CliRunResult } from "../cli/types.js";
import {
  botCliEnvironment,
  buildBotPrompt,
  type BotConfig,
} from "../core/bot-registry.js";
import { teamInteractionPolicy } from "../core/interaction-policy.js";
import type { Session } from "../core/session-manager.js";
import type { ProductSpecFlow } from "../core/product-spec.js";
import type { Bot as LarkBot, IncomingDocumentComment as LarkComment } from "../im/lark.js";

const MAX_REMEMBERED_EVENTS = 1_000;
const COMMENT_FAILURE_MESSAGE = "这条评论暂时无法处理，请稍后重试或在原话题联系产品经理。";

/** 持有评论去重与同会话队列；卸载插件即可整体下线评论入口。 */
export class ProductCommentsService extends Service {
  private readonly processedEvents = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(ctx: Context) {
    super(ctx, "productComments");
  }

  /** 接收 lark 归一化事件；不满足产品评审条件时静默忽略。 */
  schedule(
    config: BotConfig,
    bot: LarkBot,
    comment: LarkComment,
  ): void {
    if (!comment.mentionedBot || comment.fileType !== "docx") return;
    const flow = this.ctx.productSpec.flows.findPendingByDocument(
      config.id,
      comment.fileToken,
    );
    if (!flow) return;

    const eventKey = comment.eventId || [
      comment.fileToken,
      comment.commentId,
      comment.replyId,
    ].join(":");
    if (this.processedEvents.has(eventKey)) return;
    this.rememberEvent(eventKey);

    const workingReaction = bot.setDocumentCommentWorking(comment, true)
      .then(() => true)
      .catch((error) => {
        console.warn("添加文档评论处理中表情失败，继续执行:", (error as Error).message);
        return false;
      });
    const previous = this.queues.get(flow.sessionId) ?? Promise.resolve();
    const queued = Promise.all([
      previous.catch(() => undefined),
      workingReaction,
    ]).then(async ([, reactionAdded]) => {
      try {
        const result = await this.runComment(config, flow, comment);
        await bot.replyToDocumentComment(
          comment,
          result.answer || "已按评论更新原文档，请复查。",
        );
      } finally {
        if (reactionAdded) {
          await bot.setDocumentCommentWorking(comment, false).catch((error) => {
            console.warn("移除文档评论处理中表情失败:", (error as Error).message);
          });
        }
      }
    });
    this.queues.set(flow.sessionId, queued);
    void queued
      .catch(async (error) => {
        console.error(
          `[产品评论] 处理失败 event=${comment.eventId || "unknown"}:`,
          error,
        );
        await bot.replyToDocumentComment(comment, COMMENT_FAILURE_MESSAGE)
          .catch((replyError) => {
            console.error("评论错误回复失败:", (replyError as Error).message);
          });
      })
      .finally(() => {
        if (this.queues.get(flow.sessionId) === queued) {
          this.queues.delete(flow.sessionId);
        }
      });
  }

  private async runComment(
    config: BotConfig,
    flow: ProductSpecFlow,
    comment: LarkComment,
  ): Promise<CliRunResult> {
    const sessionId = flow.sessionId;
    if (!sessionId) throw new Error("评论对应的产品会话不存在");
    const session = await this.claimSession(sessionId);

    const activeRun = {
      controller: new AbortController(),
      ownerOpenId: flow.ownerOpenId,
      runId: randomUUID(),
    };
    this.ctx.tasks.activeRuns.set(session.id, activeRun);
    try {
      const adapter = this.ctx.cli.get(
        session.cliId,
        session.accessMode ?? "headless",
      );
      const interaction = teamInteractionPolicy();
      const teamContext = this.ctx.root.bail("task/prompt-context", config, {
        interaction,
      });
      const prompt = await buildBotPrompt(
        config,
        documentCommentPrompt(flow, comment),
        teamContext ?? "",
        this.ctx.config.defaultProductDeliveryMode,
        { interaction },
      );
      try {
        const result = await this.ctx.cli.run({
          adapter,
          prompt,
          cwd: session.workspaceDir,
          sessionId: session.cliSessionId,
          signal: activeRun.controller.signal,
          env: botCliEnvironment(config),
        });
        if (result.sessionId) {
          await this.ctx.sessions.manager.setCliSessionId(session.id, result.sessionId);
        }
        if (result.stats?.contextWindowTokens) {
          this.ctx.tasks.contextWindows.set(session.id, result.stats.contextWindowTokens);
        }
        return result;
      } catch (error) {
        const sessionUnavailable =
          error instanceof CliRunError &&
          Boolean(adapter.isSessionUnavailable?.(error.message)) &&
          Boolean(session.cliSessionId);
        if (sessionUnavailable) {
          await this.ctx.sessions.manager.clearCliSessionId(session.id);
        }
        if (error instanceof CliRunError && error.sessionId) {
          if (!sessionUnavailable) {
            await this.ctx.sessions.manager.setCliSessionId(session.id, error.sessionId);
          }
        }
        throw error;
      }
    } finally {
      if (this.ctx.tasks.activeRuns.get(session.id) === activeRun) {
        this.ctx.tasks.activeRuns.delete(session.id);
      }
      if (this.ctx.sessions.manager.get(session.id)?.status === "active") {
        await this.ctx.sessions.manager.transition(session.id, "idle");
      }
    }
  }

  /** 等待并占用会话；与普通消息任务竞争时继续排队而不是丢失评论。 */
  private async claimSession(sessionId: string): Promise<Session> {
    while (true) {
      const session = this.ctx.sessions.manager.get(sessionId);
      if (!session || session.status === "closed") {
        throw new Error("评论对应的产品会话已经失效");
      }
      if (session.status === "idle") {
        if (!session.cliSessionId) {
          throw new Error("评论对应的产品 CLI 会话不存在");
        }
        try {
          return await this.ctx.sessions.manager.transition(session.id, "active");
        } catch (error) {
          // 另一个入口可能刚刚抢占会话；确认仍是 active 后回到队列等待。
          if (this.ctx.sessions.manager.get(sessionId)?.status === "active") {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            continue;
          }
          throw error;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  private rememberEvent(eventKey: string): void {
    this.processedEvents.add(eventKey);
    if (this.processedEvents.size <= MAX_REMEMBERED_EVENTS) return;
    const oldest = this.processedEvents.values().next().value;
    if (oldest) this.processedEvents.delete(oldest);
  }
}

function documentCommentPrompt(
  flow: ProductSpecFlow,
  comment: LarkComment,
): string {
  if (flow.request.deliveryMode !== "lark-doc") {
    throw new Error("本地产品方案不能处理飞书文档评论");
  }
  return [
    "用户在待确认的飞书产品方案中通过评论明确提及了你。",
    `文档 URL：${flow.request.documentUrl}`,
    `文档类型：${comment.fileType}`,
    `评论 ID：${comment.commentId}`,
    comment.replyId ? `触发回复 ID：${comment.replyId}` : "",
    "使用 lark-drive 读取这一条评论、完整回复和正文位置，再使用 lark-doc 精确修改原文档。",
    "修改成功后，最终回答只写一段给评论者看的简短说明，讲清楚具体改了什么。Agent OS 会把最终回答写回原评论。",
    "不要调用评论回复或解决接口，评论是否解决由用户复查后决定。",
    "不要调用 request_spec_approval，不要生成新的确认卡；原待确认卡继续有效。",
  ].filter(Boolean).join("\n\n");
}

export const name = "product-comments";
export const inject = ["config", "sessions", "cli", "lark", "tasks", "productSpec"];

export function apply(ctx: Context) {
  const service = new ProductCommentsService(ctx);
  ctx.on("bot/document-comment", (comment, bot, botConfig) => {
    service.schedule(botConfig, bot, comment);
  });
}
