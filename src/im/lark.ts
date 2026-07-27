/**
 * 飞书平台适配器：WSClient 负责长连接收事件，Client 负责 REST 发消息、
 * 更新卡片和下载资源；对外只暴露 Agent OS 自己的干净消息模型。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { CardJson } from "./card.js";
import { parseMentions, type Mention } from "./message-parser.js";

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
};

/** 收敛后的入站消息，隔离飞书 SDK 事件结构对核心层的影响。 */
export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: string;
  text: string;
  rawContent: string;
  rootId: string;
  threadId: string;
  senderOpenId: string;
  mentions: Mention[];
}

export interface BotOptions {
  appId: string;
  appSecret: string;
  onMessage: (message: IncomingMessage, bot: Bot) => Promise<void>;
}

export interface Bot {
  client: Lark.Client;
  reply: (
    messageId: string,
    text: string,
    replyInThread?: boolean,
  ) => Promise<string | undefined>;
  replyCard: (
    messageId: string,
    card: CardJson,
    replyInThread?: boolean,
  ) => Promise<string | undefined>;
  updateCard: (messageId: string, card: CardJson) => Promise<void>;
  downloadResource: (
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    saveDir: string,
    fileName?: string,
  ) => Promise<string>;
}

export function getHeader(headers: any, name: string): string {
  // SDK/HTTP 客户端版本不同，headers 可能是 Headers，也可能是普通对象或数组。
  const headerValue =
    typeof headers?.get === "function"
      ? headers.get(name)
      : (headers?.[name] ?? headers?.[name.toLowerCase()]);
  return Array.isArray(headerValue)
    ? (headerValue[0] ?? "")
    : (headerValue ?? "");
}

export function resourceExtension(
  type: "image" | "file",
  fileName: string | undefined,
  contentType: string,
): string {
  // 文件优先尊重用户原始文件名；图片通常没有文件名，只能依赖响应 MIME。
  const originalExtension = fileName
    ? extname(fileName).slice(1).toLowerCase()
    : "";
  if (/^[a-z0-9]{1,10}$/.test(originalExtension)) {
    return originalExtension;
  }

  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === "image" ? "img" : "bin");
}

export function extractText(messageType: string, content: string): string {
  // 飞书协议是双层 JSON：事件已解析，message.content 仍需单独 JSON.parse。
  const parsed = JSON.parse(content);

  if (messageType === "text") {
    return parsed.text ?? "";
  }

  if (messageType === "post") {
    // post 中的 at/img 是结构化元素，正文只拼接 text，身份和资源由其他解析器处理。
    const paragraphs: unknown[][] = parsed.content ?? [];
    return paragraphs
      .flat()
      .filter(
        (element): element is { tag: string; text?: string } =>
          typeof element === "object" && element !== null && "tag" in element,
      )
      .filter((element) => element.tag === "text")
      .map((element) => element.text ?? "")
      .join("")
      .trim();
  }

  return "";
}

export function startBot(options: BotOptions): Bot {
  const { appId, appSecret, onMessage } = options;
  // Client 管“出站”：SDK 会自动维护 tenant token，无需业务层处理刷新。
  const client = new Lark.Client({ appId, appSecret });

  const bot: Bot = {
    client,
    async reply(messageId, text, replyInThread = false) {
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return response.data?.message_id;
    },
    async replyCard(messageId, card, replyInThread = false) {
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return response.data?.message_id;
    },
    async updateCard(messageId, card) {
      // 更新必须使用机器人卡片自己的 message_id，而不是用户的入站 message_id。
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    },
    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      // message_id 与 file_key 必须来自同一条消息，否则飞书会返回资源不存在。
      const response = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      const contentType = getHeader(response.headers, "content-type");
      const extension = resourceExtension(type, fileName, contentType);
      const savePath = join(saveDir, `${fileKey}.${extension}`);
      // data/downloads 按需创建，并由 .gitignore 排除，避免提交用户附件。
      await mkdir(saveDir, { recursive: true });
      await response.writeFile(savePath);
      return savePath;
    },
  };

  // EventDispatcher 管“分发”：这里只订阅收消息事件，后续事件继续集中注册。
  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const message = data.message;
      // 在平台边界完成字段归一化，core 层不直接依赖飞书原始事件类型。
      const incomingMessage: IncomingMessage = {
        messageId: message.message_id,
        chatId: message.chat_id,
        chatType: message.chat_type,
        messageType: message.message_type,
        text: extractText(message.message_type, message.content),
        rawContent: message.content,
        rootId: message.root_id ?? "",
        threadId: message.thread_id ?? "",
        senderOpenId: data.sender.sender_id?.open_id ?? "",
        mentions: parseMentions(message.mentions),
      };

      await onMessage(incomingMessage, bot);
    },
  });

  // WSClient 管“入站”：主动连飞书平台，无需公网 webhook，并由 SDK 自动重连。
  const wsClient = new Lark.WSClient({ appId, appSecret });
  void wsClient.start({ eventDispatcher: dispatcher });

  return bot;
}
