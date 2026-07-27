/**
 * 飞书接入：WebSocket 长连接收消息 + REST 回消息。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseMentions, type Mention } from "./message-parser.js";

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
};

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
  downloadResource: (
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    saveDir: string,
    fileName?: string,
  ) => Promise<string>;
}

export function getHeader(headers: any, name: string): string {
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
  const parsed = JSON.parse(content);

  if (messageType === "text") {
    return parsed.text ?? "";
  }

  if (messageType === "post") {
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
    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      const response = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      const contentType = getHeader(response.headers, "content-type");
      const extension = resourceExtension(type, fileName, contentType);
      const savePath = join(saveDir, `${fileKey}.${extension}`);
      await mkdir(saveDir, { recursive: true });
      await response.writeFile(savePath);
      return savePath;
    },
  };

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const message = data.message;
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

  const wsClient = new Lark.WSClient({ appId, appSecret });
  void wsClient.start({ eventDispatcher: dispatcher });

  return bot;
}
