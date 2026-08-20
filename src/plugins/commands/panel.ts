/**
 * /panel 命令插件：展示当前群聊和 bot 的编排运行进度汇总卡片。
 * 服务与卡片经命令插件自己的 ctx（已注入 orchestration/cards）访问。
 * 在 cordis.yml 中移除本插件即可下线 /panel。
 */
import type { Context } from "cordis";
import type { CommandHandler } from "../types.js";

function createHandler(pluginCtx: Context): CommandHandler {
  return async ({ bot, botConfig, message, hasThread }) => {
    await bot.replyCard(
      message.messageId,
      pluginCtx.cards.orchestrationPanel({
        // /panel 是按当前租户边界查询，不能把同一进程其他群聊或其他 bot 的
        // prompt/answer/error 汇总到当前会话。
        runs: pluginCtx.orchestration.list({
          chatId: message.chatId,
          botId: botConfig.id,
        }),
        // 重试按钮是否渲染由 orchestration/actions 插件决定（retryMax=0 即不渲染）。
        maxRetry: pluginCtx.orchestration.retryMax(),
      }),
      hasThread,
    );
  };
}

export const name = "commands/panel";
export const inject = ["commands", "orchestration", "cards"];

export function apply(ctx: Context) {
  ctx.commands.register("panel", createHandler(ctx));
}
