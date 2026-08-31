/**
 * 交互策略核心：统一描述私聊直达、群聊/话题团队模式及显式 /doc 的能力边界。
 * 路由入口只解析一次，后续任务、命令、澄清、定时和事件插件只消费该策略，
 * 避免各处重新解释 chatType、threadId 或 documentRequested。
 */

/** Agent OS 当前任务的交互模式。 */
export type InteractionMode = "direct" | "team";

/** 一轮任务的能力开关；字段由 createInteractionPolicy 统一推导。 */
export interface InteractionCapabilities {
  /** 是否接受其他 bot 发来的入站消息。 */
  readonly acceptBotMessages: boolean;
  /** 是否允许向其他 bot 派发或继续 bot 间协作。 */
  readonly collaborateWithBots: boolean;
  /** 是否进入产品方案审批/纠正流程；team 普通任务仍由 bot Skill 决定是否参与。 */
  readonly runProductWorkflow: boolean;
  /** 是否允许本轮使用文档交付能力。 */
  readonly deliverDocument: boolean;
  /** 是否阻止 task/result 触发 QA、reviewBy 或自动交接。 */
  readonly suppressHandoff: boolean;
}

/**
 * 任务交互策略。它是可序列化的值对象，适合跨事件、澄清流程和定时任务持久化。
 */
export interface InteractionPolicy {
  readonly mode: InteractionMode;
  /** 只有用户显式输入 /doc 时为 true。 */
  readonly documentRequested: boolean;
  readonly capabilities: InteractionCapabilities;
}

/** 飞书消息边界所需的最小字段。 */
export interface InteractionMessageLike {
  chatType: string;
  threadId?: string;
  rootId?: string;
}

/** 判断消息是否为没有话题上下文的 p2p 私聊。 */
export function isDirectMessage(message: InteractionMessageLike): boolean {
  return (
    message.chatType === "p2p" &&
    !message.threadId &&
    !message.rootId
  );
}

/** 创建策略值对象；所有模式差异集中在这里维护。 */
export function createInteractionPolicy(
  mode: InteractionMode,
  documentRequested = false,
): InteractionPolicy {
  const direct = mode === "direct";
  return Object.freeze({
    mode,
    documentRequested,
    capabilities: Object.freeze({
      acceptBotMessages: !direct,
      collaborateWithBots: !direct,
      // /doc 是普通文档交付，不进入产品方案审批；team 普通任务保持原能力。
      runProductWorkflow: !direct && !documentRequested,
      deliverDocument: !direct || documentRequested,
      // direct 是任务级隔离边界；team /doc 保持既有 team 行为。
      suppressHandoff: direct,
    }),
  });
}

/** 从入站消息解析策略；路由应在解析命令后用 documentRequested 重建一次。 */
export function resolveInteractionPolicy(
  message: InteractionMessageLike,
  options: { documentRequested?: boolean } = {},
): InteractionPolicy {
  return createInteractionPolicy(
    isDirectMessage(message) ? "direct" : "team",
    options.documentRequested ?? false,
  );
}

/** 返回不带文档请求的 team 默认策略，供系统触发的后台任务使用。 */
export function teamInteractionPolicy(
  documentRequested = false,
): InteractionPolicy {
  return createInteractionPolicy("team", documentRequested);
}

/**
 * 把可能缺失的策略归一化为完整值对象；缺省按 team 模式处理。
 * 只信任 mode/documentRequested，能力开关始终重新推导，避免持久化或外部事件带入矛盾组合。
 */
export function interactionPolicyOf(value: {
  interaction?: InteractionPolicy;
}): InteractionPolicy {
  if (value.interaction) {
    return createInteractionPolicy(
      value.interaction.mode,
      value.interaction.documentRequested,
    );
  }
  return teamInteractionPolicy();
}
