/**
 * /help 命令插件：列出全部会话控制命令与引擎选择前缀。
 * 在 cordis.yml 中移除本插件即可下线帮助命令。
 */
import type { Context } from "cordis";
import type { CommandHandler } from "../types.js";

const HELP_TEXT = [
  "/status 查看当前会话",
  "/team 查看当前 Agent 团队",
  "/new 开启一个全新的 CLI 会话",
  "/resume 选择当前工作目录中的 CLI 会话",
  "/compact [要求] 使用当前引擎原生整理上下文",
  "/cd 查看当前工作目录",
  "/cd <目录> 切换当前话题的工作目录",
  "/close 关闭当前会话",
  "/schedule add \"<周期>\" <任务> 创建定时任务",
  "/schedule list 查看定时任务",
  "/schedule remove <id> 删除定时任务",
  "/login 为当前引擎发起登录（也可用 /<引擎> login）",
  "/metrics 查看当前 Bot 与会话范围内的可观测性大盘",
  "/help 查看命令",
  "/claude <任务> 新话题使用 Claude Code",
  "/codex <任务> 新话题使用 Codex",
  "/dimagent <任务> 新话题使用 DimAgent",
].join("\n");

const handler: CommandHandler = async ({ bot, message, hasThread }) => {
  await bot.reply(message.messageId, HELP_TEXT, hasThread);
};

export const name = "commands/help";
export const inject = ["commands"];

export function apply(ctx: Context) {
  ctx.commands.register("help", handler);
}
