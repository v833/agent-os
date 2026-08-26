/**
 * 飞书多维表格（Bitable）任务看板的数据契约与纯函数：状态枚举、字段名映射、
 * 记录解析、事件→状态映射与反向拉起触发检测。它位于 Agent OS 任务事件与
 * 多维表格记录之间，把模型输出和平台字段都收敛为稳定结构，供 bitable-board
 * 插件复用，不依赖任何 Cordis 服务实现。
 */
import type { QAResult } from "./qa-result.js";
import { findProductSpecRequest } from "./product-spec.js";

/** 看板记录的六种业务状态；按官方数据结构，单选字段写入字符串值。 */
export const BOARD_STATES = {
  /** 记录已创建、等待 Bot 开工（反向拉起的目标状态）。 */
  TODO: "待处理",
  /** 任务提交产品方案、等待真人确认。 */
  SPEC: "方案确认中",
  /** Bot 正在执行开发任务。 */
  DEV: "开发中",
  /** 已进入 QA 审查轮、等待结论。 */
  QA: "QA验收中",
  /** 任务成功完成。 */
  DONE: "已完成",
  /** 任务执行失败。 */
  FAILED: "失败",
} as const;

export type BoardState = (typeof BOARD_STATES)[keyof typeof BOARD_STATES];

/** 反向拉起任务的稳定任务 ID 前缀；后续事件同步靠它关联到看板记录。 */
export const BOARD_TASK_ID_PREFIX = "BR-";

/** 看板表字段名映射；issue 规定的字段名即默认值，可在 cordis.yml 覆盖。 */
export interface BoardFields {
  taskId: string;
  title: string;
  bot: string;
  owner: string;
  state: string;
  round: string;
  artifact: string;
  tokens: string;
  duration: string;
  /** 反向拉起时任务执行所在群聊；记录未填时回退到插件配置。 */
  chatId: string;
}

export const DEFAULT_BOARD_FIELDS: BoardFields = {
  taskId: "任务ID",
  title: "任务标题",
  bot: "负责人(Bot)",
  owner: "发起人",
  state: "当前状态",
  round: "轮次",
  artifact: "产物链接",
  tokens: "消耗Token",
  duration: "耗时",
  chatId: "群聊ID",
};

/** 从 recordId 派生稳定任务 ID；同一记录反复触发始终复用同一条任务线。 */
export function reverseTaskId(recordId: string): string {
  return `${BOARD_TASK_ID_PREFIX}${recordId}`;
}

/**
 * 把 Bitable 字段值归一化为可读字符串。Bitable 单选/多选/人员等字段在读写
 * 时可能返回字符串或数组，这里统一兜底，避免解析逻辑散落各处。
 */
export function boardFieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(boardFieldText).filter(Boolean).join("、");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.link === "string") return record.link;
    if (typeof record.text === "string") return record.text;
    if (typeof record.name === "string") return record.name;
  }
  return "";
}

/** 事件→状态映射的输入；插件把各事件 payload 归一化后调用。 */
export type BoardStateInput =
  | { kind: "started"; qaStage?: "review" | "rework" }
  | { kind: "tool-calls"; toolCalls?: Array<{ toolName: string; input: unknown }> }
  | { kind: "result"; awaitingQa?: boolean }
  | { kind: "failed" }
  | { kind: "spec-approved" }
  | { kind: "qa-result"; verdict: QAResult["verdict"] };

/** 事件→看板状态：方案确认中优先于开发中，QA 轮从开始即标记验收态。 */
export function stateForEvent(input: BoardStateInput): BoardState {
  switch (input.kind) {
    case "started":
      // 只有 Reviewer 审查轮进入验收态；Developer 返工仍属于开发中。
      return input.qaStage === "review" ? BOARD_STATES.QA : BOARD_STATES.DEV;
    case "tool-calls":
      // 提交产品方案说明流程停在“等待真人确认”，后续由 product-spec/approved 恢复开发。
      return findProductSpecRequest(input.toolCalls)
        ? BOARD_STATES.SPEC
        : BOARD_STATES.DEV;
    case "result":
      // 已进入 reviewBy 链路时等待 qa/result 给出终态，不能提前标记完成。
      return input.awaitingQa ? BOARD_STATES.QA : BOARD_STATES.DONE;
    case "failed":
      return BOARD_STATES.FAILED;
    case "spec-approved":
      return BOARD_STATES.DEV;
    case "qa-result":
      return input.verdict === "pass"
        ? BOARD_STATES.DONE
        : input.verdict === "blocked"
          ? BOARD_STATES.FAILED
          : BOARD_STATES.DEV;
  }
}

