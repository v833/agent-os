/**
 * 团队派发 MCP 工具定义：只提交结构化派发意图，权限与真实飞书投递由
 * dispatch-task 插件在 CLI 结束后校验并执行。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DISPATCH_TASK_TOOL_NAME,
  DispatchTaskRequestSchema,
} from "../core/collaboration.js";

/** 把 dispatch_task 注册到任意 MCP Server 实例。 */
export function registerDispatchTaskTool(server: McpServer): void {
  server.registerTool(
    DISPATCH_TASK_TOOL_NAME,
    {
      title: "把任务交给团队成员",
      description: [
        "把任务确定性地交给一名已注册的长期团队成员。",
        "只有 Team Leader 可以在运行时调用；其他成员调用会被拒绝。",
        "targetBotId 必须来自团队名单，且不能填写自己。",
        "objective 写协作目标，instruction 写完整要求，expectedOutput 写期望产出。",
        "调用后停止本轮工作，等待成员完成并把结果交回编排者。",
      ].join(""),
      inputSchema: DispatchTaskRequestSchema,
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "派发请求已交给 Agent OS，等待协作任务送达目标成员。",
        },
      ],
    }),
  );
}
