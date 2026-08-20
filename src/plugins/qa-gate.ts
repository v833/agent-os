/**
 * QA Gate 插件：把 reviewBy 从普通多轮对话提升为结构化质量闸门。
 * 它监听 task/result，固定并校验 revision，并按 pass / changes_requested / blocked
 * 分别结束、退回 Developer 或升级 Team Leader。移除本插件即可整体下线 QA 闭环。
 */
import type { Context } from "cordis";
import { randomUUID } from "node:crypto";
import { parseQAResult, type QAResult } from "../core/qa-result.js";
import type { QAReviewContext } from "../core/collaboration.js";
import type { WorkspaceSnapshot } from "../core/workspace-snapshot.js";
import type { TaskResultPayload } from "./types.js";

function resultJson(result: QAResult): string {
  return JSON.stringify(result, null, 2);
}

function blockedResult(
  revision: string,
  actual: string,
  recommendation: string,
): QAResult {
  return {
    verdict: "blocked",
    revision: actual,
    tests: [],
    findings: [
      {
        id: "QA-GATE-001",
        severity: "P1",
        location: "QAResult",
        reproduction: "检查 QA 输出协议和审查前后的工作树 revision",
        expected: `合法 QAResult，且 revision 保持为 ${revision}`,
        actual,
        recommendation,
      },
    ],
    nextAction: "escalate",
  };
}

/** QA 质量闸门的事件处理器；状态只由结构化结论和系统计算的 revision 驱动。 */
export class QAGate {
  constructor(private readonly ctx: Context) {}

  async handleTaskResult(payload: TaskResultPayload): Promise<void> {
    const review = payload.collaboration?.qaReview;
    if (!review) {
      if (!payload.collaboration && payload.botConfig.reviewBy) {
        await this.startReview(payload);
      }
      return;
    }

    if (review.stage === "rework") {
      await this.handleDeveloperResult(payload, review);
      return;
    }
    await this.handleReviewerResult(payload, review);
  }

  /** CLI 失败无法生成 QAResult 时，按 blocked 处理并升级负责人。 */
  async handleTaskFailed(payload: TaskResultPayload): Promise<void> {
    const review = payload.collaboration?.qaReview;
    if (!review) return;
    const actualRevision = await this.safeRevision(
      review.snapshotWorkspaceDir,
      review.revision,
    );
    const qaResult = blockedResult(
      review.revision,
      actualRevision,
      "QA 或 Developer 执行失败，未能生成可验证的 QAResult",
    );
    await this.emitQaResult(payload, qaResult);
    await this.releaseSnapshot(payload, review);
    await this.escalate(payload, review, qaResult);
  }

  private async startReview(payload: TaskResultPayload): Promise<void> {
    const reviewerBotId = payload.botConfig.reviewBy!;
    let snapshot;
    try {
      snapshot = await this.ctx.workspaces.snapshot(payload.session.workspaceDir);
    } catch (error) {
      const revision = await this.safeRevision(
        payload.session.workspaceDir,
        "unavailable",
      );
      const review: QAReviewContext = {
        stage: "review",
        developerBotId: payload.botConfig.id,
        reviewerBotId,
        originalPrompt: payload.requestedPrompt,
        sourceWorkspaceDir: payload.session.workspaceDir,
        snapshotWorkspaceDir: payload.session.workspaceDir,
        revision,
      };
      const qaResult = blockedResult(
        revision,
        revision,
        `无法创建 QA 隔离快照：${(error as Error).message}`,
      );
      await this.emitQaResult(payload, qaResult);
      await this.escalate(payload, review, qaResult);
      return;
    }
    try {
      await this.ctx.collaboration.sendDispatch({
        senderConfig: payload.botConfig,
        senderBot: payload.bot,
        replyToMessageId: payload.replyToMessageId,
        targetBotId: reviewerBotId,
        taskId: randomUUID(),
        round: 1,
        maxRounds: payload.botConfig.collaborationMaxRounds,
        workspaceDir: snapshot.workspaceDir,
        qaReview: {
          stage: "review",
          developerBotId: payload.botConfig.id,
          reviewerBotId,
          originalPrompt: payload.requestedPrompt,
          sourceWorkspaceDir: snapshot.sourceWorkspaceDir,
          snapshotWorkspaceDir: snapshot.workspaceDir,
          revision: snapshot.revision,
        },
        prompt: this.reviewPrompt(payload.requestedPrompt, snapshot.revision),
      });
    } catch (error) {
      await this.ctx.workspaces.releaseSnapshot(snapshot.workspaceDir);
      throw error;
    }
  }

