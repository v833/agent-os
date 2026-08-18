/**
 * 定时任务持久化层：负责 schedules.json 的校验、重启恢复与原子写入，
 * 让 schedule 服务无需关心具体文件格式和磁盘操作细节。
 * 参考 session-store 的模式：Zod 校验坏记录、临时文件 + rename 原子替换、写队列串行化。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { CliAccessMode, CliId } from "../cli/types.js";

/** 一条持久化的定时任务；触发所需的目标地址与引擎选择全部内联。 */
export interface ScheduleTask {
  /** 稳定标识，如 sched-001。 */
  id: string;
  /** 用户输入的原始周期文本。 */
  schedule: string;
  /** 解析后的 cron 表达式，由 croner 驱动。 */
  expr: string;
  /** 人类可读周期描述。 */
  display: string;
  /** 到点交给 CLI 执行的任务提示词。 */
  prompt: string;
  botId: string;
  chatId: string;
  /** 目标话题；空字符串表示非话题群聊（此时用 messageId 定位会话）。 */
  threadId: string;
  rootId: string;
  /** 配置命令所在消息 ID：有话题时复用话题会话，无话题时作为会话定位锚点。 */
  messageId: string;
  cliId: CliId;
  accessMode: CliAccessMode;
  workspaceDir: string;
  /** 配置者 openId：任务卡片停止按钮的鉴权发起人。 */
  ownerOpenId: string;
  enabled: boolean;
  lastRunAt?: string;
  /** 到点但因目标话题忙碌或关闭而跳过的时刻。 */
  lastSkippedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** ScheduleService 依赖的最小存储协议，便于测试时替换为内存实现。 */
export interface ScheduleStore {
  load(): Promise<ScheduleTask[]>;
  save(tasks: ScheduleTask[]): Promise<void>;
}

const ScheduleSchema = z.object({
  id: z.string().min(1),
  schedule: z.string().min(1),
  expr: z.string().min(1),
  display: z.string().min(1),
  prompt: z.string().min(1),
  botId: z.string().min(1),
  chatId: z.string().min(1),
  threadId: z.string(),
  rootId: z.string(),
  messageId: z.string().min(1),
  cliId: z.enum(["codex", "claude", "dimagent"]),
  // 旧快照没有接入模式时按 headless 解释，与会话存储保持一致。
  accessMode: z.enum(["headless", "acp"]).optional(),
  workspaceDir: z.string().min(1),
  ownerOpenId: z.string(),
  enabled: z.boolean(),
  lastRunAt: z.string().min(1).optional(),
  lastSkippedAt: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

/** 使用 JSON 文件保存全部定时任务快照。 */
export class JsonScheduleStore implements ScheduleStore {
  // 多次变更可能同时触发保存，Promise 队列确保快照按调用顺序落盘。
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<ScheduleTask[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) {
      throw new Error(`定时任务文件格式错误: ${this.filePath}`);
    }

    const tasks: ScheduleTask[] = [];
    let needsCleanup = false;
    for (const row of rows) {
      const result = ScheduleSchema.safeParse(row);
      if (!result.success) {
        // 单条坏记录不应阻止其他任务恢复，清理后的快照会覆盖原文件。
        needsCleanup = true;
        continue;
      }
      const task: ScheduleTask = {
        accessMode: "headless",
        ...result.data,
      };
      tasks.push(task);
    }

    if (needsCleanup) await this.save(tasks);
    return tasks;
  }

  save(tasks: ScheduleTask[]): Promise<void> {
    // 在入队前固定快照，后续内存变化不会篡改本次待写内容。
    const snapshot = JSON.stringify(tasks, null, 2);
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
