/**
 * /metrics 命令插件：按当前 Bot 与当前会话范围展示吞吐、Token、时延和链路记录，
 * 避免跨群或跨 Bot 泄露任务元数据。
 * 在 cordis.yml 中移除本插件即可下线 /metrics 命令。
 */
import type { Context } from "cordis";
import type { CommandHandler } from "../types.js";

function createHandler(pluginCtx: Context): CommandHandler {
  return async ({
    bot,
    botConfig,
    message,
    hasThread,
    command,
  }) => {
    // 命令 handler 在 router 的上下文被调用，而 router 未注入 observability；
    // 因此这里统一用插件自身 ctx（inject 已声明 observability），而不是 commandContext.ctx。
    const ctx = pluginCtx;
    const args = command.name === "metrics" ? (command.args ?? "") : "";
  const subCommand = args.trim().toLowerCase();
  const filter = { botId: botConfig.id, chatId: message.chatId };

  // /metrics traces：列出最近的 10 条 Trace 记录
  if (subCommand === "traces") {
    const traces = ctx.observability.getRecentTraces(10, filter);
    if (!traces.length) {
      await bot.reply(message.messageId, "暂无链路追踪记录。", hasThread);
      return;
    }
    const lines: string[] = ["🔍 **最近链路追踪（Top 10）**\n"];
    for (const t of traces) {
      const statusIcon =
        t.status === "ok"
          ? "✅"
          : t.status === "error"
            ? "❌"
            : t.status === "paused"
              ? "⏸️"
              : t.status === "cancelled"
                ? "⏹️"
                : "⏳";
      const duration =
        t.durationMs !== undefined
          ? `${(t.durationMs / 1000).toFixed(1)}s`
          : "-";
      const tokens = t.stats?.totalTokens
        ? `${t.stats.totalTokens.toLocaleString()} tokens`
        : "-";
      lines.push(
        [
          `${statusIcon} \`${t.traceId.slice(0, 8)}\` ［${t.botId ?? "bot"}·${t.cliEngine ?? "engine"}］`,
          `耗时 ${duration}`,
          tokens,
        ].join(" | "),
      );
    }
    await bot.reply(message.messageId, lines.join("\n"), hasThread);
    return;
  }

  // /metrics bot <botId>：特定 Bot 指标
  if (subCommand.startsWith("bot ")) {
    const targetBot = subCommand.slice(4).trim();
    if (targetBot !== botConfig.id) {
      await bot.reply(
        message.messageId,
        "只能查询当前 Bot 在当前会话范围内的指标。",
        hasThread,
      );
      return;
    }
    const summary = ctx.observability.getSummary(filter);
    const botStat = summary.byBot[targetBot];
    if (!botStat) {
      await bot.reply(
        message.messageId,
        `未找到 Bot \`${targetBot}\` 的运行记录。`,
        hasThread,
      );
      return;
    }
    const decidedTasks = botStat.successTasks + botStat.failedTasks;
    const lines: string[] = [
      `🤖 **Bot 指标：${targetBot}**`,
      `- 任务总数：${botStat.totalTasks}（✅ 成功 ${botStat.successTasks} / ❌ 失败 ${botStat.failedTasks}）`,
      `- 成功率：${decidedTasks ? Math.round((botStat.successTasks / decidedTasks) * 100) : 0}%`,
      `- 消耗 Token：${botStat.totalTokens.toLocaleString()}`,
      `- 平均耗时：${(botStat.avgDurationMs / 1000).toFixed(1)}s`,
    ];
    await bot.reply(message.messageId, lines.join("\n"), hasThread);
    return;
  }

  if (subCommand) {
    await bot.reply(
      message.messageId,
      "支持的用法：/metrics、/metrics traces、/metrics bot <当前 Bot ID>。",
      hasThread,
    );
    return;
  }

  // 默认：当前 Bot、当前群聊或私聊范围内的指标大盘
  const report = ctx.observability.formatSummaryMarkdown(filter);
  await bot.reply(message.messageId, report, hasThread);
  };
}

export const name = "commands/metrics";
export const inject = ["commands", "observability"];

export function apply(ctx: Context) {
  ctx.commands.register("metrics", createHandler(ctx));
}
