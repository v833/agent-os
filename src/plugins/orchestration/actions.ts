/**
 * orchestration/actions 面板动作插件：认领面板卡片上的「重试」按钮回调
 * （action=retry_subtask），调用 orchestration 服务的 retrySubTask 重新派发失败
 * 子任务，并把结果映射为飞书 toast 返回给平台；其他 action 一律返回 undefined，
 * 交给 router 的现有处理（serial 分发，第一个非 undefined 即短路）。
 * 本插件是可选的：启动时置位 ctx.orchestration.enableRetry() 使面板渲染重试按钮；
 * 在 cordis.yml 移除本条目即整体下线一键重试——面板不再渲染按钮，保留手动
 * 「继续执行」降级路径，orchestration 服务本身不受影响。
 * 位置说明：作为 orchestration 服务的可选子插件，遵循 commands/*、engines/* 的
 * “服务文件 + 子插件目录”装配风格（orchestration.ts 服务 + orchestration/actions.ts 子插件）。
 */
import type { Context } from "cordis";
import type { CardAction, CardActionResponse } from "../../im/lark.js";
import type { RetrySubTaskResult } from "../orchestration.js";

/** 把 retrySubTask 的结果映射为飞书 toast：成功提示已重新派发，否则说明拒绝原因。 */
function toastFor(result: RetrySubTaskResult): CardActionResponse {
  if (result.ok) {
    return { toast: { type: "success", content: "已重新派发，正在等待成员执行。" } };
  }
  switch (result.reason) {
    case "forbidden":
      return {
        toast: { type: "warning", content: "只有编排发起人可以重试子任务。" },
      };
    case "limit":
      return {
        toast: { type: "warning", content: "该子任务已达到重试次数上限。" },
      };
    case "duplicate":
      return {
        toast: { type: "info", content: "已处理过这次重试，请勿重复点击。" },
      };
    case "not_found":
      return {
        toast: { type: "info", content: "这条重试请求已经失效，请刷新面板。" },
      };
    case "not_failed":
      return {
        toast: { type: "info", content: "该子任务当前不需要重试。" },
      };
    case "dispatch_failed":
      return {
        toast: {
          type: "error",
          content: `重新派发失败：${result.message ?? "未知错误"}`,
        },
      };
    default:
      return {
        toast: { type: "error", content: "重试请求校验失败，请刷新面板后重试。" },
      };
  }
}

export const name = "orchestration/actions";
export const inject = ["orchestration"];

export function apply(ctx: Context) {
  // 置位重试能力：live-panel 与 /panel 据此渲染重试按钮；本插件下线时不置位即无按钮。
  ctx.orchestration.enableRetry();
  ctx.on("bot/card-action", async (action: CardAction) => {
    if (action.value.action !== "retry_subtask") return undefined;
    // 校验 value 字段齐全：缺字段的旧卡片直接拒绝，避免脏数据进入服务校验。
    const runId =
      typeof action.value.runId === "string" ? action.value.runId : "";
    const subTaskId =
      typeof action.value.subTaskId === "string" ? action.value.subTaskId : "";
    const token =
      typeof action.value.retryToken === "string" ? action.value.retryToken : "";
    if (!runId || !subTaskId || !token) {
      return {
        toast: { type: "error", content: "这条重试请求不完整，请刷新面板后重试。" },
      };
    }
    const result = await ctx.orchestration.retrySubTask(
      runId,
      subTaskId,
      action.operatorOpenId,
      token,
    );
    return toastFor(result);
  });
}
