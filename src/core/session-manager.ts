/**
 * Agent OS 内存会话模型：把飞书话题地址映射为稳定会话，
 * 并集中约束 creating、active、idle、closed 的生命周期流转。
 * 当前只保存在进程内，重启后的持久化由后续存储层负责。
 */
import { randomUUID } from "node:crypto";

export type CliId = "codex" | "claude";

export type SessionStatus = "creating" | "active" | "idle" | "closed";

export interface Session {
  id: string;
  threadId: string;
  chatId: string;
  cliId: CliId;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MessageAddress {
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
}

export interface ResolvedSession {
  session: Session;
  isNew: boolean;
}

export interface SessionManagerOptions {
  now?: () => Date;
  createId?: () => string;
}

// 所有合法状态迁移集中在这里，避免入口的不同分支各自修改状态。
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ["active", "closed"],
  active: ["idle", "closed"],
  idle: ["active", "closed"],
  closed: [],
};

function topicIdOf(message: MessageAddress): string {
  // 话题优先；普通群或单聊没有话题信息时，退化为“一条消息一个会话”。
  return message.threadId || message.rootId || message.messageId;
}

function sessionKey(chatId: string, threadId: string): string {
  // threadId 只在群聊上下文内有意义，加入 chatId 避免跨群碰撞。
  return `${chatId}:${threadId}`;
}

/** 负责会话解析、查询和受约束的状态更新。 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): Session | undefined {
    // Map 按飞书地址建索引；按 Agent OS UUID 查询时需要在值集合中查找。
    return [...this.sessions.values()].find(
      (session) => session.id === sessionId,
    );
  }

  resolve(message: MessageAddress): ResolvedSession {
    const threadId = topicIdOf(message);
    const key = sessionKey(message.chatId, threadId);
    const existing = this.sessions.get(key);
    if (existing) return { session: existing, isNew: false };

    // 会话 ID 与飞书 ID 分层：前者属于 Agent OS，后者只负责消息路由。
    const now = this.now().toISOString();
    const session: Session = {
      id: this.createId(),
      threadId,
      chatId: message.chatId,
      cliId: "codex",
      status: "creating",
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, session);
    return { session, isNew: true };
  }

  transition(sessionId: string, nextStatus: SessionStatus): Session {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`);
    }

    // 不原地修改旧对象，让状态变化只有一个明确、可审计的写入口。
    const updated: Session = {
      ...current,
      status: nextStatus,
      updatedAt: this.now().toISOString(),
    };
    this.sessions.set(sessionKey(updated.chatId, updated.threadId), updated);
    return updated;
  }
}
