/**
 * /login 命令插件：为当前会话的执行引擎（或 "/<engine> login" 指定的引擎）
 * 发起登录卡片流程。命令本身不感知引擎细节——登录能力由 CliAdapter 的
 * login 协议声明，卡片收集与执行全部交给 auth 服务。
 * 在 cordis.yml 中移除本插件即可下线 /login；auth 插件一并移除时整体下线该能力。
 */
import type { Context } from "cordis";
import type { CommandHandler } from "../types.js";

const handler: CommandHandler = async ({
  ctx,
  bot,
  botConfig,
  message,
  session,
  hasThread,
  command,
}) => {
  const cliId =
    command.name === "login" && command.cliId ? command.cliId : session.cliId;
  const adapter = ctx.cli.get(cliId, session.accessMode ?? "headless");
  if (!adapter.login) {
    await bot.reply(
      message.messageId,
      `${adapter.displayName} 暂不支持卡片登录。`,
      hasThread,
    );
    return;
  }
  const result = await ctx.auth.requestLogin({
    bot,
    botConfig,
    session,
    replyToMessageId: message.messageId,
    hasThread,
    senderOpenId: message.senderOpenId,
  });
  if (!result.ok) {
    await bot.reply(message.messageId, result.message, hasThread);
  }
};

export const name = "commands/login";
export const inject = ["commands", "auth"];

export function apply(ctx: Context) {
  ctx.commands.register("login", handler);
}