/**
 * /schedule 命令插件：用自然语言创建定时任务，或用 pause/resume/delete/run
 * 直接管理已有计划。自然语言不硬拆，交给当前 bot 理解后调用 schedule_manage
 * 创建；管理动作直接操作 Scheduler，不启动 CLI。
 */
import type { Context } from "cordis";
import { interactionPolicyOf } from "../../core/interaction-policy.js";
import { extractResourceKeys } from "../../im/message-parser.js";
import type { CommandHandler } from "../types.js";

const PAUSE_RE = /^pause\s+([a-z0-9_-]+)$/i;
const RESUME_RE = /^resume\s+([a-z0-9_-]+)$/i;
const DELETE_RE = /^delete\s+([a-z0-9_-]+)$/i;
const RUN_RE = /^run\s+([a-z0-9_-]+)$/i;

const handler: CommandHandler = async ({
  ctx,
  bot,
  botConfig,
  message,
  taskId,
  session,
  isNew,
  hasThread,
  command,
  interaction: inputInteraction,
}) => {
  if (command.name !== "schedule") return;
  const request = command.request;
  const actor = {
    chatId: message.chatId,
    creatorOpenId: message.senderOpenId,
  };

  if (!request) {
    await bot.reply(
      message.messageId,
      "用法：/schedule <需求>，例如 `/schedule 每小时检查一次服务日志`。用 /schedules 查看全部计划。",
      hasThread,
    );
    return;
  }

  const pause = PAUSE_RE.exec(request);
  if (pause) {
    const outcome = await ctx.schedule.manage(
      { action: "pause", id: pause[1] },
      actor,
    );
    await bot.reply(
      message.messageId,
      outcome.notice,
      hasThread,
    );
    return;
  }
  const resume = RESUME_RE.exec(request);
  if (resume) {
    const outcome = await ctx.schedule.manage(
      { action: "resume", id: resume[1] },
      actor,
    );
    await bot.reply(
      message.messageId,
      outcome.notice,
      hasThread,
    );
    return;
  }
  const remove = DELETE_RE.exec(request);
  if (remove) {
    const outcome = await ctx.schedule.manage(
      { action: "remove", id: remove[1] },
      actor,
    );
    await bot.reply(
      message.messageId,
      outcome.notice,
      hasThread,
    );
    return;
  }
  const run = RUN_RE.exec(request);
  if (run) {
    const outcome = await ctx.schedule.manage(
      { action: "run", id: run[1] },
      actor,
    );
    await bot.reply(
      message.messageId,
      outcome.notice,
      hasThread,
    );
    return;
  }

  // 自然语言创建：启动一轮任务，让当前 bot 理解需求并调用 schedule_manage。
  const interaction = interactionPolicyOf({ interaction: inputInteraction });
  if (!isNew && session.status === "creating") {
    await bot.reply(
      message.messageId,
      "当前会话正在准备，请稍后再使用 /schedule。",
      hasThread,
    );
    return;
  }
  if (session.status === "active") {
    await bot.reply(
      message.messageId,
      "当前会话还在执行，请等任务结束后再使用 /schedule。",
      hasThread,
    );
    return;
  }
  if (session.status === "closed") {
    await bot.reply(message.messageId, "当前话题的会话已经关闭。", hasThread);
    return;
  }

  const taskText = [
    "用户想创建一个定时任务。",
    `需求：${request}`,
    "请使用 schedule_manage 工具，action=add 创建：targetBotId 选择团队中负责执行的成员，prompt 保留完整需求，rule 根据需求选择合适的调度规则（一次性、固定间隔或 Cron）。",
  ].join("\n\n");

  const started = await ctx.tasks.startTask({
    bot,
    botConfig,
    session,
    hasThread,
    replyToMessageId: message.messageId,
    senderOpenId: message.senderOpenId,
    senderUnionId: message.senderUnionId,
    taskId,
    interaction,
    requestedPrompt: taskText,
    isCompacting: false,
    resources: extractResourceKeys(message.messageType, message.rawContent),
  });
  if (!started) {
    const latestStatus = ctx.sessions.manager.get(session.id)?.status;
    const detail =
      latestStatus === "active"
        ? "当前会话还在执行，请等任务结束后再使用 /schedule。"
        : latestStatus === "closed"
          ? "当前话题的会话已经关闭。"
          : "定时任务未能启动，请稍后重试。";
    await bot.reply(message.messageId, detail, hasThread);
  }
};

export const name = "commands/schedule";
export const inject = ["commands", "schedule", "tasks", "sessions"];

export function apply(ctx: Context) {
  ctx.commands.register("schedule", handler);
}
