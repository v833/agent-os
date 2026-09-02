/**
 * /board 命令插件：支持飞书任务看板的一键全自动初始化 (/board init)、
 * 链接查询 (/board link)、状态大盘 (/board status) 与使用帮助 (/board help)。
 * 在 cordis.yml 中移除本插件即可下线 /board 命令。
 */
import type { Context } from "cordis";
import {
  bootstrapBitableBoard,
  createLarkBootstrapClient,
} from "../../core/bitable-bootstrap.js";
import type { CardAction, CardActionResponse, Bot } from "../../im/lark.js";
import type { BotConfig } from "../../core/bot-registry.js";
import type { CommandHandler } from "../types.js";

function parseInitArgs(argsString: string): { force: boolean; name: string } {
  const tokens = argsString.trim().split(/\s+/).filter(Boolean);
  const force = tokens.includes("--force") || tokens.includes("-f");
  const name = tokens.filter((token) => token !== "--force" && token !== "-f").join(" ") || "ThreadPilot 任务看板";
  return { force, name };
}

async function runBoardInit(
  ctx: Context,
  bot: Bot,
  botConfig: BotConfig,
  messageId: string,
  hasThread: boolean,
  name: string,
  chatId?: string,
): Promise<void> {
  if (!ctx.bitableBoard.beginInitialization()) {
    await bot.reply(messageId, "⏳ 当前已有任务看板正在初始化，请等待完成后再重试。", hasThread);
    return;
  }
  try {
    const progressCard = ctx.cards.boardInitProgress({ name });
    let progressMessageId: string | undefined;
    try {
      progressMessageId = await bot.replyCard(messageId, progressCard, hasThread);
    } catch {
      await bot.reply(messageId, `⏳ 正在初始化任务看板「${name}」…`, hasThread);
    }

    let createdApp: Awaited<ReturnType<typeof bootstrapBitableBoard>> | undefined;
    let mountedResult = false;
    try {
      const bootstrapClient = createLarkBootstrapClient(bot.client);
      const result = await bootstrapBitableBoard(bootstrapClient, { name });
      // 建表已成功：记录 appToken，mount 后续失败时仍能提示已创建的孤立表格。
      createdApp = result;
      await ctx.bitableBoard.mount({
        appToken: result.appToken,
        tableId: result.tableId,
        url: result.url,
        name: result.name,
        botId: botConfig.id,
        // 绑定初始化群作为反向拉起回退群聊，保证零配置记录也能开工。
        fallbackChatId: chatId,
        saveToStorage: true,
      });
      mountedResult = true;
      // 交互式初始化要求首次扫描成功：失败时展示降级卡片而非绿色就绪卡，
      // 避免用户误以为双向同步已可用。
      if (ctx.bitableBoard.getStatus().degraded) {
        const degradedCard = ctx.cards.boardDegraded({
          name: result.name,
          url: result.url,
          appToken: result.appToken,
          tableId: result.tableId,
        });
        if (progressMessageId) {
          try {
            await bot.updateCard(progressMessageId, degradedCard);
            return;
          } catch {
            // 更新失败回退到新回复。
          }
        }
        await bot.replyCard(messageId, degradedCard, hasThread);
        return;
      }
      const readyCard = ctx.cards.boardReady({
        name: result.name,
        url: result.url,
        appToken: result.appToken,
        tableId: result.tableId,
        kanbanViewId: result.kanbanViewId,
      });
      if (progressMessageId) {
        try {
          await bot.updateCard(progressMessageId, readyCard);
          return;
        } catch {
          // 更新卡片异常时回退到新回复。
        }
      }
      try {
        await bot.replyCard(messageId, readyCard, hasThread);
      } catch (error) {
        console.error("[看板] 就绪卡片发送失败，但看板已成功挂载:", (error as Error).message);
      }
    } catch (error) {
      // 建表和挂载已经成功时，后续卡片通知失败不能把成功状态改写成失败，
      // 否则用户重试会再创建一张看板。
      if (mountedResult) {
        console.error("[看板] 看板已挂载，但就绪通知失败:", (error as Error).message);
        return;
      }
      const errorMessage = (error as Error).message || "未知异常";
      const errorCard = ctx.cards.boardError({
        error: errorMessage,
        name,
        isPermissionError:
          errorMessage.includes("403") ||
          errorMessage.includes("bitable:app") ||
          errorMessage.includes("9999166"),
        // 表格已创建但挂载失败时提示已创建标识，避免重复建表。
        appToken: (error as { appToken?: string }).appToken ?? createdApp?.appToken,
      });
      if (progressMessageId) {
        try {
          await bot.updateCard(progressMessageId, errorCard);
          return;
        } catch {
          // 忽略更新失败。
        }
      }
      await bot.replyCard(messageId, errorCard, hasThread);
    }
  } finally {
    ctx.bitableBoard.endInitialization();
  }
}

