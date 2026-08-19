/**
 * /panel 命令插件：展示当前所有编排运行的并行子任务进度汇总卡片。
 * 服务与卡片经命令插件自己的 ctx（已注入 orchestration/cards）访问。
 * 在 cordis.yml 中移除本插件即可下线 /panel。
 */
import type { Context } from "cordis";
import type { CommandHandler } from "../types.js";

function createHandler(pluginCtx: Context): CommandHandler {
  return async ({ bot, message, hasThread }) => {
    await bot.replyCard(
      message.messageId,
      pluginCtx.cards.orchestrationPanel({
        runs: pluginCtx.orchestration.list(),
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
