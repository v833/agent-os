/**
 * /new 命令插件：清空当前话题的 CLI 会话指针，让下一条任务从全新会话开始。
 * 在 cordis.yml 中移除本插件即可下线 /new。
 */
import type { Context } from "cordis";
import type { CommandHandler } from "../types.js";

const handler: CommandHandler = async ({
  ctx,
  bot,
  message,
  session,
  hasThread,
  cliAdapter,
}) => {
  if (session.status === "active") {
    await bot.reply(
      message.messageId,
      "当前任务结束后才能新建会话。",
      hasThread,
    );
    return;
  }
  if (session.status === "closed") {
    await bot.reply(message.messageId, "当前话题的会话已经关闭。", hasThread);
    return;
  }
  await ctx.sessions.manager.clearCliSessionId(session.id);
  await bot.replyCard(
    message.messageId,
    ctx.cards.notice({
      title: "新会话已就绪",
      template: "green",
      detail: `下一条任务会由 ${cliAdapter.displayName} 开启全新的 CLI 会话。\n\n旧会话仍然保留，可以随时用 \`/resume\` 找回来。`,
    }),
    hasThread,
  );
};

export const name = "commands/new";
export const inject = ["commands", "sessions", "cards"];

export function apply(ctx: Context) {
  ctx.commands.register("new", handler);
}
