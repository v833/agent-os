/**
 * router 路由插件：监听 bot/message 与 bot/card-action 事件，
 * 把协作识别、会话解析、命令派发和任务启动串成一条链路。
 * 斜杠命令交给 commands 服务，任务执行交给 tasks 服务，本插件只负责“往哪走”。
 */
import type { Context } from "cordis";
import {
  parseCliRequest,
  parseCommand,
} from "../core/command-parser.js";
import { ensureWorkspaceDirectory } from "../core/workspace.js";
import { topicTaskId } from "../core/topic-task.js";
import {
  extractResourceKeys,
  leadingMentionName,
  resolveMentions,
} from "../im/message-parser.js";
import type { CollaborationMessage } from "../core/collaboration.js";
import type { BotConfig } from "../core/bot-registry.js";
import type {
  Bot,
  CardAction,
  CardActionResponse,
  IncomingMessage,
} from "../im/lark.js";
import type {
  BotRuntime,
  CommandContext,
  StartTaskInput,
} from "./types.js";

/** 处理飞书卡片按钮回调，返回平台要展示的 toast / 卡片。 */
async function handleCardAction(
  ctx: Context,
  action: CardAction,
  botConfig: BotConfig,
): Promise<CardActionResponse | undefined> {
  if (action.value.action === "resume_cli_session") {
    const agentSessionId =
      typeof action.value.agentSessionId === "string"
        ? action.value.agentSessionId
        : "";
    const cliSessionId =
      typeof action.value.cliSessionId === "string"
        ? action.value.cliSessionId
        : "";
    const session = ctx.sessions.manager.get(agentSessionId);
    if (!session || session.botId !== botConfig.id || !cliSessionId) {
      return { toast: { type: "error", content: "这条会话记录已经失效。" } };
    }
    if (session.status === "active") {
      return {
        toast: { type: "warning", content: "当前任务结束后才能切换会话。" },
      };
    }
    if (session.status === "closed") {
      return {
        toast: { type: "warning", content: "当前话题的会话已经关闭。" },
      };
    }
    try {
      const sessionAdapter = ctx.cli.get(
        session.cliId,
        session.accessMode ?? "headless",
      );
      const nativeSessions = await ctx.cli.listNativeSessions({
        adapter: sessionAdapter,
        cwd: session.workspaceDir,
      });
      if (!nativeSessions.some((item) => item.id === cliSessionId)) {
        return {
          toast: {
            type: "error",
            content: "这个 CLI 会话已经不在当前工作目录中。",
          },
        };
      }
      const updated = await ctx.sessions.manager.setCliSessionId(
        session.id,
        cliSessionId,
      );
      return {
        toast: { type: "success", content: "已切换到选中的历史会话。" },
        card: {
          type: "raw",
          data: ctx.cards.resume({
            agentSessionId: updated.id,
            cliName: sessionAdapter.displayName,
            currentCliSessionId: updated.cliSessionId,
            sessions: nativeSessions,
          }),
        },
      };
    } catch (error) {
      return {
        toast: { type: "error", content: (error as Error).message },
      };
    }
  }

  if (action.value.action !== "abort_task") return undefined;
  const sessionId =
    typeof action.value.sessionId === "string" ? action.value.sessionId : "";
  const runId =
    typeof action.value.runId === "string" ? action.value.runId : "";
  const outcome = ctx.tasks.requestAbort(
    sessionId,
    runId,
    action.operatorOpenId,
  );

  if (outcome === "not_found") {
    return {
      toast: { type: "info", content: "任务已经结束，无需再次停止。" },
    };
  }
  if (outcome === "forbidden") {
    return {
      toast: { type: "warning", content: "只有任务发起人可以停止它。" },
    };
  }
  if (outcome === "already_stopping") {
    return { toast: { type: "info", content: "正在停止任务，请稍候。" } };
  }
  return { toast: { type: "success", content: "已发送停止指令。" } };
}

