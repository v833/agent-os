/**
 * /close 命令插件：先广播停止信号再关闭会话，随后发出 session/closed 供可选插件清理，
 * 防止后台任务继续刷卡片或保留失效的会话级临时状态。
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
  try {
    await ctx.parallel("session/closed", session.id);
  } catch (error) {
    // 会话已经关闭；可选插件清理失败只能记录，不能让 /close 对用户表现为失败。
    console.error("[会话] 广播关闭事件失败:", (error as Error).message);
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
