/**
 * /close 命令插件：先广播停止信号再关闭会话，防止后台任务继续刷卡片。
 * 在 cordis.yml 中移除本插件即可下线 /close。
 */
import type { Context } from "cordis";
import type { CommandHandler } from "../types.js";

const handler: CommandHandler = async ({
  ctx,
  bot,
  message,
  session,
  hasThread,
}) => {
  // 先发取消信号，再关闭状态；后台任务看到信号后会停止卡片刷新。
  ctx.tasks.abortForClose(session.id);
  if (session.status !== "closed") {
    await ctx.sessions.manager.transition(session.id, "closed");
  }
  await bot.reply(
    message.messageId,
    "当前会话已关闭。需要继续时，请新开一个话题。",
    hasThread,
  );
};

export const name = "commands/close";
export const inject = ["commands", "sessions", "tasks"];

export function apply(ctx: Context) {
  ctx.commands.register("close", handler);
}
