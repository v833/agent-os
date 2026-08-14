/**
 * Agent OS 进程入口：把飞书消息接入会话模型、控制命令、资源下载、
 * 原生会话管理、真实 CLI 调度、任务卡片和 bot 间同话题交接，并维护“每台 bot 在一个飞书话题对应一个会话”。
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import {
  getCliAdapter,
  listCliAdapters,
} from "./cli/registry.js";
import { CliRunError, runCliWithTransientRetry } from "./cli/runner.js";
import type { CliAdapter } from "./cli/types.js";
import { compactCliSession } from "./cli/native-compact.js";
import { listNativeCliSessions } from "./cli/native-sessions.js";
import { parseCliRequest, parseCommand } from "./core/command-parser.js";
import {
  buildBotPrompt,
  loadBotConfigs,
  type BotConfig,
} from "./core/bot-registry.js";
import {
  isRetryRequest,
  resolveRetryPrompt,
  SessionManager,
  type Session,
} from "./core/session-manager.js";
import {
  CollaborationInbox,
  collaborationTurnKey,
  type CollaborationMessage,
} from "./core/collaboration.js";
import { JsonSessionStore } from "./core/session-store.js";
import { requestTaskAbort, type ActiveRun } from "./core/task-abort.js";
import { TaskProgressTracker } from "./core/task-progress.js";
import {
  ensureWorkspaceDirectory,
  resolveWorkspacePath,
} from "./core/workspace.js";
import {
  answerContinuation,
  answerNeedsContinuation,
  buildResumeCard,
  buildCollaborationCard,
  buildSessionNoticeCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from "./im/card.js";
import {
  startBot,
  type Bot,
  type BotIdentity,
} from "./im/lark.js";
import {
  extractResourceKeys,
  leadingMentionName,
  resolveMentions,
} from "./im/message-parser.js";

const botConfigPath = resolve(
  process.env.BOTS_CONFIG ?? join("config", "bots.json"),
);
const botConfigs = await loadBotConfigs(botConfigPath);
await Promise.all(
  botConfigs.map((config) => ensureWorkspaceDirectory(config.workspaceDir)),
);
const defaultWorkspaces = Object.fromEntries(
  botConfigs.map((config) => [config.id, config.workspaceDir]),
);

// 启动消息长连接前先恢复会话，避免恢复期间收到消息并创建重复映射。
const sessions = await SessionManager.open({
  store: new JsonSessionStore(
    join("data", "sessions.json"),
    botConfigs[0].id,
    defaultWorkspaces,
  ),
});
// 每轮运行额外记录发起人和唯一 ID，供卡片按钮鉴权并隔离旧卡片。
const activeRuns = new Map<string, ActiveRun>();
// Claude 的模型窗口通常到本轮结束才返回，按会话记忆后供下一轮实时展示。
const contextWindows = new Map<string, number>();
interface BotRuntime {
  config: BotConfig;
  bot: Bot;
  identity: BotIdentity;
}

// 运行时身份用于真实 @，交接单只在当前进程内保存待领取任务。
const botRuntimes = new Map<string, BotRuntime>();
const processedCollaborationTurns = new Set<string>();
const collaborationInbox = new CollaborationInbox();

console.log("Agent OS 启动，正在建立飞书长连接…");
console.log(
  `[配置] 已注册 ${botConfigs.length} 个 bot，已恢复 ${sessions.size} 个会话`,
);
for (const adapter of listCliAdapters()) {
  console.log(`[CLI] id=${adapter.id} command=${adapter.command}`);
}
for (const config of botConfigs) {
  console.log(
    `[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId} access_mode=${config.accessMode} workspace=${config.workspaceDir}`,
  );
}

function getSessionAdapter(session: Session): CliAdapter {
  return getCliAdapter(session.cliId, session.accessMode ?? "headless");
}

function executeCli(
  adapter: CliAdapter,
  prompt: string,
  workspaceDir: string,
  cliSessionId: string | undefined,
  signal: AbortSignal,
  onEvent: Parameters<typeof runCliWithTransientRetry>[0]["onEvent"],
) {
  console.log(
    `[CLI] 启动 engine=${adapter.id} access_mode=${adapter.accessMode} cwd=${workspaceDir}`,
  );
  return runCliWithTransientRetry({
    adapter,
    prompt,
    cwd: workspaceDir,
    sessionId: cliSessionId,
    signal,
    onEvent,
  });
}

async function markSessionIdle(sessionId: string): Promise<void> {
  // /close 可能与后台 finally 同时发生；已关闭会话不能被迟到的清理逻辑改回 idle。
  if (sessions.get(sessionId)?.status !== "active") return;
  await sessions.transition(sessionId, "idle");
  console.log(`[会话] id=${sessionId} status=idle`);
}

const STATUS_LABELS: Record<Session["status"], string> = {
  creating: "创建中",
  active: "执行中",
  idle: "空闲",
  closed: "已关闭",
};

function formatSessionStatus(session: Session, botId: string): string {
  const adapter = getSessionAdapter(session);
  return [
    `机器人：${botId}`,
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${adapter.displayName}`,
    `接入模式：${adapter.accessMode}`,
    `CLI 会话：${session.cliSessionId ?? "(尚未建立)"}`,
    `工作目录：${session.workspaceDir}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join("\n");
}

/** 登记交接单、发送说明卡片和真实提及；任一步出错都会撤销待领取记录。 */
async function sendCollaborationMessage(options: {
  senderConfig: BotConfig;
  senderBot: Bot;
  replyToMessageId: string;
  targetBotId: string;
  taskId: string;
  round: number;
  maxRounds: number;
  workspaceDir: string;
  prompt: string;
}): Promise<void> {
  const target = botRuntimes.get(options.targetBotId);
  if (!target) {
    throw new Error(`协作 bot 尚未就绪: ${options.targetBotId}`);
  }

  const collaboration: CollaborationMessage = {
    dispatchId: randomUUID().replaceAll("-", "").slice(0, 12),
    taskId: options.taskId,
    fromBotId: options.senderConfig.id,
    toBotId: options.targetBotId,
    round: options.round,
    maxRounds: options.maxRounds,
    workspaceDir: options.workspaceDir,
    prompt: options.prompt,
  };
  collaborationInbox.register(collaboration);
  try {
    const senderName =
      botRuntimes.get(options.senderConfig.id)?.identity.name ??
      options.senderConfig.id;
    const cardMessageId = await options.senderBot.replyCard(
      options.replyToMessageId,
      buildCollaborationCard({
        senderName,
        targetName: target.identity.name,
        workspaceName: basename(options.workspaceDir),
        prompt: options.prompt,
        round: options.round,
        maxRounds: options.maxRounds,
      }),
      true,
    );
    if (!cardMessageId) {
      throw new Error("飞书没有返回协作卡片 message_id");
    }

    const mentionMessageId = await options.senderBot.replyMention(
      cardMessageId,
      target.identity,
      options.round === 1
        ? `新的代码审查任务（任务编号：${collaboration.dispatchId}），请查看上方卡片。`
        : `审查反馈已经返回（任务编号：${collaboration.dispatchId}），请查看上方卡片。`,
      true,
    );
    if (!mentionMessageId) {
      throw new Error("飞书没有返回协作通知 message_id");
    }
  } catch (error) {
    collaborationInbox.consume(collaboration.dispatchId, collaboration.toBotId);
    throw error;
  }

  console.log(
    `[协作] task=${options.taskId} ${options.senderConfig.id} -> ${options.targetBotId} round=${options.round}/${options.maxRounds}`,
  );
}

