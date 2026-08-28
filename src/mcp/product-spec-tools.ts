/**
 * 产品文档 MCP 工具定义：同时供 stdio 与 loopback HTTP 传输复用。
 * 工具只提交产物元数据，文件真实性由 Agent OS 产品文档插件校验。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PRODUCT_SPEC_TOOL_NAME,
  ProductSpecRequestSchema,
} from "../core/product-spec.js";

/**
 * 暴露给 CLI 的参数 Schema：MCP SDK 的 normalizeObjectSchema 只认 z.object
 * （def.type === "object" 或有 shape），而 ProductSpecRequestSchema 用
 * z.preprocess 包装（def.type === "pipe"），会被判为“无 shape”而退化成空
 * schema——模型看不到任何字段，只能靠猜把参数包进 {"properties": {...}}，
 * 服务端顶层校验又必然失败，表现为“调用了 request_spec_approval 但从未通过”。
 * 因此这里用扁平 z.object 暴露字段供模型理解；最终严格校验（互斥、路径格式、
 * 旧客户端省略 deliveryMode 的兼容）仍在 handler 里用 ProductSpecRequestSchema 完成。
 */
const ProductSpecToolInputSchema = z.object({
  deliveryMode: z
    .enum(["local", "lark-doc"])
    .optional()
    .describe(
      "产物交付方式：local=本地 Markdown（specPath+ticketsPath），lark-doc=飞书云文档（documentUrl）。省略时按 local 兼容旧客户端。",
    ),
  title: z.string().describe("产品方案标题"),
  summary: z.string().describe("产品方案摘要；完整内容保留在所选产物中"),
  specPath: z
    .string()
    .optional()
    .describe("deliveryMode=local 时必填：.scratch/<feature>/spec.md"),
  ticketsPath: z
    .string()
    .optional()
    .describe("deliveryMode=local 时必填：.scratch/<feature>/issues"),
  documentUrl: z
    .string()
    .optional()
    .describe(
      "deliveryMode=lark-doc 时必填：lark-cli docs +create/+update 成功结果中的 document.url（必须是 docx 链接）",
    ),
});

/** 把 request_spec_approval 注册到任意 MCP Server 实例。 */
export function registerProductSpecTool(server: McpServer): void {
  server.registerTool(
    PRODUCT_SPEC_TOOL_NAME,
    {
      title: "提交产品文档",
      description: [
        "产品方案已经生成后，调用此工具提交唯一的待确认产物。",
        "deliveryMode=local 时提交 specPath 与 ticketsPath，并确保文件真实存在。",
        "deliveryMode=lark-doc 时只提交 documentUrl，且必须使用 lark-doc 创建或更新成功结果中的 document.url；文档必须同时包含产品说明与「实现任务（Tickets）」章节。",
        "同一份方案不要同时维护本地 Markdown 和飞书云文档，避免两个来源互相覆盖。",
        "旧版本本地客户端省略 deliveryMode 时按 local 兼容处理。",
        "summary 只写便于快速了解方案的摘要，完整内容保留在所选产物中。",
        "提交前必须完成需求澄清；调用后不要实现代码或委派团队成员。",
        "参数必须放在调用顶层（deliveryMode、title、summary、specPath、ticketsPath、documentUrl），不要用 properties 之类的包装。",
      ].join(""),
      inputSchema: ProductSpecToolInputSchema,
    },
    async (input) => {
      const parsed = ProductSpecRequestSchema.safeParse(input);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "参数"}: ${issue.message}`)
          .join("；");
        return {
          content: [
            {
              type: "text",
              text: `提交参数不符合产品文档契约：${detail}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: "唯一的产品方案产物已交给 Agent OS，等待用户查看。",
          },
        ],
      };
    },
  );
}
