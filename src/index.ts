/**
 * Agent OS 进程入口：把飞书消息接入会话模型、控制命令、资源下载和任务卡片。
 * 当前阶段由一个进程统一维护“一个飞书话题对应一个有生命周期的会话”。
 */
import "dotenv/config";
import { join } from "node:path";
import { parseCommand } from "./core/command-parser.js";
import { SessionManager, type Session } from "./core/session-manager.js";
import { JsonSessionStore } from "./core/session-store.js";
import { buildTaskCard, ThrottledCardUpdater } from "./im/card.js";
import { startBot, type Bot } from "./im/lark.js";
import {
  extractResourceKeys,
  resolveMentions,
} from "./im/message-parser.js";

const appId = process.env.BOT_A_APP_ID;
const appSecret = process.env.BOT_A_APP_SECRET;

if (!appId || !appSecret) {
  console.error("缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env");
  process.exit(1);
}

console.log("Agent OS 启动，正在建立飞书长连接…");

// 启动消息长连接前先恢复会话，避免恢复期间收到消息并创建重复映射。
const sessions = await SessionManager.open({
  store: new JsonSessionStore(join("data", "sessions.json")),
});
console.log(`[会话] 已恢复 ${sessions.size} 个会话`);
// AbortController 与会话一一对应，使 /close 能取消后台任务，而不影响其他话题。
const activeRuns = new Map<string, AbortController>();

/** 等待一段时间；收到取消信号时提前结束，并用 false 告知调用方不要继续执行。 */
function wait(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stopWaiting);
      resolve(true);
    }, milliseconds);
    const stopWaiting = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", stopWaiting, { once: true });
  });
}

const DEMO_STEPS = [
  "读取项目结构",
  "定位任务入口",
  "分析相关文件",
  "生成修改方案",
  "写入代码改动",
  "检查类型错误",
  "运行验证命令",
  "整理执行结果",
];

async function runCardDemo(
  bot: Bot,
  cardId: string,
  resolved: string,
  signal: AbortSignal,
): Promise<void> {
  const activities: string[] = [];
  // Agent 事件可能很密集，由更新器合并中间状态，避免触发飞书频率限制。
  const updater = new ThrottledCardUpdater(async (card) => {
    await bot.updateCard(cardId, card);
    console.log("[卡片] 已刷新");
  });

  for (const [index, step] of DEMO_STEPS.entries()) {
    if (!(await wait(700, signal))) {
      await updater.cancel();
      console.log("[卡片] 任务已取消");
      return;
    }
    activities.push(step);
    const progress = Math.round(((index + 1) / DEMO_STEPS.length) * 90);
    console.log(`[进度] ${progress}% ${step}`);
    updater.push(
      buildTaskCard({
        title: "Agent OS 模拟任务",
        status: "running",
        progress,
        detail: step,
        activities: activities.slice(-3),
      }),
    );
  }

  await updater.finish(
    buildTaskCard({
      title: "Agent OS 模拟任务",
      status: "success",
      progress: 100,
      detail: `已处理：${resolved || "富媒体消息"}`,
      activities: activities.slice(-3),
    }),
  );
  console.log("[卡片] 任务完成");
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
          title: "Agent OS 模拟任务",
          status: "running",
          progress: 0,
          detail: "正在准备任务环境",
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

    // 不阻塞长连接的消息回调；任务在后台运行，但所有出口都必须在 finally 中回收。
    void runCardDemo(bot, cardId, resolved, run.signal)
      .catch((error) => {
        console.error("[卡片] 演示失败:", (error as Error).message);
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
      });
  },
});
