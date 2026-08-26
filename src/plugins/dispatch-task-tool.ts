/**
 * dispatch-task MCP 启动描述：为插件生成独立 stdio Server 配置，并可附加
 * loopback HTTP 入口；执行引擎只消费通用 ApplicationToolServer 契约。
 */
import { fileURLToPath } from "node:url";
import type { ApplicationToolServer } from "../cli/app-tools.js";
import { DISPATCH_TASK_TOOL_NAME } from "../core/collaboration.js";

/** 生成 dispatch-task 插件注册到 application-tools 服务的 Server 描述。 */
export function dispatchTaskToolServer(acpUrl?: string): ApplicationToolServer {
  const runningFromTypeScript = import.meta.url.endsWith(".ts");
  const server = fileURLToPath(
    new URL(
      runningFromTypeScript
        ? "../mcp/dispatch-task-server.ts"
        : "../mcp/dispatch-task-server.js",
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
    id: "agent_os_dispatch_task",
    command: invocation.command,
    args: invocation.args,
    tools: [DISPATCH_TASK_TOOL_NAME],
    ...(acpUrl
      ? { acp: { type: "http" as const, url: acpUrl, headers: [] } }
      : {}),
  };
}
