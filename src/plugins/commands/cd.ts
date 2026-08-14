/**
 * /cd 命令插件：查看或切换当前话题的工作目录；切换后旧 CLI 指针被清除。
 * 在 cordis.yml 中移除本插件即可下线 /cd。
 */
import type { Context } from "cordis";
import {
  ensureWorkspaceDirectory,
  resolveWorkspacePath,
} from "../../core/workspace.js";
import type { CommandHandler } from "../types.js";

const handler: CommandHandler = async ({
  ctx,
  bot,
  message,
  session,
  hasThread,
  command,
}) => {
  // 本插件只处理 /cd；运行时保证命中，这里收窄类型便于访问 command.path。
  if (command.name !== "cd") return;
  if (!command.path) {
    await bot.reply(
      message.messageId,
      `当前工作目录：${session.workspaceDir}`,
      hasThread,
    );
    return;
  }
  if (session.status === "active") {
    await bot.reply(
      message.messageId,
      "当前任务仍在执行，结束后再切换工作目录。",
      hasThread,
    );
    return;
  }
  try {
    const workspaceDir = resolveWorkspacePath(command.path, session.workspaceDir);
    await ensureWorkspaceDirectory(workspaceDir);
    const changed = workspaceDir !== session.workspaceDir;
    await ctx.sessions.manager.setWorkspaceDir(session.id, workspaceDir);
    await bot.reply(
      message.messageId,
      changed
        ? `工作目录已切换到：${workspaceDir}\n下一条任务会在这里建立新的 CLI 会话。`
        : `当前工作目录已经是：${workspaceDir}`,
      hasThread,
    );
  } catch (error) {
    await bot.reply(
      message.messageId,
      `无法切换工作目录：${(error as Error).message}`,
      hasThread,
    );
  }
};

export const name = "commands/cd";
export const inject = ["commands", "sessions"];

export function apply(ctx: Context) {
  ctx.commands.register("cd", handler);
}
