/**
 * 飞书接入：WebSocket 长连接收消息 + REST 回消息。
 */
import * as Lark from "@larksuiteoapi/node-sdk";

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: string;
  text: string;
  senderOpenId: string;
}

export interface BotOptions {
  appId: string;
  appSecret: string;
  onMessage: (message: IncomingMessage, bot: Bot) => Promise<void>;
}

export interface Bot {
  client: Lark.Client;
  reply: (messageId: string, text: string) => Promise<string | undefined>;
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
    async reply(messageId, text) {
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
      return response.data?.message_id;
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
        senderOpenId: data.sender.sender_id?.open_id ?? "",
      };

      await onMessage(incomingMessage, bot);
    },
  });

  const wsClient = new Lark.WSClient({ appId, appSecret });
  void wsClient.start({ eventDispatcher: dispatcher });

  return bot;
}
