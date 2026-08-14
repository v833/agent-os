/**
 * /resume 命令插件：列出当前工作目录的原生 CLI 会话卡片，
 * 供用户选择恢复上下文。在 cordis.yml 中移除本插件即可下线 /resume。
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
      "当前任务结束后才能切换会话。",
      hasThread,
    );
    return;
  }
  if (session.status === "closed") {
    await bot.reply(message.messageId, "当前话题的会话已经关闭。", hasThread);
    return;
  }
  try {
    const nativeSessions = await ctx.cli.listNativeSessions({
      adapter: cliAdapter,
      cwd: session.workspaceDir,
    });
    await bot.replyCard(
      message.messageId,
      ctx.cards.resume({
        agentSessionId: session.id,
        cliName: cliAdapter.displayName,
        currentCliSessionId: session.cliSessionId,
        sessions: nativeSessions,
      }),
      hasThread,
    );
  } catch (error) {
    await bot.reply(
      message.messageId,
      `无法读取 ${cliAdapter.displayName} 会话：${(error as Error).message}`,
      hasThread,
    );
  }
};

export const name = "commands/resume";
export const inject = ["commands", "sessions", "cli", "cards"];

export function apply(ctx: Context) {
  ctx.commands.register("resume", handler);
}
