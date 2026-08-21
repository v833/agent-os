/**
 * 产品文档 MCP 工具定义：同时供 stdio 与 loopback HTTP 传输复用。
 * 工具只提交产物元数据，文件真实性由 Agent OS 产品文档插件校验。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PRODUCT_SPEC_TOOL_NAME,
  ProductSpecRequestSchema,
} from "../core/product-spec.js";

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
      ].join(""),
      inputSchema: ProductSpecRequestSchema,
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "唯一的产品方案产物已交给 Agent OS，等待用户查看。",
        },
      ],
    }),
  );
}
