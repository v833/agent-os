/**
 * schedule_manage stdio MCP Server：向 headless CLI 暴露统一定时任务管理工具。
 * 它不直接访问数据，而是把请求转发给主进程的内部 HTTP API 当场执行。
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerScheduleManageTool } from "./schedule-tools.js";

const server = new McpServer({
  name: "agent-os",
  version: "1.0.0",
});
registerScheduleManageTool(server);

await server.connect(new StdioServerTransport());
