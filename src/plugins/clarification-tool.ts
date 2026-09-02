/**
 * clarification MCP 启动描述：计算独立 server 在源码与构建产物中的入口。
 * 插件和无飞书探针共享这份描述，CLI 适配器仍只消费通用 MCP 契约。
 */
import { fileURLToPath } from "node:url";
import { CLARIFICATION_TOOL_NAME } from "../core/clarification.js";
import type { ApplicationToolServer } from "../cli/app-tools.js";

/** 生成 clarification 插件注册到 application-tools 服务的 server 描述。 */
export function clarificationToolServer(acpUrl?: string): ApplicationToolServer {
  const runningFromTypeScript = import.meta.url.endsWith(".ts");
  const server = fileURLToPath(
    new URL(
      runningFromTypeScript
        ? "../mcp/clarification-server.ts"
        : "../mcp/clarification-server.js",
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
    id: "threadpilot_clarification",
    command: invocation.command,
    args: invocation.args,
    tools: [CLARIFICATION_TOOL_NAME],
    ...(acpUrl
      ? { acp: { type: "http" as const, url: acpUrl, headers: [] } }
      : {}),
  };
}
