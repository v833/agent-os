/**
 * 应用工具共用的 loopback HTTP MCP 传输：把任意工具注册函数包装成无状态
 * Streamable HTTP Server。业务插件仍分别拥有工具定义、端口和生命周期。
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const HOST = "127.0.0.1";

export interface LoopbackMcpHttpServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface LoopbackMcpHttpServerOptions {
  register(server: McpServer, request: IncomingMessage): void;
  label: string;
  port?: number;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body.trim() ? JSON.parse(body) : undefined;
}

/** 启动只监听 127.0.0.1 的无状态 HTTP MCP Server。 */
export async function startLoopbackMcpHttpServer(
  options: LoopbackMcpHttpServerOptions,
): Promise<LoopbackMcpHttpServer> {
  const httpServer = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    const mcpServer = new McpServer({ name: "agent-os", version: "1.0.0" });
    options.register(mcpServer, request);
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
      console.error(`[MCP] ${options.label} HTTP 请求失败:`, error);
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

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolvePromise();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(options.port ?? 0, HOST);
  });
  // 插件测试和 Agent OS 退出时不一定显式 dispose 根 Context，loopback 服务不应阻止退出。
  httpServer.unref();
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://${HOST}:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        httpServer.close((error) =>
          error ? reject(error) : resolvePromise(),
        );
      }),
  };
}