/** 给来源 bot 或普通消息发起人发送完成提醒；通知失败不影响任务结果。 */
async function sendResultNotification(options: {
  bot: Bot;
  replyToMessageId: string;
  target: BotIdentity;
  text: string;
  replyInThread: boolean;
}): Promise<void> {
  try {
    await options.bot.replyMention(
      options.replyToMessageId,
      options.target,
      options.text,
      options.replyInThread,
    );
  } catch (error) {
    console.error("[通知] 结果通知发送失败:", (error as Error).message);
  }
}

async function startConfiguredBot(config: BotConfig): Promise<void> {
  const startedBot = startBot({
    appId: config.appId,
    appSecret: config.appSecret,
    onCardAction: async (action) => {
    if (action.value.action === "resume_cli_session") {
      const agentSessionId =
        typeof action.value.agentSessionId === "string"
          ? action.value.agentSessionId
          : "";
      const cliSessionId =
        typeof action.value.cliSessionId === "string"
          ? action.value.cliSessionId
          : "";
      const session = sessions.get(agentSessionId);
      if (!session || session.botId !== config.id || !cliSessionId) {
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
        const sessionAdapter = getSessionAdapter(session);
        const nativeSessions = await listNativeCliSessions({
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
        const updated = await sessions.setCliSessionId(
          session.id,
          cliSessionId,
        );
        return {
          toast: { type: "success", content: "已切换到选中的历史会话。" },
          card: {
            type: "raw",
            data: buildResumeCard({
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
    const outcome = requestTaskAbort(
      activeRuns,
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
    },
    onMessage: async (message, bot) => {
    const resolved = resolveMentions(message.text, message.mentions);
    let senderRuntime: BotRuntime | undefined;
    let collaboration: CollaborationMessage | undefined;
    if (message.senderType === "app" || message.senderType === "bot") {
      const currentRuntime = botRuntimes.get(config.id);
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
          ? collaborationInbox.consume(dispatchId, config.id)
          : undefined;
      if (!pending) {
        console.log(
          `[协作] 忽略非目标 bot 消息 sender=${message.senderOpenId} target=${config.id}`,
        );
        return;
      }
      senderRuntime = botRuntimes.get(pending.fromBotId);
      if (!senderRuntime) {
        console.log(`[协作] 找不到来源 bot: ${pending.fromBotId}`);
        return;
      }
      const turnKey = collaborationTurnKey(pending);
      if (processedCollaborationTurns.has(turnKey)) {
        console.log(`[协作] 忽略重复消息 ${turnKey}`);
        return;
      }
      processedCollaborationTurns.add(turnKey);
      collaboration = pending;
    }
    const hasThread = Boolean(message.threadId || message.rootId);
    const command = parseCommand(resolved);
    const cliRequest = parseCliRequest(
      resolved,
      leadingMentionName(message.text, message.mentions),
    );
    if (cliRequest && !cliRequest.prompt) {
      await bot.reply(
        message.messageId,
        `请在 /${cliRequest.cliId} 后面写下任务，例如：/${cliRequest.cliId} 检查项目状态`,
        hasThread,
      );
      return;
    }
    const selectedCliId = cliRequest?.cliId ?? config.defaultCliId;
    const resolvedSession = await sessions.resolve(
      message,
      selectedCliId,
      config.id,
      collaboration?.workspaceDir ?? config.workspaceDir,
      selectedCliId === "dimagent" ? config.accessMode : "headless",
    );
    let { session } = resolvedSession;
    const { isNew } = resolvedSession;
    if (command && isNew && session.status === "creating") {
      session = await sessions.transition(session.id, "idle");
    }
    const cliAdapter = getSessionAdapter(session);
    const requestedPrompt = collaboration?.prompt ?? cliRequest?.prompt ?? resolved;

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
    if (command?.name === "help") {
      await bot.reply(
        message.messageId,
        [
          "/status 查看当前会话",
          "/new 开启一个全新的 CLI 会话",
          "/resume 选择当前工作目录中的 CLI 会话",
          "/compact [要求] 使用当前引擎原生整理上下文",
          "/cd 查看当前工作目录",
          "/cd <目录> 切换当前话题的工作目录",
          "/close 关闭当前会话",
          "/help 查看命令",
          "/claude <任务> 新话题使用 Claude Code",
          "/codex <任务> 新话题使用 Codex",
          "/mastra <任务> 新话题使用 Mastra Agent",
          "/dimagent <任务> 新话题使用 DimAgent",
        ].join("\n"),
        hasThread,
      );
      return;
    }

    if (command?.name === "new") {
      if (session.status === "active") {
        await bot.reply(
          message.messageId,
          "当前任务结束后才能新建会话。",
          hasThread,
        );
        return;
      }
      if (session.status === "closed") {
        await bot.reply(
          message.messageId,
          "当前话题的会话已经关闭。",
          hasThread,
        );
        return;
      }
      await sessions.clearCliSessionId(session.id);
      await bot.replyCard(
        message.messageId,
        buildSessionNoticeCard({
          title: "新会话已就绪",
          template: "green",
          detail: `下一条任务会由 ${cliAdapter.displayName} 开启全新的 CLI 会话。\n\n旧会话仍然保留，可以随时用 \`/resume\` 找回来。`,
        }),
        hasThread,
      );
      return;
    }

    if (command?.name === "resume") {
      if (session.status === "active") {
        await bot.reply(
          message.messageId,
          "当前任务结束后才能切换会话。",
          hasThread,
        );
        return;
      }
      if (session.status === "closed") {
        await bot.reply(
          message.messageId,
          "当前话题的会话已经关闭。",
          hasThread,
        );
        return;
      }
      try {
        const nativeSessions = await listNativeCliSessions({
          adapter: cliAdapter,
          cwd: session.workspaceDir,
        });
        await bot.replyCard(
          message.messageId,
          buildResumeCard({
            agentSessionId: session.id,
            cliName: cliAdapter.displayName,
            currentCliSessionId: session.cliSessionId,
            sessions: nativeSessions,
          }),
          hasThread,
        );
      } catch (error) {
        await bot.reply(
          message.messageId,
          `无法读取 ${cliAdapter.displayName} 会话：${(error as Error).message}`,
          hasThread,
        );
      }
      return;
    }

    const isCompacting = command?.name === "compact";
    const compactInstructions =
      command && command.name === "compact" ? command.instructions : undefined;
    if (isCompacting) {
      // Mastra 没有原生会话上下文，/compact 对它没有语义，直接提示。
      if (session.cliId === "mastra") {
        await bot.reply(
          message.messageId,
          "Mastra 引擎没有独立的会话上下文，不需要 /compact。直接发起新任务即可。",
          hasThread,
        );
        return;
      }
      if (session.cliId === "dimagent") {
        await bot.reply(
          message.messageId,
          "DimAgent 暂不支持从 Agent OS 调用原生 /compact，请直接发起整理任务。",
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
        await bot.reply(
          message.messageId,
          "当前话题的会话已经关闭。",
          hasThread,
        );
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
    }

    if (command?.name === "status") {
      await bot.reply(
        message.messageId,
        formatSessionStatus(session, config.id),
        hasThread,
      );
      return;
    }

    if (command?.name === "cd") {
      if (!command.path) {
        await bot.reply(
          message.messageId,
          `当前工作目录：${session.workspaceDir}`,
          hasThread,
        );
        return;
      }
      if (session.status === "active") {
        await bot.reply(
          message.messageId,
          "当前任务仍在执行，结束后再切换工作目录。",
          hasThread,
        );
        return;
      }
      try {
        const workspaceDir = resolveWorkspacePath(
          command.path,
          session.workspaceDir,
        );
        await ensureWorkspaceDirectory(workspaceDir);
        const changed = workspaceDir !== session.workspaceDir;
        session = await sessions.setWorkspaceDir(session.id, workspaceDir);
        await bot.reply(
          message.messageId,
          changed
            ? `工作目录已切换到：${workspaceDir}\n下一条任务会在这里建立新的 CLI 会话。`
            : `当前工作目录已经是：${workspaceDir}`,
          hasThread,
        );
      } catch (error) {
        await bot.reply(
          message.messageId,
          `无法切换工作目录：${(error as Error).message}`,
          hasThread,
        );
      }
      return;
    }

    if (command?.name === "close") {
      // 先发取消信号，再关闭状态；后台任务看到信号后会停止卡片刷新。
      const active = activeRuns.get(session.id);
      if (active) {
        active.cancelMode = "close";
        active.controller.abort();
      }
      if (session.status !== "closed") {
        await sessions.transition(session.id, "closed");
      }
      await bot.reply(
        message.messageId,
        "当前会话已关闭。需要继续时，请新开一个话题。",
        hasThread,
      );
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

    if (
      collaboration &&
      session.workspaceDir !== collaboration.workspaceDir
    ) {
      await ensureWorkspaceDirectory(collaboration.workspaceDir);
      session = await sessions.setWorkspaceDir(
        session.id,
        collaboration.workspaceDir,
      );
    }

    // 503 等错误可能发生在 CLI 返回会话 ID 之前；先保存实际任务，明确重试时才能重放。
    // 先用未包装的原始指令识别“继续执行”，避免角色前缀破坏重试判断。
    const prompt = buildBotPrompt(
      config.systemPrompt,
      resolveRetryPrompt(session, requestedPrompt),
    );
    // “继续执行”只消费原始待重试指令，不能把它覆盖成恢复失败后的短语。
    if (
      !isCompacting &&
      (!session.retryPrompt || !isRetryRequest(requestedPrompt))
    ) {
      await sessions.setRetryPrompt(session.id, requestedPrompt);
    }
    await sessions.transition(session.id, "active");
    const run = new AbortController();
    const activeRun: ActiveRun = {
      controller: run,
      ownerOpenId: message.senderOpenId,
      runId: randomUUID(),
    };
    activeRuns.set(session.id, activeRun);
    const taskTitle = isCompacting ? "整理上下文" : cliAdapter.displayName;

    const resources = extractResourceKeys(
      message.messageType,
      message.rawContent,
    );
    for (const resource of resources) {
      try {
        const savePath = await bot.downloadResource(
          message.messageId,
          resource.key,
          resource.type,
          join("data", "downloads"),
          resource.fileName,
        );
        console.log(`  [下载] ${resource.type} → ${savePath}`);
      } catch (error) {
        console.error(
          `  [下载失败] ${resource.key}:`,
          (error as Error).message,
        );
      }
    }

    // /close 可能在附件下载期间到达；关闭后不能再发送卡片或启动 CLI。
    if (run.signal.aborted) {
      if (activeRuns.get(session.id) === activeRun) activeRuns.delete(session.id);
      return;
    }

    let cardId: string | undefined;
    try {
      cardId = await bot.replyCard(
        message.messageId,
        buildTaskCard({
          title: taskTitle,
          status: "running",
          detail: isCompacting
            ? cliAdapter.id === "codex" && compactInstructions
              ? "Codex 正在使用原生默认策略整理上下文"
              : `正在调用 ${cliAdapter.displayName} 原生上下文整理`
            : "正在理解任务",
          abortSessionId: session.id,
          abortRunId: activeRun.runId,
        }),
        hasThread,
      );
    } catch (error) {
      // 任务尚未真正启动；创建卡片失败时必须撤销 active 状态，允许用户重试。
      if (activeRuns.get(session.id) === activeRun) activeRuns.delete(session.id);
      await markSessionIdle(session.id);
      throw error;
    }

    if (!cardId) {
      console.error("[卡片] 响应里没有 message_id，无法继续更新");
      // 飞书成功响应也可能缺少 ID，此时同样按启动失败回收会话状态。
      if (activeRuns.get(session.id) === activeRun) activeRuns.delete(session.id);
      await markSessionIdle(session.id);
      return;
    }
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

    const progress = new TaskProgressTracker(
      Date.now,
      contextWindows.get(session.id),
      !session.cliSessionId,
    );
    let observedCliSessionId = session.cliSessionId;
    let pendingCliSessionSave: Promise<void> | undefined;
    const rememberCliSession = async (cliSessionId: string) => {
      observedCliSessionId = cliSessionId;
      if (sessions.get(session.id)?.cliSessionId === cliSessionId) {
        await pendingCliSessionSave;
        return;
      }
      const save = sessions.setCliSessionId(session.id, cliSessionId);
      pendingCliSessionSave = save.then(() => undefined);
      await pendingCliSessionSave;
    };
    const cardUpdater = new ThrottledCardUpdater(async (card) => {
      try {
        await bot.updateCard(cardId, card);
      } catch (error) {
        console.error("[卡片] 更新失败:", (error as Error).message);
        throw error;
      }
    });
    const renderProgress = (snapshot = progress.snapshot()) => {
      cardUpdater.push(
        buildTaskCard({
          title: taskTitle,
          status: "running",
          detail: isCompacting
            ? `正在调用 ${cliAdapter.displayName} 原生上下文整理`
            : snapshot.current,
          ...(!isCompacting ? { progress: snapshot } : {}),
          abortSessionId: session.id,
          abortRunId: activeRun.runId,
        }),
      );
    };
    const finishCancelled = async () => {
      console.log(`[CLI] 任务已取消 engine=${session.cliId}`);
      await cardUpdater.finish(
        buildTaskCard({
          title: taskTitle,
          status: "cancelled",
          detail:
            activeRun.cancelMode === "close"
              ? "本次任务已停止，当前会话已经关闭。"
              : isCompacting
                ? "整理已停止，当前 CLI 会话没有改变。"
                : "本次任务已停止。你可以继续在当前话题里提问。",
          ...(!isCompacting ? { progress: progress.snapshot() } : {}),
        }),
      );
    };
    // 没有新事件时心跳仍会推进耗时；节流器确保最终每秒最多一次 patch。
    const progressHeartbeat = setInterval(renderProgress, 1_000);
    progressHeartbeat.unref();

    // 不等待 CLI，确保长连接仍能接收 /status 和 /close 等控制消息。
    const execution = isCompacting
      ? compactCliSession({
          adapter: cliAdapter,
          sessionId: session.cliSessionId!,
          cwd: session.workspaceDir,
          instructions: compactInstructions,
          signal: run.signal,
        }).then((result) => ({
          answer: result.message ?? "",
          sessionId: result.sessionId,
          stats: undefined,
        }))
      : executeCli(
          cliAdapter,
          prompt,
          session.workspaceDir,
          session.cliSessionId,
          run.signal,
          (event) => {
            if (event.type === "session") {
              // 会话 ID 先于最终结果到达；立即写入，任务被停止或进程重启后仍可 resume。
              void rememberCliSession(event.sessionId).catch((error) => {
                console.error(
                  "[会话] 保存实时 CLI 会话 ID 失败:",
                  (error as Error).message,
                );
              });
              return;
            }
            if (
              event.type !== "tool_start" &&
              event.type !== "tool_end" &&
              event.type !== "context"
            ) {
              return;
            }

            const snapshot = progress.accept(event);
            const currentDetail = snapshot.currentDetail
              ? ` detail=${snapshot.currentDetail}`
              : "";
            const context =
              snapshot.contextUsedTokens === undefined
                ? ""
                : ` context=${snapshot.contextUsedTokens}`;
            console.log(
              `[进度] ${snapshot.current}${currentDetail} tools=${snapshot.completedCount}/${snapshot.toolCount}${context}`,
            );
            renderProgress(snapshot);
          },
        );

    void execution
      .then(async (result) => {
        clearInterval(progressHeartbeat);
        if (!isCompacting && result.sessionId) {
          await rememberCliSession(result.sessionId);
        }
        // /close、按钮和子进程退出可能竞态；取消后只能写灰色终态。
        if (run.signal.aborted) {
          await finishCancelled();
          return;
        }
        if (!isCompacting && result.stats?.contextWindowTokens) {
          contextWindows.set(session.id, result.stats.contextWindowTokens);
        }
        if (!isCompacting) {
          await sessions.setRetryPrompt(session.id, undefined);
        }
        await cardUpdater.finish(
          isCompacting
            ? buildSessionNoticeCard({
                title: result.answer ? "暂时无需整理" : "上下文已整理",
                template: result.answer ? "grey" : "green",
                detail:
                  result.answer ||
                  [
                    `${cliAdapter.displayName} 已在当前 CLI 会话内完成原生压缩。`,
                    "CLI 会话 ID 保持不变，下一条任务会继续使用整理后的上下文。",
                  ].join("\n\n"),
              })
            : buildTaskCard({
                title: taskTitle,
                status: "success",
                detail: "执行完成",
                progress: progress.snapshot(),
                answer: result.answer,
                stats: result.stats,
              }),
        );
        if (!isCompacting && answerNeedsContinuation(result.answer)) {
          for (const chunk of splitLongText(answerContinuation(result.answer))) {
            if (run.signal.aborted) break;
            await bot.reply(message.messageId, chunk, hasThread);
          }
        }
        console.log(
          `[CLI] ${cliAdapter.id} 完成 session_id=${result.sessionId ?? "(无)"}`,
        );
        if (!collaboration) {
          await sendResultNotification({
            bot,
            replyToMessageId: message.messageId,
            target: { openId: message.senderOpenId, name: "" },
            text: isCompacting
              ? "上下文整理已完成，请查看上方结果。"
              : "任务已完成，请查看上方结果。",
            replyInThread: hasThread,
          });
        }
        if (!isCompacting) {
          try {
            // 协作交接沿用同一 taskId，并用 maxRounds 作为明确的停止条件，避免自动循环。
            if (collaboration && collaboration.round < collaboration.maxRounds) {
              await sendCollaborationMessage({
                senderConfig: config,
                senderBot: bot,
                replyToMessageId: message.messageId,
                targetBotId: collaboration.fromBotId,
                taskId: collaboration.taskId,
                round: collaboration.round + 1,
                maxRounds: collaboration.maxRounds,
                workspaceDir: session.workspaceDir,
                prompt: result.answer || "任务已完成，请检查当前工作目录。",
              });
            } else if (!collaboration && config.reviewBy) {
              await sendCollaborationMessage({
                senderConfig: config,
                senderBot: bot,
                replyToMessageId: message.messageId,
                targetBotId: config.reviewBy,
                taskId: randomUUID(),
                round: 1,
                maxRounds: config.collaborationMaxRounds,
                workspaceDir: session.workspaceDir,
                prompt: [
                  "请独立检查当前工作目录中刚完成的实现。",
                  `原始任务：${requestedPrompt}`,
                  "请直接读取代码和改动，指出明确问题；没有问题时说明检查通过。",
                ].join("\n\n"),
              });
            } else if (collaboration && senderRuntime) {
              await sendResultNotification({
                bot,
                replyToMessageId: message.messageId,
                target: senderRuntime.identity,
                text: "本轮协作已完成，请查看上方结果。",
                replyInThread: hasThread,
              });
            }
          } catch (error) {
            const errorMessage = (error as Error).message;
            console.error("[协作] 派发失败:", errorMessage);
            await bot.reply(
              message.messageId,
              `协作派发失败：${errorMessage}`,
              hasThread,
            );
          }
        }
      })
      .catch(async (error) => {
        clearInterval(progressHeartbeat);
        const errorMessage = (error as Error).message;
        const sessionUnavailable =
          error instanceof CliRunError &&
          Boolean(cliAdapter.isSessionUnavailable?.(errorMessage)) &&
          Boolean(session.cliSessionId);
        const failedCliSessionId =
          (error instanceof CliRunError ? error.sessionId : undefined) ??
          observedCliSessionId;
        if (!isCompacting && failedCliSessionId) {
          try {
            // 进程虽失败，但已建立的线程仍可续接，不能等成功路径才保存。
            await rememberCliSession(failedCliSessionId);
          } catch (persistError) {
            console.error(
              "[会话] 保存失败任务的 CLI 会话 ID 失败:",
              (persistError as Error).message,
            );
          }
        }
        if (sessionUnavailable) {
          try {
            // 续聊指针已失效；清掉后下一次“继续执行”才会按原任务新建会话。
            await sessions.clearCliSessionId(session.id);
            console.warn(
              `[会话] CLI 会话已失效，将在下次重试时重新建立 engine=${cliAdapter.id}`,
            );
          } catch (persistError) {
            console.error(
              "[会话] 清除失效 CLI 会话 ID 失败:",
              (persistError as Error).message,
            );
          }
        }
        if (run.signal.aborted) {
          await finishCancelled();
          return;
        }
        console.error(`[CLI] 执行失败 engine=${cliAdapter.id}:`, errorMessage);
        await cardUpdater.finish(
          buildTaskCard({
            title: taskTitle,
            status: "failed",
            detail: isCompacting
              ? "上下文整理失败，当前 CLI 会话没有改变。"
              : sessionUnavailable
                ? "会话已失效。发送“继续执行”将重新建立会话并继续原任务。"
                : "执行没有完成。你可以调整指令后，在当前话题里重试。",
            technicalDetail: errorMessage,
            ...(!isCompacting ? { progress: progress.snapshot() } : {}),
          }),
        );
      })
      .finally(async () => {
        clearInterval(progressHeartbeat);
        // 仅清理自己登记的运行实例，防止旧任务的迟到回调删除同会话的新任务。
        if (activeRuns.get(session.id) === activeRun) {
          activeRuns.delete(session.id);
        }
        try {
          await markSessionIdle(session.id);
        } catch (error) {
          console.error(
            "[会话] 保存空闲状态失败:",
            (error as Error).message,
          );
        }
      })
      .catch((error) => {
        // 卡片更新、飞书回复或 finally 持久化失败也必须被消费，避免未处理拒绝。
        console.error("[任务] 回传或收尾失败:", (error as Error).message);
      });
  },
  });
  const identity = await startedBot.getIdentity();
  botRuntimes.set(config.id, { config, bot: startedBot, identity });
  console.log(
    `[Bot ${config.id.toUpperCase()}] 已连接 name=${identity.name} open_id=${identity.openId}`,
  );
}

await Promise.all(botConfigs.map(startConfiguredBot));
