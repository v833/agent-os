/**
 * 会话持久化层：负责 sessions.json 的校验、重启恢复与原子写入，
 * 让会话模型无需关心具体文件格式和磁盘操作细节。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Session } from "./session-manager.js";

/** SessionManager 依赖的最小存储协议，便于测试时替换为内存实现。 */
export interface SessionStore {
  load(): Promise<Session[]>;
  save(sessions: Session[]): Promise<void>;
}

const SessionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  chatId: z.string().min(1),
  // 当前以 Codex 为默认引擎，同时保留已经接入的 Claude 会话类型。
  cliId: z.enum(["codex", "claude"]),
  // 旧快照没有恢复指针，首次成功执行后才会写入，因此必须保持可选。
  cliSessionId: z.string().min(1).optional(),
  status: z.enum(["creating", "active", "idle", "closed"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

function recoverInterruptedSession(session: Session): Session {
  if (session.status !== "creating" && session.status !== "active") {
    return session;
  }

  // 重启后旧任务进程已经不存在，不能继续保留“准备中”或“执行中”的假状态。
  return { ...session, status: "idle" };
}

/** 使用 JSON 文件保存全部会话快照。 */
export class JsonSessionStore implements SessionStore {
  // 多次状态变化可能同时触发保存，Promise 队列确保快照按调用顺序落盘。
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<Session[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) {
      throw new Error(`会话文件格式错误: ${this.filePath}`);
    }

    const sessions: Session[] = [];
    let needsCleanup = false;
    for (const row of rows) {
      const result = SessionSchema.safeParse(row);
      if (!result.success) {
        // 单条坏记录不应阻止其他会话恢复，清理后的快照会覆盖原文件。
        needsCleanup = true;
        continue;
      }

      const recovered = recoverInterruptedSession(result.data);
      if (recovered.status !== result.data.status) needsCleanup = true;
      sessions.push(recovered);
    }

    if (needsCleanup) await this.save(sessions);
    return sessions;
  }

  save(sessions: Session[]): Promise<void> {
    // 在入队前固定快照，后续内存变化不会篡改本次待写内容。
    const snapshot = JSON.stringify(sessions, null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${snapshot}\n`, "utf8");
      // 先完整写临时文件，再替换正式文件，避免异常退出留下半截 JSON。
      await rename(tempPath, this.filePath);
    };

    // 前一次失败也不能打断后续保存，因此成功和失败分支都继续执行 write。
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}
