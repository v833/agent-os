/**
 * 本地 stdio MCP Server：向 Claude Code、Codex、DimAgent 与 agy 提供
 * request_clarification 工具。通过 stdio 与 CLI 子进程通信，只负责提交
 * 结构化问题，不感知飞书；工具实现与 HTTP MCP 入口共享。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerClarificationTool } from "./clarification-tools.js";

const server = new McpServer({
  name: "agent-os",
  version: "1.0.0",
});
registerClarificationTool(server);

await server.connect(new StdioServerTransport());
