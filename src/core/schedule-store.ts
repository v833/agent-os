/**
 * 定时任务计划持久化层：保存 schedules.json 中的计划本身，运行记录由
 * schedule-run-store 分离存储。内存 Map 提供快照查询，写盘用临时文件 +
 * rename 原子替换，坏记录在加载时被过滤，不阻断其余任务恢复。
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  ScheduleRuleSchema,
  createScheduledTask,
  type CreateScheduledTask,
  type ScheduledTask,
} from "./schedule.js";

/** 计划记录的严格校验；watcher 也用它逐条校验 schedules.json。 */
export const ScheduledTaskSchema = z.object({
  id: z.string().min(1),
  creatorOpenId: z.string().min(1),
  chatId: z.string().min(1),
  targetBotId: z.string().min(1),
  prompt: z.string().min(1),
  rule: ScheduleRuleSchema,
  status: z.enum(["active", "paused", "completed"]),
  nextRunAt: z.string().optional(),
  lastRunAt: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

/** 内存计划存储；JsonScheduleStore 在基类基础上补齐落盘。 */
export class ScheduleStore {
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(initialTasks: ScheduledTask[] = []) {
    for (const task of initialTasks) this.tasks.set(task.id, task);
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  create(options: CreateScheduledTask & { id?: string }): ScheduledTask {
    const task = createScheduledTask(options);
    if (this.tasks.has(task.id)) {
      throw new Error(`定时任务 ID 已存在: ${task.id}`);
    }
    this.tasks.set(task.id, task);
    return task;
  }

  update(id: string, patch: Partial<ScheduledTask>): ScheduledTask | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const updated = ScheduledTaskSchema.parse({
      ...current,
      ...patch,
      id: current.id,
      updatedAt: new Date().toISOString(),
    });
    this.tasks.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  protected snapshot(): ScheduledTask[] {
    return structuredClone([...this.tasks.values()]);
  }

  protected restore(tasks: ScheduledTask[]): void {
    this.tasks.clear();
    for (const task of tasks) this.tasks.set(task.id, task);
  }
}

/** 落盘到 data/schedules.json 的计划存储；写失败时回滚内存。 */
export class JsonScheduleStore extends ScheduleStore {
  constructor(private readonly filePath: string) {
    super(loadTasks(filePath));
    // 启动即规范化：过滤掉坏记录后的结果立即落盘，文件格式始终一致。
    this.persist();
  }

  override create(options: CreateScheduledTask & { id?: string }): ScheduledTask {
    return this.mutate(() => super.create(options));
  }

  override update(
    id: string,
    patch: Partial<ScheduledTask>,
  ): ScheduledTask | undefined {
    return this.mutate(() => super.update(id, patch));
  }

  override delete(id: string): boolean {
    return this.mutate(() => super.delete(id));
  }

  private mutate<T>(operation: () => T): T {
    const previous = this.snapshot();
    try {
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(this.snapshot(), null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, this.filePath);
  }
}

function loadTasks(filePath: string): ScheduledTask[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`定时任务状态文件格式错误: ${filePath}`);
  }
  return rows.flatMap((row) => {
    const result = ScheduledTaskSchema.safeParse(row);
    return result.success ? [result.data] : [];
  });
}
