/**
 * 同话题协作交接模型：保存一次带轮次的 bot 到 bot 任务投递，并保证只有目标 bot
 * 能领取一次。它位于飞书消息与 CLI 执行之间，进程重启时不恢复内存中的待领取单。
 */

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
}

/** 以任务、轮次和目标 bot 标识当前交接，防止重复事件重复执行。 */
export function collaborationTurnKey(message: CollaborationMessage): string {
  return `${message.taskId}:${message.round}:${message.toBotId}`;
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
