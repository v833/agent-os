/**
 * cards 服务插件：把纯函数卡片渲染（src/im/card.ts）挂到 ctx.cards，
 * 让任务编排与命令插件统一通过服务出口生成卡片，而不是直接导入渲染实现。
 */
import { Service, type Context } from "cordis";
import type { AuthFlow } from "../core/cli-auth.js";
import type { ProductSpecFlow } from "../core/product-spec.js";
import {
  answerContinuation,
  answerNeedsContinuation,
  buildAuthLoginCard,
  buildAuthCodeCard,
  buildAuthSubmittingCard,
  buildAuthDeviceWaitingCard,
  buildAuthSuccessCard,
  buildClarificationCard,
  buildClarificationContinuingCard,
  buildClarificationSupersededCard,
  buildCollaborationCard,
  buildOrchestrationPanelCard,
  buildProductSpecApprovalCard,
  buildProductSpecApprovedCard,
  buildProductSpecExpiredCard,
  buildResumeCard,
  buildSessionNoticeCard,
  buildTaskCard,
  buildTeamCard,
  splitLongText,
  ThrottledCardUpdater,
  type CardJson,
  type ClarificationCardOptions,
  type ClarificationStateCardOptions,
  type CollaborationCardOptions,
  type OrchestrationPanelOptions,
  type ResumeCardOptions,
  type SessionNoticeCardOptions,
  type TaskCardOptions,
  type TeamCardOptions,
} from "../im/card.js";

/** 卡片渲染与节流更新器的统一出口。 */
export class CardsService extends Service {
  constructor(ctx: Context) {
    super(ctx, "cards");
  }

  task(options: TaskCardOptions): CardJson {
    return buildTaskCard(options);
  }

  resume(options: ResumeCardOptions): CardJson {
    return buildResumeCard(options);
  }

  notice(options: SessionNoticeCardOptions): CardJson {
    return buildSessionNoticeCard(options);
  }

  clarification(options: ClarificationCardOptions): CardJson {
    return buildClarificationCard(options);
  }

  clarificationContinuing(options: ClarificationStateCardOptions): CardJson {
    return buildClarificationContinuingCard(options.flow);
  }

  clarificationSuperseded(options: ClarificationStateCardOptions): CardJson {
    return buildClarificationSupersededCard(options.flow);
  }

  authLogin(flow: AuthFlow, failureMessage?: string): CardJson {
    return buildAuthLoginCard(flow, failureMessage);
  }

  authCode(flow: AuthFlow, url: string): CardJson {
    return buildAuthCodeCard(flow, url);
  }

  authSubmitting(flow: AuthFlow): CardJson {
    return buildAuthSubmittingCard(flow);
  }

  authDeviceWaiting(flow: AuthFlow, url: string, code?: string): CardJson {
    return buildAuthDeviceWaitingCard(flow, url, code);
  }

  authSuccess(flow: AuthFlow): CardJson {
    return buildAuthSuccessCard(flow);
  }

  productSpecApproval(flow: ProductSpecFlow): CardJson {
    return buildProductSpecApprovalCard(flow);
  }

  productSpecApproved(flow: ProductSpecFlow): CardJson {
    return buildProductSpecApprovedCard(flow);
  }

  productSpecExpired(flow: ProductSpecFlow): CardJson {
    return buildProductSpecExpiredCard(flow);
  }

  collaboration(options: CollaborationCardOptions): CardJson {
    return buildCollaborationCard(options);
  }

  team(options: TeamCardOptions): CardJson {
    return buildTeamCard(options);
  }

  orchestrationPanel(options: OrchestrationPanelOptions): CardJson {
    return buildOrchestrationPanelCard(options);
  }

  throttled(updateCard: (card: CardJson) => Promise<void>): ThrottledCardUpdater {
    return new ThrottledCardUpdater(updateCard);
  }

  needsContinuation(answer: string): boolean {
    return answerNeedsContinuation(answer);
  }

  continuation(answer: string): string {
    return answerContinuation(answer);
  }

  splitLongText(text: string, maxLength?: number): string[] {
    return splitLongText(text, maxLength);
  }
}

export const name = "cards";

export function apply(ctx: Context) {
  new CardsService(ctx);
}
