/**
 * /compact 命令插件：用当前引擎的原生协议整理上下文，
 * 复用任务编排启动一张“整理上下文”卡片。在 cordis.yml 中移除本插件即可下线 /compact。
 */
import type { Context } from "cordis";
import { interactionPolicyOf } from "../../core/interaction-policy.js";
import type { CommandHandler } from "../types.js";

const handler: CommandHandler = async ({
  ctx,
  bot,
  botConfig,
  message,
  session,
  hasThread,
  command,
  resolvedText,
  cliAdapter,
  interaction: inputInteraction,
}) => {
  const interaction = interactionPolicyOf({ interaction: inputInteraction });
  // 能力探测：adapter 未实现原生 compact（buildCompactPlan 抛错）时直接提示，
  // 不按引擎 id 特判——新增引擎自动获得正确行为。
  try {
    cliAdapter.buildCompactPlan(session.cliSessionId ?? "");
  } catch {
    await bot.reply(
      message.messageId,
      `${cliAdapter.displayName} 暂不支持从 ThreadPilot 调用原生 /compact，请直接发起整理任务。`,
      hasThread,
    );
    return;
  }
  if (session.status === "active") {
    await bot.reply(
      message.messageId,
      "当前任务结束后才能整理上下文。",
      hasThread,
    );
    return;
  }
  if (session.status === "closed") {
    await bot.reply(message.messageId, "当前话题的会话已经关闭。", hasThread);
    return;
  }
  if (!session.cliSessionId) {
    await bot.reply(
      message.messageId,
      "当前还没有可整理的 CLI 会话。先完成一次任务，再使用 /compact。",
      hasThread,
    );
    return;
  }
  const started = await ctx.tasks.startTask({
    bot,
    botConfig,
    session,
    hasThread,
    replyToMessageId: message.messageId,
    senderOpenId: message.senderOpenId,
    interaction,
    requestedPrompt: resolvedText,
    isCompacting: true,
    compactInstructions:
      command.name === "compact" ? command.instructions : undefined,
    resources: [],
  });
  if (!started) {
    const latestStatus = ctx.sessions.manager.get(session.id)?.status;
    const detail = latestStatus === "active"
      ? "当前任务结束后才能整理上下文。"
      : latestStatus === "closed"
        ? "当前话题的会话已经关闭。"
        : "上下文整理未能启动，请稍后重试。";
    await bot.reply(message.messageId, detail, hasThread);
  }
};

export const name = "commands/compact";
export const inject = ["commands", "tasks", "sessions"];

export function apply(ctx: Context) {
  ctx.commands.register("compact", handler);
}
