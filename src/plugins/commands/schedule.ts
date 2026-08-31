/**
 * /schedule 命令插件：创建、查看与删除定时任务。
 * 在 cordis.yml 中移除本插件即可下线 /schedule 命令，不影响调度执行本身。
 */
import type { Context } from "cordis";
import { interactionPolicyOf } from "../../core/interaction-policy.js";
import type { CommandHandler } from "../types.js";

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatPrompt(prompt: string, maxLength = 24): string {
  if (prompt.length <= maxLength) return prompt;
  return `${prompt.slice(0, maxLength)}…`;
}

const handler: CommandHandler = async ({
  ctx,
  bot,
  message,
  session,
  hasThread,
  command,
  botConfig,
  interaction: inputInteraction,
}) => {
  const interaction = interactionPolicyOf({ interaction: inputInteraction });
  if (command.name !== "schedule") return;

  if (command.action === "add") {
    try {
      const task = await ctx.schedule.register({
        schedule: command.schedule,
        prompt: command.prompt,
        botId: botConfig.id,
        chatId: message.chatId,
        threadId: message.threadId,
        rootId: message.rootId,
        messageId: message.messageId,
        cliId: session.cliId,
        accessMode: session.accessMode ?? "headless",
        workspaceDir: session.workspaceDir,
        ownerOpenId: message.senderOpenId,
        interaction,
      });
      const next = ctx.schedule.nextRunAt(task.id);
      await bot.reply(
        message.messageId,
        `已创建定时任务 #${task.id}（${task.display}）\n下次触发：${next ? formatTime(next) : "（待计算）"}`,
        hasThread,
      );
    } catch (error) {
      await bot.reply(
        message.messageId,
        `创建失败：${(error as Error).message}`,
        hasThread,
      );
    }
    return;
  }

  if (command.action === "list") {
    const tasks = ctx.schedule
      .list()
      .filter((task) => task.botId === botConfig.id);
    if (!tasks.length) {
      await bot.reply(
        message.messageId,
        "当前没有定时任务。用 `/schedule add \"每 30 分钟\" <任务>` 创建一个。",
        hasThread,
      );
      return;
    }
    const lines = tasks.map((task) => {
      const next = ctx.schedule.nextRunAt(task.id);
      return `#${task.id}  ${task.display}  ${formatPrompt(task.prompt)}  下次触发 ${next ? formatTime(next) : "（已停用）"}`;
    });
    await bot.reply(message.messageId, lines.join("\n"), hasThread);
    return;
  }

  const removed = await ctx.schedule.remove(command.id);
  await bot.reply(
    message.messageId,
    removed
      ? `已删除 #${command.id}`
      : `找不到定时任务 #${command.id}。用 \`/schedule list\` 查看现有任务。`,
    hasThread,
  );
};

export const name = "commands/schedule";
export const inject = ["commands", "schedule"];

export function apply(ctx: Context) {
  ctx.commands.register("schedule", handler);
}