function createHandler(pluginCtx: Context): CommandHandler {
  return async ({
  ctx: _commandCtx,
  bot,
  botConfig,
  message,
  hasThread,
  command,
  }) => {
  const ctx = pluginCtx;
  const args = command.name === "board" ? (command.args ?? "") : "";
  const rawArgs = args.trim();
  const [subCommand = "", ...rest] = rawArgs.split(/\s+/);
  const sub = subCommand.toLowerCase();
  const restArgs = rest.join(" ");

  // 1. /board init [--force] [看板名称]
  if (sub === "init") {
    const { force, name } = parseInitArgs(restArgs);

    // 防重冲突检测：如果已经挂载且未携带 --force，返回黄色冲突卡片
    if (ctx.bitableBoard.isMounted() && !force) {
      const storage = ctx.bitableBoard.getStorage();
      const conflictCard = ctx.cards.boardConflict({
        name: storage?.name || "任务看板",
        url: storage?.url || `https://feishu.cn/base/${storage?.appToken}`,
        tableId: storage?.tableId || "未知",
        // 保留用户请求的新名称，确认覆盖时用它创建。
        requestedName: name,
        appToken: storage?.appToken,
      });
      await bot.replyCard(message.messageId, conflictCard, hasThread);
      return;
    }

    await runBoardInit(ctx, bot, botConfig, message.messageId, hasThread, name, message.chatId);
    return;
  }

  // 2. /board link
  if (sub === "link") {
    if (!ctx.bitableBoard.isMounted()) {
      await bot.reply(
        message.messageId,
        "⚪ 当前尚未挂载多维表格任务看板。\n\n在群聊中发送 `/board init` 即可一键全自动创建并挂载。",
        hasThread,
      );
      return;
    }
    const storage = ctx.bitableBoard.getStorage();
    const name = storage?.name || "ThreadPilot 任务看板";
    const url = storage?.url || `https://feishu.cn/base/${storage?.appToken}`;
    const tableId = storage?.tableId || "未知";
    const lines = [
      `📊 **当前挂载的任务看板**`,
      `- **看板名称**：${name}`,
      `- **访问链接**：${url}`,
      `- **数据表 ID**：\`${tableId}\``,
      `- **更新时间**：${storage?.updatedAt || "未知"}`,
    ];
    await bot.reply(message.messageId, lines.join("\n"), hasThread);
    return;
  }

  // 3. /board status
  if (sub === "status") {
    const status = ctx.bitableBoard.getStatus();
    const lines = [
      `📈 **飞书任务看板运行状态**`,
      `- **挂载状态**：${status.mounted ? "✅ 已挂载运行中" : "⚪ 未挂载"}`,
      `- **服务状态**：${status.initializing ? "⏳ 初始化中" : status.degraded ? "🟠 降级" : "🟢 正常"}`,
      status.name ? `- **看板名称**：${status.name}` : "",
      status.url ? `- **访问链接**：${status.url}` : "",
      status.tableId ? `- **数据表 ID**：\`${status.tableId}\`` : "",
      `- **已关联任务数**：${status.indexedTasksCount}`,
      `- **已见表格记录数**：${status.seenRecordsCount}`,
      `- **待冲刷快照数**：${status.pendingSyncCount}`,
      `- **事件单向同步**：${status.syncEnabled ? "🟢 开启" : "🔴 关闭"}`,
      `- **待处理反向拉起**：${status.pullEnabled ? "🟢 开启" : "🔴 关闭"}`,
    ].filter(Boolean);
    await bot.reply(message.messageId, lines.join("\n"), hasThread);
    return;
  }

  // 4. /board 或 /board help
  const helpText = [
    `📋 **飞书任务看板命令指南 (/board)**`,
    "",
    "• `/board init [看板名称]`：一键自动创建多维表格、配置 10 个标准字段并挂载同步服务",
    "• `/board init --force [看板名称]`：覆盖已有挂载，强制重新初始化新看板",
    "• `/board link`：查看当前已关联的多维表格直达链接与 Table ID",
    "• `/board status`：查看任务看板同步与反向拉起运行状态",
    "• `/board help`：查看本帮助信息",
  ].join("\n");
  await bot.reply(message.messageId, helpText, hasThread);
  };
}

