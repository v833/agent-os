/**
 * /schedules 命令插件：用卡片列出当前全部定时任务计划。
 */
import type { Context } from "cordis";
import type { CommandHandler } from "../types.js";

const handler: CommandHandler = async ({
  ctx,
  bot,
  message,
  hasThread,
  command,
}) => {
  if (command.name !== "schedules") return;
  const outcome = await ctx.schedule.manage(
    { action: "list" },
    {
      chatId: message.chatId,
      creatorOpenId: message.senderOpenId,
    },
  );
  await bot.replyCard(
    message.messageId,
    ctx.cards.scheduleList(outcome.schedules ?? []),
    hasThread,
  );
};

export const name = "commands/schedules";
export const inject = ["commands", "schedule", "cards"];

export function apply(ctx: Context) {
  ctx.commands.register("schedules", handler);
}
