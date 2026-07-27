/**
 * Agent OS 入口。
 * 当前阶段：话题内回复 + @提及解析 + 图片/文件下载。
 */
import "dotenv/config";
import { join } from "node:path";
import { startBot } from "./im/lark.js";
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
    const replyId = await bot.reply(
      message.messageId,
      `收到：${resolved}`,
      hasThread,
    );
    console.log(`[已回] message_id=${replyId} inThread=${hasThread}`);
  },
});