  private async handleDeveloperResult(
    payload: TaskResultPayload,
    review: QAReviewContext,
  ): Promise<void> {
    if (payload.botConfig.id !== review.developerBotId) {
      await this.releaseSnapshot(payload, review);
      await this.escalate(
        payload,
        review,
        blockedResult(
          review.revision,
          review.revision,
          "返工任务被非 Developer Bot 完成",
        ),
      );
      return;
    }
    if (payload.collaboration!.round >= payload.collaboration!.maxRounds) {
      await this.releaseSnapshot(payload, review);
      await this.escalate(
        payload,
        review,
        blockedResult(
          review.revision,
          review.revision,
          "QA 协作达到安全轮次上限，需要人工处理",
        ),
      );
      return;
    }

    let snapshot: WorkspaceSnapshot | undefined;
    try {
      snapshot = await this.ctx.workspaces.snapshot(review.sourceWorkspaceDir);
      await this.ctx.collaboration.sendDispatch({
        senderConfig: payload.botConfig,
        senderBot: payload.bot,
        replyToMessageId: payload.replyToMessageId,
        targetBotId: review.reviewerBotId,
        taskId: payload.collaboration!.taskId,
        round: payload.collaboration!.round + 1,
        maxRounds: payload.collaboration!.maxRounds,
        workspaceDir: snapshot.workspaceDir,
        qaReview: {
          ...review,
          stage: "review",
          snapshotWorkspaceDir: snapshot.workspaceDir,
          revision: snapshot.revision,
        },
        prompt: this.reviewPrompt(review.originalPrompt, snapshot.revision),
      });
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (snapshot) {
        try {
          await this.ctx.workspaces.releaseSnapshot(snapshot.workspaceDir);
        } catch (cleanupError) {
          cleanupErrors.push(`新快照清理失败：${(cleanupError as Error).message}`);
        }
      }
      try {
        await this.releaseSnapshot(payload, review);
      } catch (cleanupError) {
        cleanupErrors.push(`旧快照清理失败：${(cleanupError as Error).message}`);
      }

      const actualRevision = snapshot?.revision ?? await this.safeRevision(
        review.sourceWorkspaceDir,
        review.revision,
      );
      const cleanupDetail = cleanupErrors.length > 0
        ? `；${cleanupErrors.join("；")}`
        : "";
      const qaResult = blockedResult(
        review.revision,
        actualRevision,
        `无法创建 QA 复审快照或派发审查任务：${(error as Error).message}${cleanupDetail}`,
      );
      await this.emitQaResult(payload, qaResult);
      await this.escalate(payload, review, qaResult);
      return;
    }
    await this.releaseSnapshot(payload, review);
  }

  private async handleReviewerResult(
    payload: TaskResultPayload,
    review: QAReviewContext,
  ): Promise<void> {
    if (payload.botConfig.id !== review.reviewerBotId) {
      await this.releaseSnapshot(payload, review);
      await this.escalate(
        payload,
        review,
        blockedResult(
          review.revision,
          review.revision,
          "审查任务被非 QA Reviewer Bot 完成",
        ),
      );
      return;
    }
    const actualRevision = await this.ctx.workspaces.revision(
      review.snapshotWorkspaceDir,
    );
    let qaResult: QAResult;
    let gateGeneratedBlock = false;
    try {
      qaResult = parseQAResult(payload.answer);
    } catch (error) {
      gateGeneratedBlock = true;
      qaResult = blockedResult(
        review.revision,
        actualRevision,
        `QAResult 协议无效：${(error as Error).message}`,
      );
    }
    if (
      qaResult.revision !== review.revision ||
      actualRevision !== review.revision
    ) {
      gateGeneratedBlock = true;
      qaResult = blockedResult(
        review.revision,
        actualRevision,
        `QA 报告 revision=${qaResult.revision}，快照 revision=${actualRevision}，与固定审查版本不一致`,
      );
    }

    await this.emitQaResult(payload, qaResult);
    if (qaResult.verdict === "pass") {
      const developer = this.ctx.lark.bot(review.developerBotId);
      await this.releaseSnapshot(payload, review);
      if (developer) {
        await payload.bot.sendResultNotification({
          replyToMessageId: payload.replyToMessageId,
          target: developer.identity,
          text: `QA 审查通过（revision: ${qaResult.revision}），交付链路已结束。`,
          replyInThread: payload.hasThread,
        });
      }
      return;
    }
    if (qaResult.verdict === "blocked" || gateGeneratedBlock) {
      await this.releaseSnapshot(payload, review);
      await this.escalate(payload, review, qaResult);
      return;
    }
    if (payload.collaboration!.round >= payload.collaboration!.maxRounds) {
      await this.releaseSnapshot(payload, review);
      await this.escalate(
        payload,
        review,
        blockedResult(
          review.revision,
          actualRevision,
          "QA 协作达到安全轮次上限，需要人工处理",
        ),
      );
      return;
    }

    try {
      await this.ctx.collaboration.sendDispatch({
        senderConfig: payload.botConfig,
        senderBot: payload.bot,
        replyToMessageId: payload.replyToMessageId,
        targetBotId: review.developerBotId,
        taskId: payload.collaboration!.taskId,
        round: payload.collaboration!.round + 1,
        maxRounds: payload.collaboration!.maxRounds,
        workspaceDir: review.sourceWorkspaceDir,
        qaReview: { ...review, stage: "rework" },
        prompt: [
          "QA 审查未通过，请只处理以下结构化缺陷并运行相关验证。",
          resultJson(qaResult),
        ].join("\n\n"),
      });
    } finally {
      await this.releaseSnapshot(payload, review);
    }
  }

