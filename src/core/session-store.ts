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
  botId: z.string().min(1),
  threadId: z.string().min(1),
  chatId: z.string().min(1),
  // 会话快照同时支持 Codex、Claude 与 Mastra；具体默认引擎由 bot 注册表决定。
  cliId: z.enum(["codex", "claude", "mastra"]),
  // 旧快照没有恢复指针，首次成功执行后才会写入，因此必须保持可选。
  cliSessionId: z.string().min(1).optional(),
  // 旧快照没有待重试指令；任务启动前写入，成功后删除。
  retryPrompt: z.string().min(1).optional(),
  // 旧快照可能缺少工作目录，读取时会按 bot 默认值迁移后再校验。
  workspaceDir: z.string().min(1),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 给升级前快照补齐 bot 和工作目录，随后由 Zod 负责完整校验。 */
function migrateLegacySession(
  row: unknown,
  legacyBotId: string,
  defaultWorkspaces: Readonly<Record<string, string>>,
): { candidate: unknown; migrated: boolean } {
  if (!isRecord(row)) return { candidate: row, migrated: false };

  const needsBotId = !("botId" in row);
  const needsWorkspace = !("workspaceDir" in row);
  if (!needsBotId && !needsWorkspace) {
    return { candidate: row, migrated: false };
  }

  const candidate: Record<string, unknown> = { ...row };
  if (needsBotId) candidate.botId = legacyBotId;
  const botId =
    typeof candidate.botId === "string" ? candidate.botId : legacyBotId;
  if (needsWorkspace) {
    candidate.workspaceDir = defaultWorkspaces[botId] ?? process.cwd();
  }
  return { candidate, migrated: true };
}

/** 使用 JSON 文件保存全部会话快照。 */
export class JsonSessionStore implements SessionStore {
  // 多次状态变化可能同时触发保存，Promise 队列确保快照按调用顺序落盘。
  private writeQueue: Promise<void> = Promise.resolve();

  /** legacyBotId 指定升级前没有 botId 的旧记录归属；defaultWorkspaces 用于迁移旧目录。 */
  constructor(
    private readonly filePath: string,
    private readonly legacyBotId = "default",
    private readonly defaultWorkspaces: Readonly<Record<string, string>> = {},
  ) {}

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
      const { candidate, migrated } = migrateLegacySession(
        row,
        this.legacyBotId,
        this.defaultWorkspaces,
      );
      const result = SessionSchema.safeParse(candidate);
      if (!result.success) {
        // 单条坏记录不应阻止其他会话恢复，清理后的快照会覆盖原文件。
        needsCleanup = true;
        continue;
      }

      if (migrated) needsCleanup = true;

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
