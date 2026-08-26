/**
 * dispatch-task 团队派发插件：注册 dispatch_task MCP 工具，校验 Team Leader
 * 权限、团队目标和轮次边界，并通过 ctx.collaboration 完成真实卡片与 @ 投递。
 */
import type { Context } from "cordis";
import { findDispatchTaskRequest } from "../core/collaboration.js";
import { startLoopbackMcpHttpServer } from "../mcp/loopback-http-server.js";
import { registerDispatchTaskTool } from "../mcp/dispatch-task-tools.js";
import { dispatchTaskToolServer } from "./dispatch-task-tool.js";
import type {
  ProductSpecApprovedPayload,
  TaskToolCallsOutcome,
  TaskToolCallsPayload,
} from "./types.js";

/** 校验并认领一轮 dispatch_task 调用；真实投递延迟到成功卡片发布之后。 */
export async function handleDispatchTask(
  ctx: Context,
  payload: TaskToolCallsPayload,
): Promise<TaskToolCallsOutcome | undefined> {
  const request = findDispatchTaskRequest(payload.result.toolCalls);
  if (!request) return undefined;
  if (payload.botConfig.id !== ctx.team.leaderBotId) {
    throw new Error("只有 Team Leader 可以调用 dispatch_task 派发团队任务");
  }
  const target = ctx.team.get(request.targetBotId);
  if (!target) {
    throw new Error(`团队成员未注册或未启用: ${request.targetBotId}`);
  }
  if (request.targetBotId === payload.botConfig.id) {
    throw new Error(`不能把团队任务派发给当前 bot: ${payload.botConfig.id}`);
  }
  if (
    payload.collaboration &&
    payload.collaboration.round >= payload.collaboration.maxRounds
  ) {
    throw new Error(
      `协作任务已达到轮次上限 ${payload.collaboration.maxRounds}，不能继续派发`,
    );
  }

  const round = payload.collaboration ? payload.collaboration.round + 1 : 1;
  const maxRounds =
    payload.collaboration?.maxRounds ?? payload.botConfig.collaborationMaxRounds;
  const reportToBotId =
    payload.collaboration?.reportToBotId ?? payload.botConfig.id;
  return {
    card: ctx.cards.task({
      title: "团队任务",
      status: "success",
      detail: `已派发给 ${target.id}`,
      answer: payload.result.answer || `已派发：${request.objective}`,
    }),
    completion: "completed",
    suppressHandoff: true,
    afterCardPublished: () =>
      ctx.collaboration.sendDispatch({
        senderConfig: payload.botConfig,
        senderBot: payload.bot,
        replyToMessageId: payload.replyToMessageId,
        targetBotId: request.targetBotId,
        taskId:
          payload.collaboration?.taskId ??
          payload.taskId ??
          payload.session.id,
        ownerOpenId:
          payload.collaboration?.ownerOpenId ?? payload.senderOpenId,
        ownerUnionId:
          payload.collaboration?.ownerUnionId ?? payload.senderUnionId,
        reportToBotId,
        objective: request.objective,
        instruction: request.instruction,
        expectedOutput: request.expectedOutput,
        round,
        maxRounds,
        workspaceDir: payload.session.workspaceDir,
      }),
  };
}

/** 把协作来源的已确认产品方案交回原编排者；直接产品任务无需派发。 */
export async function handleApprovedProductSpec(
  ctx: Context,
  payload: ProductSpecApprovedPayload,
): Promise<void> {
  const { flow, bot, botConfig, replyToMessageId } = payload;
  if (!flow.collaboration) return;
  const collaboration = flow.collaboration;
  const productDescription =
    flow.request.deliveryMode === "lark-doc"
      ? `文档 URL：${flow.request.documentUrl}`
      : `Spec：${flow.request.specPath}\nTickets：${flow.request.ticketsPath}`;
  if (collaboration.round >= collaboration.maxRounds) {
    await bot.sendResultNotification({
      replyToMessageId,
      target: { openId: flow.ownerOpenId, name: "" },
      text: `产品方案“${flow.request.title}”已确认，协作已达到 ${collaboration.maxRounds} 轮上限，请查看方案并决定下一步。`,
      replyInThread: true,
    });
    return;
  }
  await ctx.collaboration.sendDispatch({
    senderConfig: botConfig,
    senderBot: bot,
    replyToMessageId,
    targetBotId: collaboration.reportToBotId,
    taskId: collaboration.taskId,
    ownerOpenId: flow.ownerOpenId,
    ownerUnionId: flow.ownerUnionId,
    reportToBotId: collaboration.reportToBotId,
    objective: `产品方案已确认：${flow.request.title}`,
    instruction: [
      `${botConfig.role} 已经完成产品方案，用户确认通过。`,
      `方案标题：${flow.request.title}`,
      `方案摘要：${flow.request.summary}`,
      productDescription,
      "请基于这份已确认方案继续组织后续工作：需要其他成员参与时，使用 dispatch_task 交给团队名单中职责合适的成员。",
    ].join("\n\n"),
    expectedOutput: "继续推进原任务，或在已经完成时向用户给出最终结论。",
    round: collaboration.round + 1,
    maxRounds: collaboration.maxRounds,
    workspaceDir: flow.workspaceDir,
  });
}

export const name = "dispatch-task";
export const inject = [
  "applicationTools",
  "cards",
  "collaboration",
  "team",
];

export async function apply(ctx: Context) {
  // ACP 引擎可能只支持 HTTP/SSE MCP；独立 loopback 入口随插件一起下线。
  const httpServer = await startLoopbackMcpHttpServer({
    register: registerDispatchTaskTool,
    label: "团队派发",
  });
  const unregister = ctx.applicationTools.register(
    dispatchTaskToolServer(httpServer.url),
  );
  ctx.effect(() => () => httpServer.close(), "dispatch-task MCP HTTP");
  ctx.on("task/tool-calls", (payload) => handleDispatchTask(ctx, payload));
  ctx.on("product-spec/approved", async (payload) => {
    try {
      await handleApprovedProductSpec(ctx, payload);
    } catch (error) {
      const message = `产品方案已确认，但团队回传失败：${(error as Error).message}`;
      console.error("[团队派发]", message);
      await payload.bot.reply(
        payload.replyToMessageId,
        message,
        true,
      );
    }
  });
  return unregister;
}
