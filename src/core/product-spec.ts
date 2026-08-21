/**
 * 产品文档提交契约：约束 request_spec_approval 的本地/飞书互斥参数，并在
 * 展示本地产物前校验 Spec 与 Tickets。它是产品文档插件的可信边界。
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { z } from "zod";

/** product-spec 插件注册到应用工具服务的稳定工具名。 */
export const PRODUCT_SPEC_TOOL_NAME = "request_spec_approval";

const WorkspaceDocumentPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => {
    const segments = value.replaceAll("\\", "/").split("/");
    return (
      !value.includes("\0") &&
      !posix.parse(value).root &&
      !win32.parse(value).root &&
      !segments.includes("..")
    );
  }, "文档路径必须位于当前工作目录内");

const ProductSpecBaseSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
});

function hasRecordProperty(
  value: Record<string, unknown>,
  property: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

/** 本地 Markdown 方案；Spec 与 Tickets 必须属于同一个 feature。 */
export const LocalProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal("local"),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema,
}).strict().superRefine((request, ctx) => {
  const specSegments = request.specPath.replaceAll("\\", "/").split("/");
  const ticketsSegments = request.ticketsPath.replaceAll("\\", "/").split("/");
  const validSpecLayout =
    specSegments.length === 3 &&
    specSegments[0] === ".scratch" &&
    Boolean(specSegments[1]) &&
    specSegments[2] === "spec.md";
  const validTicketsLayout =
    ticketsSegments.length === 3 &&
    ticketsSegments[0] === ".scratch" &&
    Boolean(ticketsSegments[1]) &&
    ticketsSegments[2] === "issues";

  if (!validSpecLayout) {
    ctx.addIssue({
      code: "custom",
      path: ["specPath"],
      message: "Spec 路径必须是 .scratch/<feature>/spec.md",
    });
  }
  if (!validTicketsLayout) {
    ctx.addIssue({
      code: "custom",
      path: ["ticketsPath"],
      message: "Tickets 路径必须是 .scratch/<feature>/issues",
    });
  }
  if (
    validSpecLayout &&
    validTicketsLayout &&
    specSegments[1] !== ticketsSegments[1]
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["ticketsPath"],
      message: "Spec 与 Tickets 必须属于同一个 feature",
    });
  }
});

const LARK_DOCUMENT_HOSTS = ["feishu.cn", "larksuite.com", "doubao.com"];

/** 只允许 HTTPS 飞书系文档链接，避免把任意外部协议渲染成可信产物。 */
const LarkDocumentUrlSchema = z
  .string()
  .trim()
  .max(2_048, "documentUrl 不能超过 2048 个字符")
  .url()
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    const hostname = url.hostname.toLowerCase();
    const trustedHost = LARK_DOCUMENT_HOSTS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
    if (url.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        message: "documentUrl 必须使用 HTTPS",
      });
    }
    if (!trustedHost) {
      ctx.addIssue({
        code: "custom",
        message: "documentUrl 必须使用飞书、Lark 或豆包文档域名",
      });
    }
    if (url.username || url.password || url.port) {
      ctx.addIssue({
        code: "custom",
        message: "documentUrl 不能包含账号、密码或自定义端口",
      });
    }
    if (!/^\/(?:docx|wiki)\//.test(url.pathname)) {
      ctx.addIssue({
        code: "custom",
        message: "documentUrl 路径必须以 /docx/ 或 /wiki/ 开头",
      });
    }
  });

/** 飞书方案只提交已创建文档的 URL，不接受本地路径。 */
export const LarkProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal("lark-doc"),
  documentUrl: LarkDocumentUrlSchema,
}).strict();

/** 已完成澄清、可交给任务发起人审阅的唯一产品方案产物。 */
const ProductSpecDiscriminatedUnionSchema = z.discriminatedUnion("deliveryMode", [
  LocalProductSpecRequestSchema,
  LarkProductSpecRequestSchema,
]);

/**
 * 兼容上一版本只提交 specPath/ticketsPath 的本地调用；归一化后仍只向
 * 产品流程暴露带 deliveryMode 的新契约，避免旧 bot 的工具调用静默丢失。
 */
export const ProductSpecRequestSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    if (
      !hasRecordProperty(record, "deliveryMode") &&
      hasRecordProperty(record, "specPath") &&
      hasRecordProperty(record, "ticketsPath")
    ) {
      return { ...record, deliveryMode: "local" };
    }
    return input;
  },
  ProductSpecDiscriminatedUnionSchema,
);

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>;
export type LocalProductSpecRequest = z.infer<
  typeof LocalProductSpecRequestSchema
>;

/** 已落盘、等待任务发起人确认的产品方案流程状态。 */
export interface ProductSpecFlow {
  token: string;
  taskId: string;
  botId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  cardMessageId?: string;
  workspaceDir: string;
  request: ProductSpecRequest;
  /** 本地模式提交时的内容指纹；确认时必须仍然一致。 */
  documentRevision?: string;
  status: "pending" | "approved" | "expired";
  approvedAt?: string;
}

