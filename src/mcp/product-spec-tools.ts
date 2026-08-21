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
        "Spec 和 Tickets 已经写入当前工作区后，调用此工具提交待确认产物。",
        "specPath 指向 Spec 文件，ticketsPath 指向包含独立 Ticket 文件的目录。",
        "summary 只写便于快速了解方案的摘要，完整内容保留在文件中。",
        "提交前必须完成需求澄清；调用后不要实现代码或委派团队成员。",
      ].join(""),
      inputSchema: ProductSpecRequestSchema,
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "产品文档已交给 Agent OS，等待用户查看。",
        },
      ],
    }),
  );
}
