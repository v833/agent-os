/**
 * orchestration/live-panel 实时面板插件：/orchestrate 派发后自动挂起一张实时汇总
 * 面板卡片，监听 orchestration/update 事件用节流更新器（ThrottledCardUpdater）持续
 * 刷新，全部子任务终态后定格。渲染经 ctx.cards 服务出口（orchestrationPanel）完成，
 * 不直接 import 卡片实现；本插件是可选的——在 cordis.yml 移除本条目即回退为
 * “仅汇总文本”（orchestration/update 无消费者，事件空转无害）。
 * 位置说明：作为 orchestration 服务的可选子插件，遵循 commands/*、engines/* 的
 * “服务文件 + 子插件目录”装配风格（orchestration.ts 服务 + orchestration/live-panel.ts 子插件）。
 */
import { Service, type Context } from "cordis";
import { isRunTerminal } from "../../core/orchestration.js";
import type { ThrottledCardUpdater } from "../../im/card.js";
import type {
  OrchestrationEvictedPayload,
  OrchestrationUpdatePayload,
} from "../types.js";

/** live-panel 服务：按 runId 维护一张实时面板卡片及其节流更新器。 */
export class LivePanelService extends Service {
  /**
   * runId → 该 run 的挂起卡片信息（messageId + 节流更新器）；run 全终态后仍保留（已
   * closed）直到被淘汰，这样迟到的重复事件不会重新挂起一张重复卡片，淘汰广播时再清理引用。
   */
  private readonly updaters = new Map<
    string,
    { messageId: string; updater: ThrottledCardUpdater }
  >();

  constructor(ctx: Context) {
    super(ctx, "live-panel");
  }

  /** 记录面板外部调用失败：只记 runId/卡片 messageId/错误摘要，不向事件调用方抛出。 */
  private logPanelError(step: string, runId: string, messageId: string | undefined, error: unknown): void {
    console.error(
      `[live-panel] ${step}失败 run=${runId}${messageId ? ` messageId=${messageId}` : ""}：${(error as Error).message}`,
    );
  }

  /** 处理 orchestration/update：首次收到挂起卡片，后续用节流推送最新快照，终态 finish。
   * 实时面板是可选观察能力：任何飞书卡片 API 失败都只记录，不向 orchestration/update
   * 调用方（编排服务）抛出，避免卡片失败污染任务状态或阻断汇总文本。 */
  async handleUpdate(payload: OrchestrationUpdatePayload): Promise<void> {
    const { run, anchor } = payload;
    const card = this.ctx.cards.orchestrationPanel({
      runs: [run],
      // 重试按钮是否渲染由 orchestration/actions 插件决定（retryMax=0 即不渲染）。
      maxRetry: this.ctx.orchestration.retryMax(),
    });
    const existing = this.updaters.get(run.runId);
    if (existing) {
      if (isRunTerminal(run)) {
        // 已有挂起卡片且 run 已终态：finish 定格（立即提交最终卡片）；失败只记录。
        try {
          await existing.updater.finish(card);
        } catch (error) {
          this.logPanelError("终态卡片更新", run.runId, existing.messageId, error);
        }
      } else {
        // 非终态：节流刷新（push 内部吞掉中间更新失败，不会抛出）。
        existing.updater.push(card);
      }
      return;
    }
    // 首次收到该 run：必须有锚点才能挂起卡片；后续状态变化事件不带锚点。
    if (!anchor) return;
    let messageId: string | undefined;
    try {
      messageId = await anchor.bot.replyCard(
        anchor.replyToMessageId,
        card,
        anchor.hasThread,
      );
    } catch (error) {
      // 首次挂卡失败：放弃对该 run 的实时更新，仅记录；/orchestrate 仍走普通汇总文本。
      this.logPanelError("首次挂卡片", run.runId, undefined, error);
      return;
    }
    if (!messageId?.trim()) return; // 挂卡片失败：放弃对该 run 的实时更新，避免静默留残。
    const updater = this.ctx.cards.throttled((next) =>
      anchor.bot.updateCard(messageId, next),
    );
    this.updaters.set(run.runId, { messageId, updater });
    // 创建后即全终态（如全部派发失败）：挂起的卡片已是最终状态，直接 finish 定格；失败只记录。
    if (isRunTerminal(run)) {
      try {
        await updater.finish(card);
      } catch (error) {
        this.logPanelError("首挂后终态定格", run.runId, messageId, error);
      }
    }
  }

  /** 处理 orchestration/evicted：run 被淘汰时取消并清理对应挂起卡片/节流引用；
   * 取消与清理都必须保证异常不外传（淘汰是后台清理，不能影响编排主链路）。 */
  async handleEvicted(payload: OrchestrationEvictedPayload): Promise<void> {
    const entry = this.updaters.get(payload.runId);
    if (!entry) return;
    try {
      await entry.updater.cancel();
    } catch (error) {
      this.logPanelError("淘汰取消卡片", payload.runId, entry.messageId, error);
    } finally {
      this.updaters.delete(payload.runId);
    }
  }
}

export const name = "orchestration/live-panel";
// 注入 orchestration 以读取 retryMax：重试按钮由 orchestration/actions 插件决定渲染。
export const inject = ["cards", "orchestration"];

export function apply(ctx: Context) {
  const service = new LivePanelService(ctx);
  // 订阅编排状态事件而非直接调用服务：live-panel 与编排解耦，均可独立上线/下线。
  ctx.on("orchestration/update", (payload) => service.handleUpdate(payload));
  ctx.on("orchestration/evicted", (payload) => service.handleEvicted(payload));
}
