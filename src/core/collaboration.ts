/**
 * 同话题协作交接模型：保存一次带轮次的 bot 到 bot 任务投递，并保证只有目标 bot
 * 能领取一次。它位于飞书消息与 CLI 执行之间，进程重启时不恢复内存中的待领取单。
 */

/** QA 质量闸门附加到通用交接单的状态；缺省表示普通 bot 协作。 */
export interface QAReviewContext {
  stage: "review" | "rework";
  developerBotId: string;
  reviewerBotId: string;
  /** 最初触发 reviewBy 的用户任务，返工后复审仍以它作为验收目标。 */
  originalPrompt: string;
  /** Developer 源工作区；返工和阻塞升级不能写入 QA 快照。 */
  sourceWorkspaceDir: string;
  /** 本轮 QA 实际使用的隔离快照目录。 */
  snapshotWorkspaceDir: string;
  /** Developer 交付时生成的工作树指纹；QA 必须原样回填且审查结束时仍保持一致。 */
  revision: string;
}

/** 一次协作投递所需的来源、目标、项目目录和完整任务内容。 */
export interface CollaborationMessage {
  dispatchId: string;
  taskId: string;
  fromBotId: string;
  toBotId: string;
  /** bot 之间的第几次交接，从 1 开始。 */
  round: number;
  /** 本次协作允许发生的最大交接次数。 */
  maxRounds: number;
  workspaceDir: string;
  prompt: string;
  /** 仅 QA Gate 插件使用；通用 collaboration 插件看到它时不做普通轮次回传。 */
  qaReview?: QAReviewContext;
}

/**
 * 以任务、轮次、目标 bot 与交接单标识当前交接，防止重复事件重复执行。
 * dispatchId 纳入键：同一交接单的重复事件仍只处理一次（幂等），而重试生成的新交接单
 * （新 dispatchId、同 taskId/round）不会被旧记录拦截，目标 bot 可再次执行。
 */
export function collaborationTurnKey(message: CollaborationMessage): string {
  return `${message.taskId}:${message.round}:${message.toBotId}:${message.dispatchId}`;
}

/** 进程内待领取交接单；领取成功立即删除，避免同一消息重复执行。 */
export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationMessage>();

  register(message: CollaborationMessage): void {
    this.messages.set(message.dispatchId, message);
  }

  consume(
    dispatchId: string,
    toBotId: string,
  ): CollaborationMessage | undefined {
    const message = this.messages.get(dispatchId);
    if (!message || message.toBotId !== toBotId) return undefined;
    this.messages.delete(dispatchId);
    return message;
  }
}
