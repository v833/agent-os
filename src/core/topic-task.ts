/**
 * 话题任务编号：把同一飞书话题内的消息、卡片和补充文字绑定到稳定任务。
 * router 与 clarification 插件共同使用，避免把平台事件 ID 直接当业务状态键。
 */
import { createHash } from "node:crypto";

export interface TopicAddress {
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
}

export function topicIdOf(message: TopicAddress): string {
  return message.threadId || message.rootId || message.messageId;
}

export function topicTaskId(message: TopicAddress): string {
  return createHash("sha256")
    .update(`${message.chatId}:${topicIdOf(message)}`)
    .digest("hex")
    .slice(0, 24);
}