/** 递归收集对象/数组中的 http(s) URL；产物链接优先取产品文档地址。 */
function collectUrls(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    const matches = value.matchAll(/https?:\/\/[^\s"'<>]+/g);
    for (const match of matches) out.push(match[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, out);
  }
}

/**
 * 从一轮 CLI 工具调用中提取产物链接：优先 request_spec_approval 提交的飞书文档，
 * 其次收集其余工具输入里的 http(s) URL，去重后用换行拼接（文本字段）。
 */
export function extractArtifactUrls(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): string {
  if (!toolCalls?.length) return "";
  const urls: string[] = [];
  const specRequest = findProductSpecRequest(toolCalls);
  if (specRequest?.deliveryMode === "lark-doc") {
    urls.push(specRequest.documentUrl);
  }
  for (const call of toolCalls) {
    collectUrls(call.input, urls);
  }
  return [...new Set(urls)].join("\n");
}

/** 一条解析后的看板记录；所有字段都可能缺失，插件层再决定是否可用。 */
export interface BoardRecord {
  recordId: string;
  /** 记录中的“任务ID”字段；反向拉起的新记录通常为空。 */
  taskId: string;
  title: string;
  bot: string;
  owner: string;
  state: string;
  chatId: string;
}

/** 把 Bitable 返回的原始记录解析为看板记录（按字段名映射取值）。 */
export function parseBoardRecord(
  raw: { record_id?: string; fields?: Record<string, unknown> },
  fields: BoardFields,
): BoardRecord {
  const value = raw.fields ?? {};
  return {
    recordId: raw.record_id ?? "",
    taskId: boardFieldText(value[fields.taskId]).trim(),
    title: boardFieldText(value[fields.title]).trim(),
    bot: boardFieldText(value[fields.bot]).trim(),
    owner: boardFieldText(value[fields.owner]).trim(),
    state: boardFieldText(value[fields.state]).trim(),
    chatId: boardFieldText(value[fields.chatId]).trim(),
  };
}

/** 事件同步要写入记录的完整快照；缺省字段不会覆盖已有值。 */
export interface BoardSnapshot {
  taskId: string;
  title: string;
  bot: string;
  owner: string;
  state: BoardState;
  round?: number;
  artifact?: string;
  tokens?: number;
  durationMs?: number;
  chatId?: string;
}

/** Bitable 字段值支持的类型；单选/多选按官方数据结构分别是 string / string[]。 */
export type BitableFieldValue = string | number | string[];

/** 事件同步快照 → Bitable 字段对象；单选字段按官方数据结构传字符串值。 */
export function buildBoardFields(
  snapshot: BoardSnapshot,
  fields: BoardFields,
): Record<string, BitableFieldValue> {
  const output: Record<string, BitableFieldValue> = {
    [fields.taskId]: snapshot.taskId,
    [fields.state]: snapshot.state,
  };
  if (snapshot.title) output[fields.title] = snapshot.title;
  if (snapshot.bot) output[fields.bot] = snapshot.bot;
  if (snapshot.owner) output[fields.owner] = snapshot.owner;
  if (snapshot.round !== undefined) output[fields.round] = snapshot.round;
  if (snapshot.artifact) output[fields.artifact] = snapshot.artifact;
  if (snapshot.tokens !== undefined) output[fields.tokens] = snapshot.tokens;
  if (snapshot.durationMs !== undefined) {
    output[fields.duration] = snapshot.durationMs;
  }
  if (snapshot.chatId) output[fields.chatId] = snapshot.chatId;
  return output;
}

/** 反向拉起触发检测的输入输出；seen 是插件维护的内存状态快照。 */
export interface SeenBoardRecord {
  /** 上一次轮询看到的“当前状态”字段值。 */
  state: string;
  /** 是否已触发过开工；触发后即使状态仍为待处理也不重复拉起。 */
  triggered: boolean;
}

/** 一条满足开工条件的看板记录。 */
export interface ReverseTrigger {
  recordId: string;
  title: string;
  bot: string;
  owner: string;
  chatId: string;
  /** 记录已写任务ID则复用；否则插件生成 reverseTaskId 并回写。 */
  taskId?: string;
}

/**
 * 检测需要反向拉起的记录：新记录状态为“待处理”触发；已触发过的记录在
 * 状态被改成其他值后变回“待处理”（用户重新开工）或上一轮触发失败回滚
 * （triggered=false）时重新触发。返回触发列表与更新后的 seen 快照。
 */
export function detectReverseTriggers(
  records: BoardRecord[],
  seen: ReadonlyMap<string, SeenBoardRecord>,
): { triggers: ReverseTrigger[]; nextSeen: Map<string, SeenBoardRecord> } {
  const triggers: ReverseTrigger[] = [];
  const nextSeen = new Map(seen);
  for (const record of records) {
    const previous = seen.get(record.recordId);
    const stateIsTodo = record.state === BOARD_STATES.TODO;
    const stateChangedToTodo =
      previous !== undefined &&
      previous.state !== BOARD_STATES.TODO &&
      stateIsTodo;
    const shouldTrigger =
      stateIsTodo &&
      Boolean(record.title && record.bot) &&
      (previous === undefined || !previous.triggered || stateChangedToTodo);
    if (shouldTrigger) {
      triggers.push({
        recordId: record.recordId,
        title: record.title,
        bot: record.bot,
        owner: record.owner,
        chatId: record.chatId,
        ...(record.taskId ? { taskId: record.taskId } : {}),
      });
    }
    nextSeen.set(record.recordId, {
      state: record.state,
      triggered: previous?.triggered === true || shouldTrigger,
    });
  }
  return { triggers, nextSeen };
}