/** 处理一条入站消息：协作识别 → 会话解析 → 命令派发或任务启动。 */
async function handleMessage(
  ctx: Context,
  message: IncomingMessage,
  bot: Bot,
  botConfig: BotConfig,
): Promise<void> {
  const resolved = resolveMentions(message.text, message.mentions);
  let senderRuntime: BotRuntime | undefined;
  let collaboration: CollaborationMessage | undefined;
  if (message.senderType === "app" || message.senderType === "bot") {
    const currentRuntime = ctx.lark.bot(botConfig.id);
    const mentionedCurrentBot = currentRuntime
      ? message.mentions.some(
          (mention) => mention.openId === currentRuntime.identity.openId,
        )
      : false;
    const dispatchId = message.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
    const pending =
      message.messageType === "post" &&
      mentionedCurrentBot &&
      dispatchId
        ? ctx.collaboration.consume(dispatchId, botConfig.id)
        : undefined;
    if (!pending) {
      console.log(
        `[协作] 忽略非目标 bot 消息 sender=${message.senderOpenId} target=${botConfig.id}`,
      );
      return;
    }
    senderRuntime = ctx.lark.bot(pending.fromBotId);
    if (!senderRuntime) {
      console.log(`[协作] 找不到来源 bot: ${pending.fromBotId}`);
      return;
    }
    const turnKey = ctx.collaboration.turnKey(pending);
    if (ctx.collaboration.isTurnProcessed(turnKey)) {
      console.log(`[协作] 忽略重复消息 ${turnKey}`);
      return;
    }
    ctx.collaboration.markTurnProcessed(turnKey);
    collaboration = pending;
  }
  const hasThread = Boolean(message.threadId || message.rootId);
  const taskId = topicTaskId(message);
  const command = parseCommand(resolved);
  const cliRequest = parseCliRequest(
    resolved,
    leadingMentionName(message.text, message.mentions),
    // 引擎请求按注册表动态解析：新增引擎插件后无需改核心解析器白名单。
    ctx.cli.list().map((adapter) => adapter.id),
  );
  if (cliRequest && !cliRequest.prompt) {
    await bot.reply(
      message.messageId,
      `请在 /${cliRequest.cliId} 后面写下任务，例如：/${cliRequest.cliId} 检查项目状态`,
      hasThread,
    );
    return;
  }
  const selectedCliId = cliRequest?.cliId ?? botConfig.defaultCliId;
  // accessMode 是标准引擎属性，不再限定某个引擎；会话按 bot 声明持久化接入模式。
  const resolvedSession = await ctx.sessions.manager.resolve(
    message,
    selectedCliId,
    botConfig.id,
    collaboration?.workspaceDir ?? botConfig.workspaceDir,
    botConfig.accessMode ?? "headless",
  );
  let { session } = resolvedSession;
  const { isNew } = resolvedSession;
  if (command && isNew && session.status === "creating") {
    session = await ctx.sessions.manager.transition(session.id, "idle");
  }
  const cliAdapter = ctx.cli.get(session.cliId, session.accessMode ?? "headless");
  let requestedPrompt = collaboration?.prompt ?? cliRequest?.prompt ?? resolved;

  console.log(
    `[收到] chat=${message.chatId} threadId=${message.threadId} rootId=${message.rootId} sender=${message.senderOpenId}`,
  );
  console.log(`  原文: ${message.text}`);
  console.log(`  还原: ${resolved}`);
  console.log(
    `  mentions: ${message.mentions.map((mention) => `${mention.key}=${mention.name}(${mention.openId})`).join(", ") || "(无)"}`,
  );
  console.log(
    `  [会话] ${isNew ? "新建" : "复用"} id=${session.id} status=${session.status}`,
  );

  if (!isNew && cliRequest && cliRequest.cliId !== session.cliId) {
    await bot.reply(
      message.messageId,
      `当前话题已经在使用 ${cliAdapter.displayName}。如需切换执行引擎，请新开一个话题。`,
      hasThread,
    );
    return;
  }

  // 控制命令必须先于 active/closed 防御分支处理，否则执行中无法查询或关闭会话。
  if (command) {
    const handler = ctx.commands.get(command.name);
    if (!handler) {
      console.error(`[命令] 未注册的命令处理器: ${command.name}`);
      return;
    }
    const commandContext: CommandContext = {
      ctx,
      bot,
      botConfig,
      message,
      session,
      isNew,
      hasThread,
      resolvedText: resolved,
      cliRequest,
      command,
      cliAdapter,
    };
    await handler(commandContext);
    return;
  }

  if (session.status === "closed") {
    // closed 是终态，同一话题不能通过普通消息隐式重开。
    await bot.reply(
      message.messageId,
      "这个话题的会话已经关闭，请新开一个话题继续。",
      hasThread,
    );
    return;
  }
  if (!isNew && session.status === "creating") {
    // 首次写盘尚未完成时，后续消息只能等待，不能并发启动同一会话。
    await bot.reply(
      message.messageId,
      "当前会话正在准备，请稍后再追问。",
      hasThread,
    );
    return;
  }
  if (session.status === "active") {
    // 一个会话同一时刻只允许一个任务，避免卡片和会话上下文并发写入。
    await bot.reply(
      message.messageId,
      "当前会话还在执行，请等任务结束后再追问。",
      hasThread,
    );
    return;
  }

  const messageOutcome = !collaboration
    ? await ctx.serial("task/message", {
      bot,
      botConfig,
      message,
      taskId,
      requestedPrompt,
      })
    : undefined;
  if (messageOutcome) requestedPrompt = messageOutcome.requestedPrompt;
  if (collaboration && session.workspaceDir !== collaboration.workspaceDir) {
    await ensureWorkspaceDirectory(collaboration.workspaceDir);
    session = await ctx.sessions.manager.setWorkspaceDir(
      session.id,
      collaboration.workspaceDir,
    );
  }

  const startTaskInput: StartTaskInput = {
    bot,
    botConfig,
    session,
    hasThread,
    replyToMessageId: message.messageId,
    senderOpenId: message.senderOpenId,
    senderUnionId: message.senderUnionId,
    taskId,
    requestedPrompt,
    originalRequestedPrompt: messageOutcome?.originalRequestedPrompt,
    isCompacting: false,
    collaboration,
    senderRuntime,
    resources: extractResourceKeys(message.messageType, message.rawContent),
  };
  ctx.tasks.startTask(startTaskInput);
}

export const name = "router";
export const inject = [
  "config",
  "sessions",
  "cli",
  "lark",
  "cards",
  "commands",
  "tasks",
  "collaboration",
];

export function apply(ctx: Context) {
  ctx.on("bot/message", async (message, bot, botConfig) => {
    await handleMessage(ctx, message, bot, botConfig);
  });
  ctx.on("bot/card-action", async (action, _bot, botConfig) => {
    return handleCardAction(ctx, action, botConfig);
  });
}
