/**
 * 产品方案 Flow 的 JSON 持久化：把待确认云文档与原产品会话的关联保存到磁盘，
 * 让 Agent OS 重启后仍能接收旧文档评论。写盘采用临时文件加原子替换，避免进程
 * 中断留下半份 JSON，评论路由也不会读取到损坏状态。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  ProductSpecFlowStore,
  ProductSpecRequestSchema,
  type CreateProductSpecFlowOptions,
  type ProductSpecFlow,
} from "./product-spec.js";

const PersistedProductSpecFlowSchema = z.object({
  token: z.string().min(1),
  taskId: z.string().min(1),
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerOpenId: z.string(),
  ownerUnionId: z.string().optional(),
  collaboration: z.object({
    taskId: z.string().min(1),
    fromBotId: z.string().min(1),
    reportToBotId: z.string().min(1),
    round: z.number().int().min(1),
    maxRounds: z.number().int().min(1),
  }).optional(),
  cardMessageId: z.string().optional(),
  workspaceDir: z.string().min(1),
  request: ProductSpecRequestSchema,
  documentRevision: z.string().optional(),
  status: z.enum(["pending", "approved", "expired"]),
  approvedAt: z.string().optional(),
});

const PersistedProductSpecFlowsSchema = z.array(
  PersistedProductSpecFlowSchema,
);

/**
 * 带 JSON 文件存储的产品方案 Flow Store。所有会改变状态的入口都在成功后持久化，
 * `prepare` 也必须落盘，因为卡片发布与进程重启之间可能存在时间窗口。
 */
export class JsonProductSpecFlowStore extends ProductSpecFlowStore {
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath));
  }

  override prepare(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    return this.mutate(() => super.prepare(options));
  }

  override publish(token: string): ProductSpecFlow | undefined {
    return this.mutate(() => super.publish(token));
  }

  override approve(token: string): ProductSpecFlow | undefined {
    return this.mutate(() => super.approve(token));
  }

  private mutate<T>(operation: () => T): T {
    const value = operation();
    this.persist();
    return value;
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

function loadFlows(filePath: string): ProductSpecFlow[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `产品方案 Flow 文件格式错误: ${(error as Error).message}`,
    );
  }
  const result = PersistedProductSpecFlowsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `产品方案 Flow 文件校验失败: ${result.error.message}`,
    );
  }
  return result.data;
}