/** 创建产品方案确认流程所需的任务、操作者、卡片和文档信息。 */
export interface CreateProductSpecFlowOptions {
  taskId: string;
  botId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  cardMessageId?: string;
  workspaceDir: string;
  request: ProductSpecRequest;
  documentRevision?: string;
}

/** 判断操作者是否与提交产品方案的任务发起人一致。 */
export function isProductSpecOwner(
  flow: Pick<ProductSpecFlow, "ownerOpenId" | "ownerUnionId">,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId;
  }
  return flow.ownerOpenId === operator.operatorOpenId;
}

/** 产品方案确认状态的内存 Store；服务重启后旧 token 会自然失效。 */
export class ProductSpecFlowStore {
  private readonly flows = new Map<string, ProductSpecFlow>();

  create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    const flow = this.prepare(options);
    this.publish(flow.token);
    return flow;
  }

  /** 先创建待发布 Flow；卡片发布成功后再调用 publish 提交替换。 */
  prepare(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    const flow: ProductSpecFlow = {
      token: randomUUID().replaceAll("-", ""),
      ...options,
      status: "pending",
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  publish(token: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== "pending") return undefined;
    const { taskId, botId } = flow;
    for (const flow of this.flows.values()) {
      if (
        flow.token !== token &&
        flow.taskId === taskId &&
        flow.botId === botId &&
        flow.status === "pending"
      ) {
        flow.status = "expired";
      }
    }
    return flow;
  }

  get(token: string): ProductSpecFlow | undefined {
    return this.flows.get(token);
  }

  approve(token: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== "pending") return undefined;
    flow.status = "approved";
    flow.approvedAt = new Date().toISOString();
    return flow;
  }
}

/** 计算已校验 Spec 与 Tickets Markdown 文件的稳定内容指纹。 */
export async function productSpecDocumentRevision(
  workspaceDir: string,
  request: LocalProductSpecRequest,
): Promise<string> {
  const specPath = await resolveExistingWorkspacePath(workspaceDir, request.specPath);
  const ticketsPath = await resolveExistingWorkspacePath(workspaceDir, request.ticketsPath);
  const entries = (await readdir(ticketsPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  if (!entries.length) {
    throw new Error("Tickets 目录至少需要一个 Markdown 文件");
  }
  const hash = createHash("sha256");
  hash.update(request.specPath);
  hash.update("\0");
  hash.update(request.ticketsPath);
  hash.update("\0");
  hash.update(await readFile(specPath));
  for (const name of entries) {
    hash.update("\0");
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(resolve(ticketsPath, name)));
  }
  return hash.digest("hex");
}

/** 从工具调用历史中提取最近一次通过校验的产品文档提交。 */
export function findProductSpecRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ProductSpecRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== PRODUCT_SPEC_TOOL_NAME) continue;
    const parsed = ProductSpecRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

async function resolveExistingWorkspacePath(
  workspaceDir: string,
  documentPath: string,
): Promise<string> {
  const workspace = await realpath(resolve(workspaceDir));
  const candidate = await realpath(resolve(workspace, documentPath));
  const relation = relative(workspace, candidate);
  // Schema 已拒绝绝对路径和 ..；这里基于 realpath 再校验一次，防止符号链接逃逸。
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error("文档路径必须位于当前工作目录内");
  }
  return candidate;
}

/**
 * 确认 Spec 是真实文件，Tickets 是至少包含一个 Markdown 工作项的真实目录。
 * 所有路径都要经过 realpath 包含关系校验，不能只相信模型提交的字符串。
 */
export async function assertProductSpecDocuments(
  workspaceDir: string,
  request: LocalProductSpecRequest,
): Promise<void> {
  const missing: string[] = [];

  try {
    const specPath = await resolveExistingWorkspacePath(
      workspaceDir,
      request.specPath,
    );
    const info = await stat(specPath);
    if (!info.isFile()) missing.push(`Spec: ${request.specPath}`);
  } catch {
    missing.push(`Spec: ${request.specPath}`);
  }

  try {
    const ticketsPath = await resolveExistingWorkspacePath(
      workspaceDir,
      request.ticketsPath,
    );
    const info = await stat(ticketsPath);
    const entries = info.isDirectory()
      ? await readdir(ticketsPath, { withFileTypes: true })
      : [];
    const hasTicket = entries.some(
      (entry) => entry.isFile() && entry.name.endsWith(".md"),
    );
    if (!info.isDirectory() || !hasTicket) {
      missing.push(`Tickets: ${request.ticketsPath}`);
    }
  } catch {
    missing.push(`Tickets: ${request.ticketsPath}`);
  }

  if (missing.length) {
    throw new Error(
      [
        "产品方案尚未完整写入工作区，不能展示。",
        ...missing.map((item) => `- ${item}`),
      ].join("\n"),
    );
  }
}
