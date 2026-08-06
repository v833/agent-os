/**
 * Agent OS 进程入口：把飞书消息接入会话模型、控制命令、资源下载、
 * 真实 CLI 调度和任务卡片，并维护“一个飞书话题对应一个会话”。
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  getCliAdapter,
  listCliAdapters,
  parseCliId,
  resolveCliWorkdir,
} from "./cli/registry.js";
import { runCli } from "./cli/runner.js";
import type { CliAdapter } from "./cli/types.js";
import { parseCliRequest, parseCommand } from "./core/command-parser.js";
import { SessionManager, type Session } from "./core/session-manager.js";
import { JsonSessionStore } from "./core/session-store.js";
import { requestTaskAbort, type ActiveRun } from "./core/task-abort.js";
import { TaskProgressTracker } from "./core/task-progress.js";
import {
  answerContinuation,
  answerNeedsContinuation,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from "./im/card.js";
import { startBot } from "./im/lark.js";
import {
  extractResourceKeys,
  leadingMentionName,
  resolveMentions,
} from "./im/message-parser.js";

const appId = process.env.BOT_A_APP_ID;
const appSecret = process.env.BOT_A_APP_SECRET;

if (!appId || !appSecret) {
  console.error("缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env");
  process.exit(1);
}

const cliWorkdir = resolveCliWorkdir();
const defaultCliId = parseCliId(process.env.DEFAULT_CLI);

console.log("Agent OS 启动，正在建立飞书长连接…");
console.log(`[CLI] default=${defaultCliId}`);
for (const adapter of listCliAdapters()) {
  console.log(
    `[CLI] id=${adapter.id} command=${adapter.command} cwd=${cliWorkdir}`,
  );
}

// 启动消息长连接前先恢复会话，避免恢复期间收到消息并创建重复映射。
const sessions = await SessionManager.open({
  store: new JsonSessionStore(join("data", "sessions.json")),
});
console.log(`[会话] 已恢复 ${sessions.size} 个会话`);
// 每轮运行额外记录发起人和唯一 ID，供卡片按钮鉴权并隔离旧卡片。
const activeRuns = new Map<string, ActiveRun>();
// Claude 的模型窗口通常到本轮结束才返回，按会话记忆后供下一轮实时展示。
const contextWindows = new Map<string, number>();

function executeCli(
  adapter: CliAdapter,
  prompt: string,
  cliSessionId: string | undefined,
  signal: AbortSignal,
  onEvent: Parameters<typeof runCli>[0]["onEvent"],
) {
  console.log(`[CLI] 启动 engine=${adapter.id} cwd=${cliWorkdir}`);
  return runCli({
    adapter,
    prompt,
    cwd: cliWorkdir,
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

function formatSessionStatus(session: Session): string {
  const adapter = getCliAdapter(session.cliId);
  return [
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${adapter.displayName}`,
    `CLI 会话：${session.cliSessionId ?? "(尚未建立)"}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join("\n");
}

startBot({
  appId,
  appSecret,
  onCardAction: async (action) => {
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
    const hasThread = Boolean(message.threadId || message.rootId);
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
    const { session, isNew } = await sessions.resolve(
      message,
      cliRequest?.cliId ?? defaultCliId,
    );
    const cliAdapter = getCliAdapter(session.cliId);
    const prompt = cliRequest?.prompt ?? resolved;

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

    const command = parseCommand(resolved);

    // 控制命令必须先于 active/closed 防御分支处理，否则执行中无法查询或关闭会话。
    if (command?.name === "help") {
      await bot.reply(
        message.messageId,
        [
          "/status 查看当前会话",
          "/close 关闭当前会话",
          "/help 查看命令",
          "/claude <任务> 新话题使用 Claude Code",
          "/codex <任务> 新话题使用 Codex",
        ].join("\n"),
        hasThread,
      );
      return;
    }

    if (command?.name === "status") {
      await bot.reply(
        message.messageId,
        formatSessionStatus(session),
        hasThread,
      );
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

    await sessions.transition(session.id, "active");
    const run = new AbortController();
    const activeRun: ActiveRun = {
      controller: run,
      ownerOpenId: message.senderOpenId,
      runId: randomUUID(),
    };
    activeRuns.set(session.id, activeRun);
    const taskTitle = cliAdapter.displayName;

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
          detail: "正在理解任务",
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
          detail: snapshot.current,
          progress: snapshot,
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
              : "本次任务已停止。你可以继续在当前话题里提问。",
          progress: progress.snapshot(),
        }),
      );
    };
    // 没有新事件时心跳仍会推进耗时；节流器确保最终每秒最多一次 patch。
    const progressHeartbeat = setInterval(renderProgress, 1_000);
    progressHeartbeat.unref();

    // 不等待 CLI，确保长连接仍能接收 /status 和 /close 等控制消息。
    void executeCli(
      cliAdapter,
      prompt,
      session.cliSessionId,
      run.signal,
      (event) => {
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
    )
      .then(async (result) => {
        clearInterval(progressHeartbeat);
        // /close、按钮和子进程退出可能竞态；取消后只能写灰色终态。
        if (run.signal.aborted) {
          await finishCancelled();
          return;
        }
        if (
          result.sessionId &&
          result.sessionId !== session.cliSessionId
        ) {
          await sessions.setCliSessionId(session.id, result.sessionId);
        }
        if (run.signal.aborted) {
          await finishCancelled();
          return;
        }
        if (result.stats?.contextWindowTokens) {
          contextWindows.set(session.id, result.stats.contextWindowTokens);
        }
        await cardUpdater.finish(
          buildTaskCard({
            title: taskTitle,
            status: "success",
            detail: "执行完成",
            progress: progress.snapshot(),
            answer: result.answer,
            stats: result.stats,
            recipientOpenId: message.senderOpenId,
          }),
        );
        if (answerNeedsContinuation(result.answer)) {
          for (const chunk of splitLongText(answerContinuation(result.answer))) {
            if (run.signal.aborted) break;
            await bot.reply(message.messageId, chunk, hasThread);
          }
        }
        console.log(
          `[CLI] ${cliAdapter.id} 完成 session_id=${result.sessionId ?? "(无)"}`,
        );
      })
      .catch(async (error) => {
        clearInterval(progressHeartbeat);
        if (run.signal.aborted) {
          await finishCancelled();
          return;
        }
        const errorMessage = (error as Error).message;
        console.error(`[CLI] 执行失败 engine=${cliAdapter.id}:`, errorMessage);
        await cardUpdater.finish(
          buildTaskCard({
            title: taskTitle,
            status: "failed",
            detail: "执行没有完成。你可以调整指令后，在当前话题里重试。",
            technicalDetail: errorMessage,
            progress: progress.snapshot(),
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