async function handleBoardCardAction(
  ctx: Context,
  action: CardAction,
  bot: Bot,
  botConfig: BotConfig,
): Promise<CardActionResponse | undefined> {
  const actionName = typeof action.value.action === "string" ? action.value.action : "";
  if (actionName === "board_status") {
    return {
      card: { type: "raw", data: ctx.cards.boardStatus(ctx.bitableBoard.getStatus()) },
    };
  }
  if (actionName === "board_force_init_confirm") {
    const storage = ctx.bitableBoard.getStorage();
    const requestedName =
      typeof action.value.name === "string" && action.value.name.trim()
        ? action.value.name.trim()
        : undefined;
    return {
      toast: { type: "warning", content: "请再次点击确认覆盖当前看板。" },
      card: {
        type: "raw",
        data: ctx.cards.boardConflict({
          name: storage?.name || "任务看板",
          url: storage?.url || `https://feishu.cn/base/${storage?.appToken}`,
          tableId: storage?.tableId || "未知",
          requestedName,
          appToken: storage?.appToken,
          confirm: true,
        }),
      },
    };
  }
  if (actionName === "board_force_init") {
    const storage = ctx.bitableBoard.getStorage();
    // 校验卡片对应的看板版本：若挂载已切换，旧卡片不得覆盖新看板。
    const cardAppToken =
      typeof action.value.appToken === "string" ? action.value.appToken : "";
    if (cardAppToken && storage && cardAppToken !== storage.appToken) {
      return { toast: { type: "error", content: "看板已变更，请重新执行 /board init 确认。" } };
    }
    const name = typeof action.value.name === "string" && action.value.name.trim()
      ? action.value.name.trim()
      : "ThreadPilot 任务看板";
    // 覆盖场景沿用当前看板绑定的回退群聊，避免新表失去反向拉起目标群。
    const fallbackChatId = storage?.fallbackChatId;
    await runBoardInit(ctx, bot, botConfig, action.messageId, false, name, fallbackChatId);
    return { toast: { type: "success", content: "已开始覆盖创建任务看板。" } };
  }
  if (actionName === "board_retry_init") {
    const storage = ctx.bitableBoard.getStorage();
    const cardAppToken =
      typeof action.value.appToken === "string" ? action.value.appToken : "";
    // 当前已挂载看板且错误卡没有对应版本令牌（或令牌不匹配）：拒绝重试，
    // 避免旧错误卡绕过 PRD 要求的二次冲突确认，覆盖已挂载的新看板。
    if (storage && (!cardAppToken || cardAppToken !== storage.appToken)) {
      return { toast: { type: "error", content: "看板已变更，请重新执行 /board init 确认。" } };
    }
    const name = typeof action.value.name === "string" && action.value.name.trim()
      ? action.value.name.trim()
      : "ThreadPilot 任务看板";
    const fallbackChatId = storage?.fallbackChatId;
    await runBoardInit(ctx, bot, botConfig, action.messageId, false, name, fallbackChatId);
    return { toast: { type: "success", content: "已开始重试初始化任务看板。" } };
  }
  return undefined;
}

export const name = "commands/board";
export const inject = ["commands", "cards", "bitableBoard", "config", "lark"];

export function apply(ctx: Context) {
  ctx.commands.register("board", createHandler(ctx));
  ctx.on("bot/card-action", (action, bot, botConfig) =>
    handleBoardCardAction(ctx, action, bot, botConfig),
  );
}
