/**
 * /orchestrate 命令插件：接收一个大任务，交给 orchestration 服务拆解并并行派发。
 * 拆解与派发在后台进行，本命令只负责占位回复与启动；汇总由服务回复。
 * 服务访问经命令插件自己的 ctx（已 inject orchestration），不依赖 router 的注入，
 * 因此 orchestration 插件可独立下线。在 cordis.yml 中移除本插件即可下线该命令。
 */
import type { Context } from "cordis";
import { interactionPolicyOf } from "../../core/interaction-policy.js";
import type { CommandHandler } from "../types.js";

function createHandler(pluginCtx: Context): CommandHandler {
  return async ({
    bot,
    message,
    session,
    hasThread,
    command,
    botConfig,
    interaction: inputInteraction,
  }) => {
    const interaction = interactionPolicyOf({ interaction: inputInteraction });
    if (command.name !== "orchestrate") return;
    if (!interaction.capabilities.collaborateWithBots) {
      await bot.reply(
        message.messageId,
        interaction.mode === "standalone"
          ? "独立任务模式不会与其他 bot 互动，请 @Team Leader 开启团队模式。"
          : "私聊模式不会与其他 bot 互动，请在群聊或话题中 @Team Leader 开启团队模式。",
        hasThread,
      );
      return;
    }
    const prompt = command.prompt;
    if (!prompt) {
      await bot.reply(
        message.messageId,
        "用法：/orchestrate <大任务>。我会把任务拆成多个子任务，并行派发给团队成员。",
        hasThread,
      );
      return;
    }
    // 编排在后台进行：先回占位消息，拆解与派发完成后由服务回复汇总。
    pluginCtx.orchestration.startOrchestration({
      bot,
      botConfig,
      session,
      hasThread,
      message,
      prompt,
    });
    await bot.reply(
      message.messageId,
      "⏳ 正在拆解任务并派发子任务，请稍候…",
      hasThread,
    );
  };
}

export const name = "commands/orchestrate";
export const inject = ["commands", "orchestration"];

export function apply(ctx: Context) {
  ctx.commands.register("orchestrate", createHandler(ctx));
}
