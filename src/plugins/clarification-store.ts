/**
 * 澄清插件持久化：保存待用户回答的结构化问题与原任务上下文。
 * 独立 JSON 文件让 clarification 可单独启停，不污染通用 Session 模型。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ClarificationRequestSchema } from "../core/clarification.js";
import type { CollaborationMessage } from "../core/collaboration.js";

const PendingClarificationSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  cliSessionId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  replyToMessageId: z.string().min(1),
  hasThread: z.boolean(),
  requestedPrompt: z.string(),
  request: ClarificationRequestSchema,
  collaboration: z
    .object({
      dispatchId: z.string(),
      taskId: z.string(),
      fromBotId: z.string(),
      toBotId: z.string(),
      round: z.number().int(),
      maxRounds: z.number().int(),
      workspaceDir: z.string(),
      prompt: z.string(),
    })
    .optional(),
  createdAt: z.iso.datetime(),
});

/** 一份等待卡片提交的澄清记录；cliSessionId 保证回答续接原始 CLI 会话。 */
export interface PendingClarification {
  id: string;
  botId: string;
  sessionId: string;
  runId: string;
  cliSessionId: string;
  ownerOpenId: string;
  replyToMessageId: string;
  hasThread: boolean;
  requestedPrompt: string;
  request: z.infer<typeof ClarificationRequestSchema>;
  collaboration?: CollaborationMessage;
  createdAt: string;
}

/** 原子保存全部待澄清记录，坏记录在读取时丢弃并清理。 */
export class ClarificationStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<PendingClarification[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) {
      throw new Error(`澄清文件格式错误: ${this.filePath}`);
    }
    const records = rows.flatMap((row) => {
      const parsed = PendingClarificationSchema.safeParse(row);
      return parsed.success ? [parsed.data as PendingClarification] : [];
    });
    if (records.length !== rows.length) await this.save(records);
    return records;
  }

  save(records: PendingClarification[]): Promise<void> {
    const snapshot = JSON.stringify(records, null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${snapshot}\n`, "utf8");
      await rename(tempPath, this.filePath);
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}
