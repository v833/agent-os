/**
 * Agent OS 进程入口：把飞书消息接入会话模型、控制命令、资源下载、
 * 真实 CLI 调度和任务卡片，并维护“一个飞书话题对应一个会话”。
 */
import "dotenv/config";
import { join, resolve as resolvePath } from "node:path";
import { ClaudeAdapter } from "./cli/claude-adapter.js";
import { CodexAdapter } from "./cli/codex-adapter.js";
import { runCli } from "./cli/runner.js";
import type { CliAdapter, CliId } from "./cli/types.js";
import { parseCommand } from "./core/command-parser.js";
import { SessionManager, type Session } from "./core/session-manager.js";
import { JsonSessionStore } from "./core/session-store.js";
import { buildTaskCard } from "./im/card.js";
import { startBot } from "./im/lark.js";
import {
  extractResourceKeys,
  resolveMentions,
} from "./im/message-parser.js";

const appId = process.env.BOT_A_APP_ID;
const appSecret = process.env.BOT_A_APP_SECRET;
const configuredCliId = process.env.CLI_ENGINE?.trim().toLowerCase() || "codex";

if (!appId || !appSecret) {
  console.error("缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env");
  process.exit(1);
}
if (configuredCliId !== "codex" && configuredCliId !== "claude") {
  console.error("CLI_ENGINE 只支持 codex 或 claude，请检查 .env");
  process.exit(1);
}

const defaultCliId: CliId = configuredCliId;
const cliWorkdirs: Record<CliId, string> = {
  codex: resolvePath(process.env.CODEX_WORKDIR?.trim() || process.cwd()),
  claude: resolvePath(process.env.CLAUDE_WORKDIR?.trim() || process.cwd()),
};
const CLI_LABELS: Record<CliId, string> = {
  codex: "Codex",
  claude: "Claude Code",
};
const cliAdapters: Record<CliId, CliAdapter> = {
  codex: new CodexAdapter(),
  claude: new ClaudeAdapter(),
};

console.log("Agent OS 启动，正在建立飞书长连接…");
console.log(
  `[CLI] command=${defaultCliId} cwd=${cliWorkdirs[defaultCliId]}`,
);

// 启动消息长连接前先恢复会话，避免恢复期间收到消息并创建重复映射。
const sessions = await SessionManager.open({
  store: new JsonSessionStore(join("data", "sessions.json")),
  defaultCliId,
});
console.log(`[会话] 已恢复 ${sessions.size} 个会话`);
// AbortController 与会话一一对应，使 /close 能取消后台任务，而不影响其他话题。
const activeRuns = new Map<string, AbortController>();

function executeCli(
  cliId: CliId,
  prompt: string,
  cliSessionId: string | undefined,
  signal: AbortSignal,
) {
  const cwd = cliWorkdirs[cliId];
  console.log(`[CLI] 启动 engine=${cliId} cwd=${cwd}`);
  return runCli({
    adapter: cliAdapters[cliId],
    prompt,
    cwd,
    sessionId: cliSessionId,
    signal,
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
  return [
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${session.cliId}`,
    `CLI 会话：${session.cliSessionId ?? "(尚未建立)"}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join("\n");
}

startBot({
  appId,
  appSecret,
  onMessage: async (message, bot) => {
    const resolved = resolveMentions(message.text, message.mentions);
    const hasThread = Boolean(message.threadId || message.rootId);
    const { session, isNew } = await sessions.resolve(message);

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

    const command = parseCommand(resolved);

    // 控制命令必须先于 active/closed 防御分支处理，否则执行中无法查询或关闭会话。
    if (command?.name === "help") {
      await bot.reply(
        message.messageId,
        ["/status 查看当前会话", "/close 关闭当前会话", "/help 查看命令"].join(
          "\n",
        ),
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
      activeRuns.get(session.id)?.abort();
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
    activeRuns.set(session.id, run);
    const cliLabel = CLI_LABELS[session.cliId];
    const taskTitle = `${cliLabel} 任务`;

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

    let cardId: string | undefined;
    try {
      cardId = await bot.replyCard(
        message.messageId,
        buildTaskCard({
          title: taskTitle,
          status: "running",
          progress: 0,
          detail: "正在启动执行引擎",
        }),
        hasThread,
      );
    } catch (error) {
      // 任务尚未真正启动；创建卡片失败时必须撤销 active 状态，允许用户重试。
      if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
      await markSessionIdle(session.id);
      throw error;
    }

    if (!cardId) {
      console.error("[卡片] 响应里没有 message_id，无法继续更新");
      // 飞书成功响应也可能缺少 ID，此时同样按启动失败回收会话状态。
      if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
      await markSessionIdle(session.id);
      return;
    }
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

    // 不等待 CLI，确保长连接仍能接收 /status 和 /close 等控制消息。
    void executeCli(
      session.cliId,
      resolved,
      session.cliSessionId,
      run.signal,
    )
      .then(async (result) => {
        // /close 与子进程结束可能竞态；取消后不允许再回传成功状态。
        if (run.signal.aborted) return;
        if (
          result.sessionId &&
          result.sessionId !== session.cliSessionId
        ) {
          await sessions.setCliSessionId(session.id, result.sessionId);
        }
        if (run.signal.aborted) return;
        await bot.updateCard(
          cardId,
          buildTaskCard({
            title: taskTitle,
            status: "success",
            progress: 100,
            detail: "执行完成",
          }),
        );
        await bot.reply(message.messageId, result.answer, hasThread);
        console.log(
          `[CLI] 完成 engine=${session.cliId} session_id=${result.sessionId ?? "(无)"}`,
        );
      })
      .catch(async (error) => {
        if (run.signal.aborted) {
          console.log(`[CLI] 任务已取消 engine=${session.cliId}`);
          return;
        }
        const errorMessage = (error as Error).message;
        console.error(`[CLI] 执行失败 engine=${session.cliId}:`, errorMessage);
        await bot.updateCard(
          cardId,
          buildTaskCard({
            title: taskTitle,
            status: "failed",
            progress: 0,
            detail: errorMessage,
          }),
        );
        await bot.reply(
          message.messageId,
          `${cliLabel} 执行失败：${errorMessage}`,
          hasThread,
        );
      })
      .finally(async () => {
        // 仅清理自己登记的运行实例，防止旧任务的迟到回调删除同会话的新任务。
        if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
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
