/**
 * 产品文档 stdio MCP Server：向各 headless CLI 提供 request_spec_approval。
 * 它只承载结构化工具协议，不访问工作区，也不感知飞书。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerProductSpecTool } from "./product-spec-tools.js";

const server = new McpServer({
  name: "threadpilot",
  version: "1.0.0",
});
registerProductSpecTool(server);

await server.connect(new StdioServerTransport());
