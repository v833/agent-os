/**
 * 飞书平台适配器：WSClient 负责长连接收消息与卡片动作，Client 负责 REST
 * 回复、更新卡片和下载资源；对外只暴露 Agent OS 自己的干净事件模型。
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
  senderType: string;
  senderOpenId: string;
  mentions: Mention[];
}

/** Agent OS 对飞书长连接状态的稳定抽象，不暴露 SDK 内部 WebSocket 类型。 */
export type BotConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export interface BotOptions {
  appId: string;
  appSecret: string;
  onMessage: (message: IncomingMessage, bot: Bot) => Promise<void>;
  onCardAction?: (
    action: CardAction,
  ) => Promise<CardActionResponse | undefined>;
  onConnectionState?: (state: BotConnectionState) => void;
}

/** 飞书卡片动作中业务层唯一需要信任的平台字段。 */
export interface CardAction {
  operatorOpenId: string;
  messageId: string;
  value: Record<string, unknown>;
}

export interface CardActionResponse {
  toast?: {
    type: "success" | "info" | "warning" | "error";
    content: string;
  };
  card?: { type: "raw"; data: CardJson };
}

/** 飞书 bot 的稳定身份，供跨 bot 提及和结果通知使用。 */
export interface BotIdentity {
  openId: string;
  name: string;
}

export interface Bot {
  client: Lark.Client;
  /** 当前入站长连接状态；未暴露 SDK 的 WSClient，避免平台实现渗透到插件层。 */
  getConnectionState?: () => BotConnectionState;
  getIdentity: () => Promise<BotIdentity>;
  /** 主动向群聊/单聊发送一条文本消息；定时任务等无人回复场景使用。 */
  send: (chatId: string, text: string) => Promise<string | undefined>;
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
  replyMention: (
    messageId: string,
    target: BotIdentity,
    text: string,
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

/** 构造飞书 post 消息的语言节点和二维内容数组，确保 @ 真正触达目标 bot。 */
export function buildMentionPostContent(
  target: BotIdentity,
  text: string,
): Record<string, unknown> {
  return {
    zh_cn: {
      title: "",
      content: [
        [
          {
            tag: "at",
            user_id: target.openId,
            ...(target.name ? { user_name: target.name } : {}),
          },
          { tag: "text", text: ` ${text}` },
        ],
      ],
    },
  };
}

async function fetchBotIdentity(client: Lark.Client): Promise<BotIdentity> {
  const response = await client.request({
    url: "/open-apis/bot/v3/info",
    method: "GET",
  });
  const bot = (response as { bot?: { open_id?: string; app_name?: string } })
    .bot;
  if (!bot?.open_id) throw new Error("飞书没有返回 bot open_id");
  return { openId: bot.open_id, name: bot.app_name?.trim() || "Bot" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 兼容飞书卡片回调的新旧字段形态，并拒绝非对象按钮参数。 */
export function parseCardAction(data: unknown): CardAction {
  const root = isRecord(data) ? data : {};
  const action = isRecord(root.action) ? root.action : {};
  const operator = isRecord(root.operator) ? root.operator : {};
  const legacyOperator = isRecord(root.operator_id) ? root.operator_id : {};
  const context = isRecord(root.context) ? root.context : {};
  const value = action.value;

  return {
    operatorOpenId:
      typeof operator.open_id === "string"
        ? operator.open_id
        : typeof legacyOperator.open_id === "string"
          ? legacyOperator.open_id
          : "",
    messageId:
      typeof context.open_message_id === "string"
        ? context.open_message_id
        : typeof root.open_message_id === "string"
          ? root.open_message_id
          : "",
    value: isRecord(value) ? value : {},
  };
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

interface PostElement {
  tag?: string;
  text?: string;
  user_id?: string;
}

function renderPostElement(element: PostElement): string {
  // at 保留飞书占位 ID，后续统一由 resolveMentions 还原成人名。
  if (element.tag === "at") return element.user_id ?? "";
  if (element.tag === "br") return "\n";
  if (["text", "a", "code", "code_block", "md"].includes(element.tag ?? "")) {
    return element.text ?? "";
  }
  return "";
}

/** 从 text/post 的双层 JSON 中提取可直接交给 CLI 的完整文本。 */
export function extractMessageText(messageType: string, content: string): string {
  // 飞书协议是双层 JSON：事件已解析，message.content 仍需单独 JSON.parse。
  const parsed = JSON.parse(content);

  if (messageType === "text") {
    return parsed.text ?? "";
  }

  if (messageType === "post") {
    const localized = isRecord(parsed.zh_cn) ? parsed.zh_cn : undefined;
    const paragraphs: PostElement[][] =
      (Array.isArray(parsed.content)
        ? parsed.content
        : localized?.content) ?? [];
    return paragraphs
      .map((paragraph) => paragraph.map(renderPostElement).join(""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

/** 给来源 bot 或普通消息发起人发送完成提醒；通知失败不影响任务结果。 */
export async function sendResultNotification(options: {
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

export function startBot(options: BotOptions): Bot {
  const {
    appId,
    appSecret,
    onMessage,
    onCardAction,
    onConnectionState,
  } = options;
  let connectionState: BotConnectionState = "connecting";
  const setConnectionState = (state: BotConnectionState): void => {
    connectionState = state;
    onConnectionState?.(state);
  };
  // Client 管“出站”：SDK 会自动维护 tenant token，无需业务层处理刷新。
  const client = new Lark.Client({ appId, appSecret });

  const bot: Bot = {
    client,
    getConnectionState: () => connectionState,
    getIdentity() {
      return fetchBotIdentity(client);
    },
    async send(chatId, text) {
      const response = await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
      return response.data?.message_id;
    },
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
    async replyMention(messageId, target, text, replyInThread = false) {
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "post",
          content: JSON.stringify(buildMentionPostContent(target, text)),
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

  // 两类长连接事件在平台边界归一化，核心层不依赖 SDK 的原始字段结构。
  const dispatcher = new Lark.EventDispatcher({}).register({
    "card.action.trigger": async (data: unknown) => {
      if (!onCardAction) return undefined;
      return onCardAction(parseCardAction(data));
    },
    "im.message.receive_v1": async (data) => {
      const message = data.message;
      // 在平台边界完成字段归一化，core 层不直接依赖飞书原始事件类型。
      const incomingMessage: IncomingMessage = {
        messageId: message.message_id,
        chatId: message.chat_id,
        chatType: message.chat_type,
        messageType: message.message_type,
        text: extractMessageText(message.message_type, message.content),
        rawContent: message.content,
        rootId: message.root_id ?? "",
        threadId: message.thread_id ?? "",
        senderType: data.sender.sender_type ?? "",
        senderOpenId: data.sender.sender_id?.open_id ?? "",
        mentions: parseMentions(message.mentions),
      };

      await onMessage(incomingMessage, bot);
    },
  });

  // WSClient 管“入站”：主动连飞书平台，无需公网 webhook，并由 SDK 自动重连。
  // 状态由 SDK 的握手/重连回调驱动；“已拿到 bot 身份”本身不代表 WS 已在线。
  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    onReady: () => setConnectionState("connected"),
    onReconnecting: () => setConnectionState("reconnecting"),
    onReconnected: () => setConnectionState("connected"),
    onError: () => setConnectionState("failed"),
  });
  void wsClient
    .start({ eventDispatcher: dispatcher })
    .catch(() => setConnectionState("failed"));

  return bot;
}
