/**
 * schedule_manage MCP 启动描述：为插件生成独立 stdio Server 配置，并可附加
 * loopback HTTP 入口；各 CLI 适配器只消费通用 ApplicationToolServer 契约。
 */
import { fileURLToPath } from "node:url";
import type { ApplicationToolServer } from "../cli/app-tools.js";
import { SCHEDULE_MANAGE_TOOL_NAME } from "../core/schedule.js";

/** 生成 schedule 插件注册到 application-tools 服务的 Server 描述。 */
export function scheduleManageToolServer(acpUrl?: string): ApplicationToolServer {
  const runningFromTypeScript = import.meta.url.endsWith(".ts");
  const server = fileURLToPath(
    new URL(
      runningFromTypeScript
        ? "../mcp/schedule-server.ts"
        : "../mcp/schedule-server.js",
      import.meta.url,
    ),
  );
  const invocation = runningFromTypeScript
    ? {
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
          ),
          server,
        ],
      }
    : { command: process.execPath, args: [server] };
  return {
    id: "agent_os_schedule_manage",
    command: invocation.command,
    args: invocation.args,
    tools: [SCHEDULE_MANAGE_TOOL_NAME],
    ...(acpUrl
      ? {
          acp: {
            type: "http" as const,
            url: acpUrl,
            headersFromEnv: [
              { name: "x-agent-os-chat-id", env: "AGENT_OS_CHAT_ID" },
              {
                name: "x-agent-os-owner-open-id",
                env: "AGENT_OS_OWNER_OPEN_ID",
              },
            ],
          },
        }
      : {}),
  };
}
