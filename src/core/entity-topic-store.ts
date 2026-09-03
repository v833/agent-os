/**
 * 外部实体与飞书群话题的 1:1 映射存储：entityKey = `${source}:${entityId}`，
 * 绑定首次事件建出的根消息与话题，后续事件在同一话题内追加，保持增量上下文。
 * 持久化到 data/entity-topics.json（临时文件 + rename 原子替换，坏记录过滤）。
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const EntityTopicSchema = z.object({
  /** 稳定唯一键：`${source}:${entityId}`。 */
  entityKey: z.string().min(1),
  source: z.string().min(1),
  entityId: z.string().min(1),
  /** 话题所在飞书群 chat_id。 */
  chatId: z.string().min(1),
  /** 首次事件建立的根消息 message_id。 */
  rootMessageId: z.string().min(1),
  /** 话题 thread_id；无子话题时为空字符串（直接串在根消息下）。 */
  threadId: z.string().default(""),
  status: z.enum(["open", "closed"]).default("open"),
  firstEventAt: z.string().datetime(),
  lastEventAt: z.string().datetime(),
  eventCount: z.number().int().nonnegative().default(1),
  /** 最近一次事件摘要，用于话题内上下文提示。 */
  lastSummary: z.string().default(""),
});

export type EntityTopic = z.infer<typeof EntityTopicSchema>;

/** 打开状态的话题列表；关闭状态保留记录以便后续事件重新开话题。 */
export class EntityTopicStore {
  private readonly topics = new Map<string, EntityTopic>();

  constructor(initialTopics: EntityTopic[] = []) {
    for (const topic of initialTopics) this.topics.set(topic.entityKey, topic);
  }

  list(): EntityTopic[] {
    return [...this.topics.values()];
  }

  listOpen(): EntityTopic[] {
    return this.list().filter((topic) => topic.status === "open");
  }

  get(entityKey: string): EntityTopic | undefined {
    return this.topics.get(entityKey);
  }

  /** 按飞书群与话题根消息反查实体映射；egress 据此把任务进度回传外部。 */
  findByThread(chatId: string, rootMessageId: string): EntityTopic | undefined {
    return this.list().find(
      (topic) =>
        topic.chatId === chatId &&
        (topic.rootMessageId === rootMessageId || topic.threadId === rootMessageId),
    );
  }

  upsert(topic: EntityTopic): EntityTopic {
    this.topics.set(topic.entityKey, topic);
    return topic;
  }

  close(entityKey: string): EntityTopic | undefined {
    const current = this.topics.get(entityKey);
    if (!current) return undefined;
    const updated = { ...current, status: "closed" as const };
    this.topics.set(entityKey, updated);
    return updated;
  }

  protected snapshot(): EntityTopic[] {
    return structuredClone(this.list());
  }

  protected restore(topics: EntityTopic[]): void {
    this.topics.clear();
    for (const topic of topics) this.topics.set(topic.entityKey, topic);
  }
}

/** 落盘到 data/entity-topics.json 的映射存储；写失败时回滚内存。 */
export class JsonEntityTopicStore extends EntityTopicStore {
  constructor(private readonly filePath: string) {
    super(loadTopics(filePath));
    this.persist();
  }

  override upsert(topic: EntityTopic): EntityTopic {
    return this.mutate(() => super.upsert(topic));
  }

  override close(entityKey: string): EntityTopic | undefined {
    return this.mutate(() => super.close(entityKey));
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

function loadTopics(filePath: string): EntityTopic[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`实体话题映射文件格式错误: ${filePath}`);
  }
  return rows.flatMap((row) => {
    const result = EntityTopicSchema.safeParse(row);
    return result.success ? [result.data] : [];
  });
}

/** 组装 entityKey：外部实体键由来源与实体 ID 唯一确定。 */
export function entityKeyOf(source: string, entityId: string): string {
  return `${source}:${entityId}`;
}
