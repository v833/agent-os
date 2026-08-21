/**
 * 产品文档提交契约：约束 request_spec_approval 的结构化参数，并在展示前
 * 校验 Spec 与 Tickets 确实落在当前工作区。它是产品文档插件的可信边界。
 */
import { readdir, realpath, stat } from "node:fs/promises";
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

/** 已完成澄清、可交给任务发起人审阅的一组产品产物。 */
export const ProductSpecRequestSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema,
}).superRefine((request, ctx) => {
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

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>;

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
  request: ProductSpecRequest,
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
