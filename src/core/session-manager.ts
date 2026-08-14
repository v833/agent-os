/**
 * Agent OS 会话模型：把飞书话题地址映射为稳定会话，集中约束
 * creating、active、idle、closed 的生命周期，并协调内存与磁盘状态。
 */
import { randomUUID } from "node:crypto";
import type { CliAccessMode, CliId } from "../cli/types.js";
import type { SessionStore } from "./session-store.js";

export type SessionStatus = "creating" | "active" | "idle" | "closed";

export interface Session {
  id: string;
  botId: string;
  threadId: string;
  chatId: string;
  cliId: CliId;
  /** 旧快照没有该字段时按 headless 解释。 */
  accessMode?: CliAccessMode;
  cliSessionId?: string;
  /** 当前话题启动 CLI 时使用的绝对工作目录。 */
  workspaceDir: string;
  retryPrompt?: string;
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
  store?: SessionStore;
}

// 所有合法状态迁移集中在这里，避免入口的不同分支各自修改状态。
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  // 命令类消息会创建会话但不启动 CLI，因此允许直接进入 idle。
  creating: ["active", "idle", "closed"],
  active: ["idle", "closed"],
  idle: ["active", "closed"],
  closed: [],
};

function topicIdOf(message: MessageAddress): string {
  // 话题优先；普通群或单聊没有话题信息时，退化为“一条消息一个会话”。
  return message.threadId || message.rootId || message.messageId;
}

function sessionKey(botId: string, chatId: string, threadId: string): string {
  // botId 让同一话题被不同 bot 处理时拥有独立的 CLI 上下文。
  return `${botId}:${chatId}:${threadId}`;
}

const RETRY_REQUEST = /^(?:继续(?:执行)?|重试|再试一次)[。！？!?]*$/;

/** 判断用户是否在请求重试上一条未完成任务，而不是提交新任务。 */
export function isRetryRequest(prompt: string): boolean {
  return RETRY_REQUEST.test(prompt.trim());
}

/** CLI 尚未建立会话时，把明确的重试请求还原为上次失败的原始任务。 */
export function resolveRetryPrompt(session: Session, prompt: string): string {
  if (session.cliSessionId || !session.retryPrompt) return prompt;
  return isRetryRequest(prompt) ? session.retryPrompt : prompt;
}

/** 负责会话解析、查询和受约束的状态更新。 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly store?: SessionStore;

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.store = options.store;
  }

  /** 创建管理器并按 bot、群聊和话题键恢复已持久化的会话。 */
  static async open(
    options: SessionManagerOptions = {},
  ): Promise<SessionManager> {
    const manager = new SessionManager(options);
    const restored = (await options.store?.load()) ?? [];
    for (const session of restored) {
      manager.sessions.set(
        sessionKey(session.botId, session.chatId, session.threadId),
        session,
      );
    }
    return manager;
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

  /** 解析 bot 的话题会话；引擎和 bot ID 只在首次创建时生效。 */
  async resolve(
    message: MessageAddress,
    cliId: CliId = "claude",
    botId = "default",
    workspaceDir = process.cwd(),
    accessMode: CliAccessMode = "headless",
  ): Promise<ResolvedSession> {
    const threadId = topicIdOf(message);
    const key = sessionKey(botId, message.chatId, threadId);
    const existing = this.sessions.get(key);
    if (existing) return { session: existing, isNew: false };

    // 会话 ID 与飞书 ID 分层：前者属于 Agent OS，后者只负责消息路由。
    const now = this.now().toISOString();
    const session: Session = {
      id: this.createId(),
      botId,
      threadId,
      chatId: message.chatId,
      cliId,
      accessMode,
      workspaceDir,
      status: "creating",
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, session);
    try {
      await this.persist();
    } catch (error) {
      // 首次保存失败时撤销内存创建，下一条消息仍可重新建立会话。
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      throw error;
    }
    return { session, isNew: true };
  }

  /** 切换话题工作目录；目录变化时清除旧 CLI 指针，避免跨项目续接上下文。 */
  async setWorkspaceDir(
    sessionId: string,
    workspaceDir: string,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!workspaceDir) throw new Error("工作目录不能为空");
    if (current.workspaceDir === workspaceDir) return current;

    // Claude/Codex 的恢复 ID 绑定此前项目，切换目录后必须从干净会话开始。
    const { cliSessionId: _previousCliSessionId, ...rest } = current;
    const updated: Session = {
      ...rest,
      workspaceDir,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      // 目录切换和其他会话更新一样，只有成功落盘后才对外生效。
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  async transition(
    sessionId: string,
    nextStatus: SessionStatus,
  ): Promise<Session> {
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
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      // 只回滚自己的更新，不能覆盖同一会话随后已经完成的新状态变化。
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  /** 保存执行引擎返回的恢复指针，使后续消息和重启恢复都能继续上下文。 */
  async setCliSessionId(
    sessionId: string,
    cliSessionId: string,
  ): Promise<Session> {
    if (!cliSessionId) throw new Error("CLI 会话 ID 不能为空");
    return this.updateCliSelection(sessionId, cliSessionId);
  }

  /** 清空当前话题选中的 CLI 会话，不删除引擎自身保存的历史记录。 */
  async clearCliSessionId(sessionId: string): Promise<Session> {
    return this.updateCliSelection(sessionId, undefined);
  }

  private async updateCliSelection(
    sessionId: string,
    cliSessionId: string | undefined,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);

    const updated: Session = cliSessionId
      ? { ...current, cliSessionId, updatedAt: this.now().toISOString() }
      : (() => {
          const { cliSessionId: _previousCliSessionId, ...rest } = current;
          return { ...rest, updatedAt: this.now().toISOString() };
        })();
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      // 恢复指针只有真正落盘后才可信，失败时同步撤销内存变化。
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  /** 保存尚未成功完成的任务指令，供 CLI 未返回会话 ID 时重新发起。 */
  async setRetryPrompt(
    sessionId: string,
    retryPrompt: string | undefined,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (retryPrompt !== undefined && !retryPrompt.trim()) {
      throw new Error("待重试指令不能为空");
    }

    const { retryPrompt: _previousRetryPrompt, ...withoutRetryPrompt } = current;
    const updated: Session = {
      ...(retryPrompt === undefined
        ? withoutRetryPrompt
        : { ...current, retryPrompt }),
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      // 失败任务的恢复文本也必须以磁盘为准，保存失败时同步撤销内存变化。
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  private async persist(): Promise<void> {
    await this.store?.save([...this.sessions.values()]);
  }
}
