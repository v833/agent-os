/**
 * Agent OS 入口。
 * 当前阶段：话题内回复 + @提及解析 + 图片/文件下载。
 */
import "dotenv/config";
import { join } from "node:path";
import { startBot, type Bot } from "./im/lark.js";
import { buildTaskCard, ThrottledCardUpdater } from "./im/card.js";
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

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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
): Promise<void> {
  const activities: string[] = [];
  const updater = new ThrottledCardUpdater(async (card) => {
    await bot.updateCard(cardId, card);
    console.log("[卡片] 已刷新");
  });

  for (const [index, step] of DEMO_STEPS.entries()) {
    await wait(700);
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

startBot({
  appId,
  appSecret,
  onMessage: async (message, bot) => {
    const resolved = resolveMentions(message.text, message.mentions);
    console.log(
      `[收到] chat=${message.chatId} threadId=${message.threadId} rootId=${message.rootId} sender=${message.senderOpenId}`,
    );
    console.log(`  原文: ${message.text}`);
    console.log(`  还原: ${resolved}`);
    console.log(
      `  mentions: ${message.mentions.map((mention) => `${mention.key}=${mention.name}(${mention.openId})`).join(", ") || "(无)"}`,
    );

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

    const hasThread = Boolean(message.threadId || message.rootId);
    const cardId = await bot.replyCard(
      message.messageId,
      buildTaskCard({
        title: "Agent OS 模拟任务",
        status: "running",
        progress: 0,
        detail: "正在准备任务环境",
      }),
      hasThread,
    );

    if (!cardId) {
      console.error("[卡片] 响应里没有 message_id，无法继续更新");
      return;
    }
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

    void runCardDemo(bot, cardId, resolved).catch((error) => {
      console.error("[卡片] 演示失败:", (error as Error).message);
    });
  },
});
