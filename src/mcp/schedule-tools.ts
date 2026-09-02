/**
 * schedule_manage MCP 工具定义：handler 不在子进程里操作数据，而是把请求
 * 转发给主进程的内部 HTTP API（POST /api/schedules/manage）当场执行，
 * 并把真实落盘结果回传给模型。会话上下文（chatId / creatorOpenId）由主进程
 * 在启动 CLI 时通过环境变量注入。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SCHEDULE_MANAGE_TOOL_NAME,
  ScheduleManageRequestSchema,
} from "../core/schedule.js";

interface ScheduleToolContext {
  chatId?: string;
  creatorOpenId?: string;
}

async function callScheduleManage(
  input: unknown,
  context: ScheduleToolContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const chatId = context.chatId ?? process.env.THREADPILOT_CHAT_ID;
  const creatorOpenId =
    context.creatorOpenId ?? process.env.THREADPILOT_OWNER_OPEN_ID;
  if (!chatId || !creatorOpenId) {
    return {
      content: [
        {
          type: "text",
          text: "缺少 THREADPILOT_CHAT_ID / THREADPILOT_OWNER_OPEN_ID，MCP 子进程没有拿到当前会话上下文。",
        },
      ],
      isError: true,
    };
  }
  const port = Number(process.env.SCHEDULE_API_PORT ?? 3101);
  const token = process.env.SCHEDULE_API_TOKEN;
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/schedules/manage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-api-token": token } : {}),
      },
      body: JSON.stringify({ request: input, chatId, creatorOpenId }),
    });
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `无法连接 ThreadPilot 定时任务管理接口：${(error as Error).message}`,
        },
      ],
      isError: true,
    };
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { notice?: string; error?: string; issues?: unknown }
    | undefined;
  if (!response.ok) {
    const detail = payload?.issues
      ? `\n${JSON.stringify(payload.issues, null, 2)}`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `定时任务管理失败（${response.status}）：${payload?.error ?? "未知错误"}${detail}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: payload?.notice ?? "定时任务管理完成。",
      },
    ],
  };
}

/** 把 schedule_manage 注册到任意 MCP Server 实例。 */
export function registerScheduleManageTool(
  server: McpServer,
  context: ScheduleToolContext = {},
): void {
  server.registerTool(
    SCHEDULE_MANAGE_TOOL_NAME,
    {
      title: "管理定时任务",
      description: [
        "统一管理定时任务，action 支持：",
        "list 列出全部计划；add 创建一个；addMany 批量创建；update 编辑一个；remove 删除一个；removeMany 按 ids 批量删除；removeAll 删除全部（必须 confirm=true）；run 立即执行；pause 暂停；resume 恢复；logs 查看运行记录。",
        "targetBotId 选择团队中负责执行的成员，prompt 保留完整任务要求，rule 使用一次性、固定间隔或 Cron 规则。",
        "批量删除和删除全部属于高影响操作，先 list 确认 id 再执行。",
      ].join(""),
      inputSchema: ScheduleManageRequestSchema,
    },
    async (input) => callScheduleManage(input, context),
  );
}
