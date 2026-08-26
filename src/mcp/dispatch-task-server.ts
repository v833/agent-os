/**
 * 团队派发 stdio MCP Server：向 headless CLI 暴露 dispatch_task。
 * 它只承载结构化协议，不访问团队配置或飞书平台。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDispatchTaskTool } from "./dispatch-task-tools.js";

const server = new McpServer({
  name: "agent-os",
  version: "1.0.0",
});
registerDispatchTaskTool(server);

await server.connect(new StdioServerTransport());
