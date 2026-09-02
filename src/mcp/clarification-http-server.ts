/**
 * 澄清 HTTP MCP Server：为只支持 HTTP/SSE MCP 的 ACP 引擎提供 loopback 入口。
 * 每个 POST 使用无状态 Streamable HTTP 传输，监听地址固定为 127.0.0.1，
 * 避免把 ThreadPilot 的澄清工具暴露到局域网或公网。
 */
import { registerClarificationTool } from "./clarification-tools.js";
import {
  startLoopbackMcpHttpServer,
  type LoopbackMcpHttpServer,
} from "./loopback-http-server.js";

const DEFAULT_PORT = 0;
export type ClarificationHttpServer = LoopbackMcpHttpServer;

function configuredPort(): number {
  const raw = process.env.AGENT_OS_MCP_HTTP_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`AGENT_OS_MCP_HTTP_PORT 必须是 0 到 65535 的整数: ${raw}`);
  }
  return port;
}

/** 启动仅供本机 ACP 客户端访问的澄清 HTTP MCP Server。 */
export async function startClarificationHttpServer(): Promise<ClarificationHttpServer> {
  return startLoopbackMcpHttpServer({
    register: registerClarificationTool,
    label: "澄清",
    port: configuredPort(),
  });
}
