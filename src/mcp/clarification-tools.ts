/**
 * 澄清 MCP 工具定义：同时供 stdio 与 loopback HTTP 传输复用。
 * 工具只返回“已提交”确认，实际问题收集由 ThreadPilot 澄清插件接管。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CLARIFICATION_TOOL_NAME,
  ClarificationRequestSchema,
} from "../core/clarification.js";

/** 把 request_clarification 注册到任意 MCP Server 实例。 */
export function registerClarificationTool(server: McpServer): void {
  server.registerTool(
    CLARIFICATION_TOOL_NAME,
    {
      title: "向用户提问",
      description: [
        "当产品需求仍有会实质影响方案的歧义时，调用此工具提交结构化问题。",
        "一次最多提交 5 个问题，每题提供 2 到 4 个清晰选项。",
        "提交后不要自行补全用户答案，本轮回复可以简短收束。",
      ].join(""),
      inputSchema: ClarificationRequestSchema,
    },
    async ({ questions }) => ({
      content: [
        {
          type: "text",
          text: `已提交 ${questions.length} 个结构化问题，等待 ThreadPilot 展示给用户并收集回答。`,
        },
      ],
    }),
  );
}