  private async escalate(
    payload: TaskResultPayload,
    review: QAReviewContext,
    qaResult: QAResult,
  ): Promise<void> {
    const leaderId = this.ctx.config.teamLeaderId;
    if (leaderId === payload.botConfig.id) {
      await payload.bot.reply(
        payload.replyToMessageId,
        `QA 审查阻塞，需要负责人处理：\n${resultJson(qaResult)}`,
        payload.hasThread,
      );
      return;
    }
    await this.ctx.collaboration.sendDispatch({
      senderConfig: payload.botConfig,
      senderBot: payload.bot,
      replyToMessageId: payload.replyToMessageId,
      targetBotId: leaderId,
      taskId: payload.collaboration?.taskId ?? randomUUID(),
      round: 1,
      maxRounds: 1,
      workspaceDir: review.sourceWorkspaceDir,
      prompt: [
        "QA 审查已阻塞，请负责人处理环境、权限或协议问题。",
        resultJson(qaResult),
      ].join("\n\n"),
    });
  }

  private async releaseSnapshot(
    payload: TaskResultPayload,
    review: QAReviewContext,
  ): Promise<void> {
    try {
      if (
        payload.botConfig.id === review.reviewerBotId &&
        payload.session.workspaceDir === review.snapshotWorkspaceDir
      ) {
        const defaultWorkspace = this.ctx.config.bot(
          review.reviewerBotId,
        )?.workspaceDir;
        if (defaultWorkspace) {
          await this.ctx.sessions.manager.setWorkspaceDir(
            payload.session.id,
            defaultWorkspace,
          );
        }
      }
    } finally {
      await this.ctx.workspaces.releaseSnapshot(review.snapshotWorkspaceDir);
    }
  }

  private async emitQaResult(
    payload: TaskResultPayload,
    qaResult: QAResult,
  ): Promise<void> {
    try {
      await this.ctx.parallel("qa/result", { ...payload, qaResult });
    } catch (error) {
      // 观察者失败不能改变闸门结论或阻止快照清理；记录后继续路由。
      console.error("[QA Gate] qa/result 观察者失败：", (error as Error).message);
    }
  }

  private async safeRevision(
    workspaceDir: string,
    fallback: string,
  ): Promise<string> {
    try {
      return await this.ctx.workspaces.revision(workspaceDir);
    } catch {
      return fallback;
    }
  }

  private reviewPrompt(originalPrompt: string, revision: string): string {
    return [
      "请独立审查当前工作目录。审查期间不得修改工作树；如需建议测试改动，请放入 findings。",
      `固定审查 revision：${revision}`,
      `原始任务：${originalPrompt}`,
      "完成后只输出一个 QAResult JSON 对象，revision 必须原样填写上述值。",
      '{"verdict":"pass | changes_requested | blocked","revision":"固定 revision","tests":[{"command":"实际命令","status":"passed | failed | skipped","exitCode":0}],"findings":[{"id":"QA-001","severity":"P0 | P1 | P2 | P3","location":"文件与行号","reproduction":"复现步骤","expected":"预期","actual":"实际","recommendation":"建议"}],"nextAction":"close | return_to_developer | escalate"}',
    ].join("\n\n");
  }
}

export const name = "qa-gate";
export const inject = [
  "config",
  "lark",
  "collaboration",
  "sessions",
  "workspaces",
];

export function apply(ctx: Context) {
  const gate = new QAGate(ctx);
  ctx.on("task/result", async (payload) => {
    try {
      await gate.handleTaskResult(payload);
    } catch (error) {
      const message = `QA Gate 处理失败：${(error as Error).message}`;
      console.error("[QA Gate]", message);
      await payload.bot.reply(
        payload.replyToMessageId,
        message,
        payload.hasThread,
      );
    }
  });
  ctx.on("task/failed", async (payload) => {
    try {
      await gate.handleTaskFailed(payload);
    } catch (error) {
      console.error("[QA Gate] 失败任务收口失败：", (error as Error).message);
    }
  });
}
