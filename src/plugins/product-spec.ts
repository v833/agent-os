/**
 * product-spec 产品文档插件：注册 request_spec_approval MCP Server，认领产品
 * bot 的工具结果，强制完成前的真实提交校验，验证产物并管理确认卡状态流转。
 */
import { Service, type Context } from "cordis";
import { resolve } from "node:path";
import { ensureProductSpecSubmission } from "../app/product-spec-submission.js";
import {
  assertProductSpecDocuments,
  findProductSpecRequest,
  isProductSpecOwner,
  productSpecDocumentRevision,
  ProductSpecFlowStore,
} from "../core/product-spec.js";
import { JsonProductSpecFlowStore } from "../core/product-spec-store.js";
import type { CardAction, CardActionResponse } from "../im/lark.js";
import { startLoopbackMcpHttpServer } from "../mcp/loopback-http-server.js";
import { registerProductSpecTool } from "../mcp/product-spec-tools.js";
import { productSpecToolServer } from "./product-spec-tool.js";
import type {
  TaskCompletionCheckOutcome,
  TaskCompletionCheckPayload,
  TaskToolCallsOutcome,
  TaskToolCallsPayload,
} from "./types.js";

const PRODUCT_SPEC_SKILLS = new Set(["to-spec", "to-tickets", "lark-doc"]);

function managesProductSpec(skills: readonly string[]): boolean {
  return skills.some((skill) => PRODUCT_SPEC_SKILLS.has(skill));
}

/** 产品方案确认服务；状态与回调都归属于本插件。 */
export class ProductSpecService extends Service {
  readonly flows: ProductSpecFlowStore;

  constructor(ctx: Context, flows: ProductSpecFlowStore = new ProductSpecFlowStore()) {
    super(ctx, "productSpec");
    this.flows = flows;
  }

  async handleToolCalls(
    payload: TaskToolCallsPayload,
  ): Promise<TaskToolCallsOutcome | undefined> {
    if (!managesProductSpec(payload.botConfig.skills)) return undefined;
    const request = findProductSpecRequest(payload.result.toolCalls);
    if (!request) return undefined;

    let documentRevision: string | undefined;
    if (request.deliveryMode === "local") {
      await assertProductSpecDocuments(payload.session.workspaceDir, request);
      documentRevision = await productSpecDocumentRevision(
        payload.session.workspaceDir,
        request,
      );
    }
    const flow = this.flows.prepare({
      taskId: payload.taskId ?? payload.session.id,
      botId: payload.botConfig.id,
      sessionId: payload.session.id,
      ownerOpenId: payload.senderOpenId,
      ownerUnionId: payload.senderUnionId,
      cardMessageId: payload.cardMessageId,
      workspaceDir: payload.session.workspaceDir,
      request,
      documentRevision,
    });
    console.log(
      request.deliveryMode === "local"
        ? `[产品文档] 已校验 Spec=${request.specPath} Tickets=${request.ticketsPath}`
        : `[产品文档] 已接收飞书云文档 ${request.documentUrl}`,
    );
    return {
      card: this.ctx.cards.productSpecApproval(flow),
      completion: "completed",
      notificationText: "产品方案已生成，请查看上方确认卡片。",
      suppressHandoff: true,
      afterCardPublished: () => {
        this.flows.publish(flow.token);
      },
    };
  }

  /**
   * 产品 bot 成功收尾前强制检查真实提交；缺失时只沿用当前 CLI 会话纠正一次。
   * 返回替代结果后仍由 task/tool-calls 统一验证产物并生成确认卡。
   */
  async checkCompletion(
    payload: TaskCompletionCheckPayload,
  ): Promise<TaskCompletionCheckOutcome | undefined> {
    if (!managesProductSpec(payload.botConfig.skills)) return undefined;
    const result = await ensureProductSpecSubmission({
      result: payload.result,
      runCorrection: payload.runCorrection,
    });
    return result === payload.result ? undefined : { result };
  }

  async handleCardAction(
    action: CardAction,
    botId: string,
  ): Promise<CardActionResponse | undefined> {
    if (action.value.action !== "approve_product_spec") return undefined;
    const flowToken =
      typeof action.value.flowToken === "string" ? action.value.flowToken : "";
    const flow = this.flows.get(flowToken);
    if (
      !flow ||
      flow.botId !== botId ||
      !action.messageId ||
      (flow.cardMessageId && flow.cardMessageId !== action.messageId)
    ) {
      return { toast: { type: "error", content: "这份产品方案已经失效。" } };
    }
    if (flow.status === "expired") {
      return {
        toast: { type: "warning", content: "这份产品方案已经失效。" },
        card: { type: "raw", data: this.ctx.cards.productSpecExpired(flow) },
      };
    }
    if (flow.status === "approved") {
      return {
        toast: { type: "info", content: "产品方案已经确认。" },
        card: { type: "raw", data: this.ctx.cards.productSpecApproved(flow) },
      };
    }
    if (!isProductSpecOwner(flow, action)) {
      return { toast: { type: "warning", content: "只有任务发起人可以确认。" } };
    }
    try {
      if (flow.request.deliveryMode === "local") {
        if (
          await productSpecDocumentRevision(flow.workspaceDir, flow.request) !==
          flow.documentRevision
        ) {
          return { toast: { type: "warning", content: "产品文档已发生变化，请重新提交方案。" } };
        }
      }
    } catch {
      return { toast: { type: "warning", content: "产品文档已发生变化，请重新提交方案。" } };
    }
    const approved = this.flows.approve(flowToken);
    if (!approved) {
      return { toast: { type: "warning", content: "方案状态已经更新。" } };
    }
    return {
      toast: { type: "success", content: "产品方案已确认。" },
      card: {
        type: "raw",
        data: this.ctx.cards.productSpecApproved(approved),
      },
    };
  }
}

export const name = "product-spec";
export const inject = ["applicationTools", "cards"];

export interface Config {
  /** 产品方案 Flow JSON 路径；默认保存在 data 目录，支持按装配环境覆盖。 */
  storePath?: string;
}

export async function apply(ctx: Context, config: Config = {}) {
  const store = new JsonProductSpecFlowStore(
    resolve(process.cwd(), config.storePath ?? "data/product-spec-flows.json"),
  );
  const service = new ProductSpecService(ctx, store);
  // ACP 引擎可能只支持 HTTP/SSE MCP；独立 loopback 入口让本插件可以单独下线。
  const httpServer = await startLoopbackMcpHttpServer({
    register: registerProductSpecTool,
    label: "产品文档",
  });
  const unregister = ctx.applicationTools.register(
    productSpecToolServer(httpServer.url),
  );
  ctx.effect(() => () => httpServer.close(), "product-spec MCP HTTP");
  ctx.on("task/completion-check", (payload) => service.checkCompletion(payload));
  ctx.on("task/tool-calls", (payload) => service.handleToolCalls(payload));
  ctx.on("bot/card-action", (action, _bot, botConfig) =>
    service.handleCardAction(action, botConfig.id),
  );
  return unregister;
}
