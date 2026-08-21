/**
 * product-spec 产品文档插件：注册 request_spec_approval MCP Server，认领产品
 * bot 的工具结果，验证 Spec/Tickets 真实落盘后生成只读待确认卡片。
 */
import type { Context } from "cordis";
import {
  assertProductSpecDocuments,
  findProductSpecRequest,
} from "../core/product-spec.js";
import { startLoopbackMcpHttpServer } from "../mcp/loopback-http-server.js";
import { registerProductSpecTool } from "../mcp/product-spec-tools.js";
import { productSpecToolServer } from "./product-spec-tool.js";
import type {
  TaskToolCallsOutcome,
  TaskToolCallsPayload,
} from "./types.js";

async function handleToolCalls(
  ctx: Context,
  payload: TaskToolCallsPayload,
): Promise<TaskToolCallsOutcome | undefined> {
  if (!payload.botConfig.skills.includes("to-spec")) return undefined;
  const request = findProductSpecRequest(payload.result.toolCalls);
  if (!request) return undefined;

  await assertProductSpecDocuments(payload.session.workspaceDir, request);
  console.log(
    `[产品文档] 已校验 Spec=${request.specPath} Tickets=${request.ticketsPath}`,
  );
  return {
    card: ctx.cards.productSpecReady({ request }),
    completion: "completed",
    notificationText: "Spec 和 Tickets 已经落盘，请查看上方产物卡片。",
    suppressHandoff: true,
  };
}

export const name = "product-spec";
export const inject = ["applicationTools", "cards"];

export async function apply(ctx: Context) {
  // ACP 引擎可能只支持 HTTP/SSE MCP；独立 loopback 入口让本插件可以单独下线。
  const httpServer = await startLoopbackMcpHttpServer({
    register: registerProductSpecTool,
    label: "产品文档",
  });
  const unregister = ctx.applicationTools.register(
    productSpecToolServer(httpServer.url),
  );
  ctx.effect(() => () => httpServer.close(), "product-spec MCP HTTP");
  ctx.on("task/tool-calls", (payload) => handleToolCalls(ctx, payload));
  return unregister;
}
