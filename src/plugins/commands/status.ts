/**
 * /status 命令插件：展示当前会话的执行引擎、CLI 指针、工作目录与状态。
 * 在 cordis.yml 中移除本插件即可下线 /status。
 */
import type { Context } from "cordis";
import type { Session } from "../../core/session-manager.js";
import type { CliAdapter } from "../../cli/types.js";
import type { CommandHandler } from "../types.js";

const STATUS_LABELS: Record<Session["status"], string> = {
  creating: "创建中",
  active: "执行中",
  idle: "空闲",
  closed: "已关闭",
};

function formatSessionStatus(
  session: Session,
  botId: string,
  adapter: CliAdapter,
): string {
  return [
    `机器人：${botId}`,
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${adapter.displayName}`,
    `接入模式：${adapter.accessMode}`,
    `CLI 会话：${session.cliSessionId ?? "(尚未建立)"}`,
    `工作目录：${session.workspaceDir}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join("\n");
}

const handler: CommandHandler = async ({
  bot,
  botConfig,
  message,
  session,
  hasThread,
  cliAdapter,
}) => {
  await bot.reply(
    message.messageId,
    formatSessionStatus(session, botConfig.id, cliAdapter),
    hasThread,
  );
};

export const name = "commands/status";
export const inject = ["commands"];

export function apply(ctx: Context) {
  ctx.commands.register("status", handler);
}
