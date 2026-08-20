/**
 * 澄清 HTTP MCP Server：为只支持 HTTP/SSE MCP 的 ACP 引擎提供 loopback 入口。
 * 每个 POST 使用无状态 Streamable HTTP 传输，监听地址固定为 127.0.0.1，
 * 避免把 Agent OS 的澄清工具暴露到局域网或公网。
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerClarificationTool } from "./clarification-tools.js";

const DEFAULT_PORT = 0;
const HOST = "127.0.0.1";

export interface ClarificationHttpServer {
  readonly url: string;
  close(): Promise<void>;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body.trim() ? JSON.parse(body) : undefined;
}

function createServerInstance(): McpServer {
  const server = new McpServer({ name: "agent-os", version: "1.0.0" });
  registerClarificationTool(server);
  return server;
}

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
  const httpServer = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    const mcpServer = createServerInstance();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(
        request,
        response,
        await readJsonBody(request),
      );
      response.once("close", () => {
        void transport.close();
        void mcpServer.close();
      });
    } catch (error) {
      console.error("[MCP] 澄清 HTTP 请求失败:", error);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(configuredPort(), HOST);
  });
  // 测试宿主和 Agent OS 退出时不一定显式 dispose 根 Context；loopback 服务不应阻止退出。
  httpServer.unref();
  const address = httpServer.address() as AddressInfo;
  const url = `http://${HOST}:${address.port}/mcp`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
