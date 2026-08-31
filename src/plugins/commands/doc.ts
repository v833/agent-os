/**
 * /doc 命令插件：显式开启文档交付能力，把用户请求交给当前 bot 生成飞书云文档。
 * 文档交付与产品方案审批分离；移除本插件即可下线该命令。
 */
import type { Context } from "cordis";
import { interactionPolicyOf } from "../../core/interaction-policy.js";
import { extractResourceKeys } from "../../im/message-parser.js";
import type { CommandHandler } from "../types.js";

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
  const interaction = interactionPolicyOf({ interaction: inputInteraction });
  if (command.name !== "doc") return;
  if (!command.prompt) {
    await bot.reply(
      message.messageId,
      "用法：/doc <任务>。我会完成任务并生成可查阅的飞书云文档。",
      hasThread,
    );
    return;
  }
  if (!isNew && session.status === "creating") {
    await bot.reply(
      message.messageId,
      "当前会话正在准备，请稍后再使用 /doc。",
      hasThread,
    );
    return;
  }
  if (session.status === "active") {
    await bot.reply(
      message.messageId,
      "当前会话还在执行，请等任务结束后再使用 /doc。",
      hasThread,
    );
    return;
  }
  if (session.status === "closed") {
    await bot.reply(message.messageId, "当前话题的会话已经关闭。", hasThread);
    return;
  }
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
    requestedPrompt: command.prompt,
    isCompacting: false,
    resources: extractResourceKeys(message.messageType, message.rawContent),
  });
  if (!started) {
    const latestStatus = ctx.sessions.manager.get(session.id)?.status;
    const detail = latestStatus === "active"
      ? "当前会话还在执行，请等任务结束后再使用 /doc。"
      : latestStatus === "closed"
        ? "当前话题的会话已经关闭。"
        : "文档任务未能启动，请稍后重试。";
    await bot.reply(message.messageId, detail, hasThread);
  }
};

export const name = "commands/doc";
export const inject = ["commands", "tasks", "sessions"];

export function apply(ctx: Context) {
  ctx.commands.register("doc", handler);
}
