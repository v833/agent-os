/**
 * collaboration 协作服务插件：管理 bot 间交接单与轮次去重，
 * 并监听 task/result 事件自动派发下一轮审查或回传来源 bot。
 * 协作是可选插件：移除后任务编排仍正常，只是不再自动交接。
 */
import { Service, type Context } from "cordis";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  CollaborationInbox,
  collaborationTurnKey,
  type CollaborationMessage,
  type QAReviewContext,
} from "../core/collaboration.js";
import type { BotConfig } from "../core/bot-registry.js";
import type { Bot } from "../im/lark.js";
import type { TaskResultPayload } from "./types.js";

/** 协作消息去重键最多保留的数量；超限按最旧插入顺序淘汰，避免长期运行无界增长。 */
export const MAX_PROCESSED_TURNS = 10_000;

/** 发起一次交接所需的完整参数。 */
export interface SendDispatchOptions {
  senderConfig: BotConfig;
  senderBot: Bot;
  replyToMessageId: string;
  targetBotId: string;
  taskId: string;
  round: number;
  maxRounds: number;
  workspaceDir: string;
  prompt: string;
  /** 存在时交由 qa-gate 插件处理，普通 collaboration 不按轮次自动回传。 */
  qaReview?: QAReviewContext;
}

/** 提供交接单、轮次去重与审查派发能力。 */
export class CollaborationService extends Service {
  readonly inbox = new CollaborationInbox();
  readonly processedTurns = new Set<string>();
  /** 单独维护访问顺序，保留 processedTurns 的 Set 兼容接口并实现 LRU 淘汰。 */
  private readonly processedTurnOrder = new Map<string, true>();

  constructor(ctx: Context) {
    super(ctx, "collaboration");
  }

  register(message: CollaborationMessage): void {
    this.inbox.register(message);
  }

  consume(dispatchId: string, toBotId: string): CollaborationMessage | undefined {
    return this.inbox.consume(dispatchId, toBotId);
  }

  turnKey(message: CollaborationMessage): string {
    return collaborationTurnKey(message);
  }

  isTurnProcessed(key: string): boolean {
    return this.processedTurns.has(key);
  }

  markTurnProcessed(key: string): void {
    // 重复事件本身仍是幂等的，但刷新其位置，避免活跃交接在容量压力下被过早淘汰。
    this.processedTurns.delete(key);
    this.processedTurns.add(key);
    this.processedTurnOrder.delete(key);
    this.processedTurnOrder.set(key, true);
    while (this.processedTurnOrder.size > MAX_PROCESSED_TURNS) {
      const oldest = this.processedTurnOrder.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.processedTurnOrder.delete(oldest);
      this.processedTurns.delete(oldest);
    }
  }

  /**
   * 登记交接单、发送说明卡片和真实提及；任一步出错都会撤销待领取记录，
   * 避免目标 bot 后续在一条失败的通知上重复领取。
   */
  async sendDispatch(options: SendDispatchOptions): Promise<void> {
    const target = this.ctx.lark.bot(options.targetBotId);
    if (!target) {
      throw new Error(`协作 bot 尚未就绪: ${options.targetBotId}`);
    }

    const collaboration: CollaborationMessage = {
      dispatchId: randomUUID().replaceAll("-", "").slice(0, 12),
      taskId: options.taskId,
      fromBotId: options.senderConfig.id,
      toBotId: options.targetBotId,
      round: options.round,
      maxRounds: options.maxRounds,
      workspaceDir: options.workspaceDir,
      prompt: options.prompt,
      ...(options.qaReview ? { qaReview: options.qaReview } : {}),
    };
    this.inbox.register(collaboration);
    try {
      const senderName =
        this.ctx.lark.bot(options.senderConfig.id)?.identity.name ??
        options.senderConfig.id;
      const cardMessageId = await options.senderBot.replyCard(
        options.replyToMessageId,
        this.ctx.cards.collaboration({
          senderName,
          targetName: target.identity.name,
          workspaceName: basename(options.workspaceDir),
          prompt: options.prompt,
          round: options.round,
          maxRounds: options.maxRounds,
        }),
        true,
      );
      if (!cardMessageId) {
        throw new Error("飞书没有返回协作卡片 message_id");
      }

      const mentionMessageId = await options.senderBot.replyMention(
        cardMessageId,
        target.identity,
        options.round === 1
          ? `新的代码审查任务（任务编号：${collaboration.dispatchId}），请查看上方卡片。`
          : `审查反馈已经返回（任务编号：${collaboration.dispatchId}），请查看上方卡片。`,
        true,
      );
      if (!mentionMessageId) {
        throw new Error("飞书没有返回协作通知 message_id");
      }
    } catch (error) {
      this.inbox.consume(collaboration.dispatchId, collaboration.toBotId);
      throw error;
    }

    console.log(
      `[协作] task=${options.taskId} ${options.senderConfig.id} -> ${options.targetBotId} round=${options.round}/${options.maxRounds}`,
    );
  }

  /**
   * 普通协作完成后的决策：未达轮次上限则回传来源 bot，否则通知来源；
   * QA reviewBy 交接由可选 qa-gate 插件独占，避免两个监听器重复派发。
   */
  async handleTaskResult(payload: TaskResultPayload): Promise<void> {
    const {
      bot,
      botConfig,
      session,
      answer,
      replyToMessageId,
      hasThread,
      collaboration,
      senderRuntime,
    } = payload;
    try {
      if (collaboration?.qaReview || (!collaboration && botConfig.reviewBy)) return;
      if (collaboration && collaboration.round < collaboration.maxRounds) {
        await this.sendDispatch({
          senderConfig: botConfig,
          senderBot: bot,
          replyToMessageId,
          targetBotId: collaboration.fromBotId,
          taskId: collaboration.taskId,
          round: collaboration.round + 1,
          maxRounds: collaboration.maxRounds,
          workspaceDir: session.workspaceDir,
          prompt: answer || "任务已完成，请检查当前工作目录。",
        });
      } else if (collaboration && senderRuntime) {
        await bot.sendResultNotification({
          replyToMessageId,
          target: senderRuntime.identity,
          text: "本轮协作已完成，请查看上方结果。",
          replyInThread: hasThread,
        });
      }
    } catch (error) {
      const errorMessage = (error as Error).message;
      console.error("[协作] 派发失败:", errorMessage);
      await bot.reply(
        replyToMessageId,
        `协作派发失败：${errorMessage}`,
        hasThread,
      );
    }
  }
}

export const name = "collaboration";
export const inject = ["lark", "cards"];

export function apply(ctx: Context) {
  const service = new CollaborationService(ctx);
  // 用事件监听而非直接调用，让协作成为可选插件：移除本插件不会影响任务执行。
  ctx.on("task/result", async (payload) => {
    await service.handleTaskResult(payload);
  });
}
