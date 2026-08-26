/**
 * bitable-board 核心数据契约测试：状态映射、字段解析、产物链接提取
 * 与反向拉起触发检测的纯函数行为。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_STATES,
  DEFAULT_BOARD_FIELDS,
  buildBoardFields,
  detectReverseTriggers,
  extractArtifactUrls,
  mergeBoardSnapshots,
  parseBoardRecord,
  reverseTaskId,
  stateForEvent,
} from "./bitable-board.js";

const SPEC_TOOL = "request_spec_approval";

function specToolCall() {
  return {
    toolName: SPEC_TOOL,
    input: {
      deliveryMode: "lark-doc",
      title: "登录方案",
      summary: "统一登录",
      documentUrl: "https://example.feishu.cn/docx/Abc123XYZ",
    },
  };
}

test("stateForEvent 按事件映射看板状态", () => {
  assert.equal(stateForEvent({ kind: "started" }), BOARD_STATES.DEV);
  assert.equal(
    stateForEvent({ kind: "started", qaStage: "review" }),
    BOARD_STATES.QA,
  );
  assert.equal(
    stateForEvent({ kind: "started", qaStage: "rework" }),
    BOARD_STATES.DEV,
  );
  assert.equal(
    stateForEvent({ kind: "tool-calls", toolCalls: [{ toolName: "read_file", input: {} }] }),
    BOARD_STATES.DEV,
  );
  assert.equal(
    stateForEvent({ kind: "tool-calls", toolCalls: [specToolCall()] }),
    BOARD_STATES.SPEC,
  );
  assert.equal(stateForEvent({ kind: "result", awaitingQa: false }), BOARD_STATES.DONE);
  assert.equal(stateForEvent({ kind: "result", awaitingQa: true }), BOARD_STATES.QA);
  assert.equal(stateForEvent({ kind: "failed" }), BOARD_STATES.FAILED);
  assert.equal(stateForEvent({ kind: "cancelled" }), BOARD_STATES.FAILED);
  assert.equal(
    stateForEvent({ kind: "spec-approved", continues: false }),
    BOARD_STATES.DONE,
  );
  assert.equal(
    stateForEvent({ kind: "spec-approved", continues: true }),
    BOARD_STATES.DEV,
  );
  assert.equal(
    stateForEvent({ kind: "qa-result", verdict: "pass" }),
    BOARD_STATES.DONE,
  );
  assert.equal(
    stateForEvent({ kind: "qa-result", verdict: "changes_requested" }),
    BOARD_STATES.DEV,
  );
  assert.equal(
    stateForEvent({ kind: "qa-result", verdict: "blocked" }),
    BOARD_STATES.FAILED,
  );
});

test("默认字段名与 issue 9 数据模型一致", () => {
  assert.equal(DEFAULT_BOARD_FIELDS.artifact, "产物链接(文档/PR)");
});

test("buildBoardFields 输出单选字符串与可选数字字段", () => {
  const fields = buildBoardFields(
    {
      taskId: "abc123",
      title: "修复登录",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.DEV,
      round: 2,
      tokens: 1200,
      durationMs: 30000,
      artifact: "https://example.feishu.cn/docx/Abc123",
    },
    DEFAULT_BOARD_FIELDS,
  );
  assert.equal(fields[DEFAULT_BOARD_FIELDS.taskId], "abc123");
  // 单选字段按官方数据结构传字符串值，不是数组。
  assert.equal(fields[DEFAULT_BOARD_FIELDS.state], BOARD_STATES.DEV);
  assert.equal(fields[DEFAULT_BOARD_FIELDS.round], 2);
  assert.equal(fields[DEFAULT_BOARD_FIELDS.tokens], 1200);
  assert.equal(fields[DEFAULT_BOARD_FIELDS.duration], 30000);
});

test("buildBoardFields 省略空的可选字段", () => {
  const fields = buildBoardFields(
    { taskId: "t1", title: "", bot: "", owner: "", state: BOARD_STATES.DONE },
    DEFAULT_BOARD_FIELDS,
  );
  assert.equal(fields[DEFAULT_BOARD_FIELDS.title], undefined);
  assert.equal(fields[DEFAULT_BOARD_FIELDS.bot], undefined);
  assert.equal(fields[DEFAULT_BOARD_FIELDS.tokens], undefined);
});

test("parseBoardRecord 兼容单选数组与链接对象字段", () => {
  const record = parseBoardRecord(
    {
      record_id: "rec001",
      fields: {
        [DEFAULT_BOARD_FIELDS.taskId]: "t1",
        [DEFAULT_BOARD_FIELDS.title]: "任务标题",
        [DEFAULT_BOARD_FIELDS.state]: [BOARD_STATES.TODO],
        [DEFAULT_BOARD_FIELDS.bot]: { text: "developer" },
        [DEFAULT_BOARD_FIELDS.round]: 2,
        [DEFAULT_BOARD_FIELDS.artifact]: { link: "https://example.com/pr/42" },
        [DEFAULT_BOARD_FIELDS.tokens]: 1200,
        [DEFAULT_BOARD_FIELDS.duration]: "30000",
        [DEFAULT_BOARD_FIELDS.chatId]: "",
      },
    },
    DEFAULT_BOARD_FIELDS,
  );
  assert.equal(record.recordId, "rec001");
  assert.equal(record.taskId, "t1");
  assert.equal(record.state, BOARD_STATES.TODO);
  assert.equal(record.bot, "developer");
  assert.equal(record.round, 2);
  assert.equal(record.artifact, "https://example.com/pr/42");
  assert.equal(record.tokens, 1200);
  assert.equal(record.durationMs, 30000);
  assert.equal(record.chatId, "");
});

test("mergeBoardSnapshots 保留稳定字段并按运行累计指标", () => {
  const initial = {
    taskId: "task-1",
    title: "实现登录功能",
    bot: "developer",
    owner: "ou_owner",
    state: BOARD_STATES.QA,
    round: 1,
    artifact: "https://example.com/pr/42",
    tokens: 1200,
    durationMs: 30000,
    chatId: "oc_group",
  };
  const merged = mergeBoardSnapshots(
    initial,
    {
      taskId: "task-1",
      title: "执行 QA 审查",
      bot: "qa",
      owner: "ou_owner",
      state: BOARD_STATES.DONE,
      round: 2,
      artifact: "https://example.com/report/42",
      tokens: 300,
      durationMs: 5000,
    },
    true,
  );
  assert.equal(merged.title, "实现登录功能");
  assert.equal(merged.bot, "qa");
  assert.equal(merged.state, BOARD_STATES.DONE);
  assert.equal(merged.round, 2);
  assert.equal(merged.tokens, 1500);
  assert.equal(merged.durationMs, 35000);
  assert.equal(
    merged.artifact,
    "https://example.com/pr/42\nhttps://example.com/report/42",
  );
  assert.equal(merged.chatId, "oc_group");
});

test("extractArtifactUrls 优先产品文档并去重", () => {
  const urls = extractArtifactUrls([
    specToolCall(),
    {
      toolName: "read_file",
      input: { path: "spec.md", ref: "https://example.com/pr/42" },
    },
  ]);
  assert.equal(urls, [
    "https://example.feishu.cn/docx/Abc123XYZ",
    "https://example.com/pr/42",
  ].join("\n"));
});

test("extractArtifactUrls 无 URL 时返回空串", () => {
  assert.equal(extractArtifactUrls(undefined), "");
  assert.equal(extractArtifactUrls([{ toolName: "read_file", input: {} }]), "");
});

test("reverseTaskId 由 recordId 派生稳定任务 ID", () => {
  assert.equal(reverseTaskId("rec001"), "BR-rec001");
});

test("detectReverseTriggers 触发新待处理记录", () => {
  const records = [
    {
      recordId: "rec-new",
      taskId: "",
      title: "新任务",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "oc_123",
    },
  ];
  const { triggers, nextSeen } = detectReverseTriggers(records, new Map());
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].recordId, "rec-new");
  assert.equal(triggers[0].taskId, undefined);
  assert.equal(nextSeen.get("rec-new")?.triggered, true);
});

test("detectReverseTriggers 不重复触发已拉起的待处理记录", () => {
  const records = [
    {
      recordId: "rec-new",
      taskId: "BR-rec-new",
      title: "新任务",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "oc_123",
    },
  ];
  const seen = new Map([["rec-new", { state: BOARD_STATES.TODO, triggered: true }]]);
  const { triggers } = detectReverseTriggers(records, seen);
  assert.equal(triggers.length, 0);
});

test("detectReverseTriggers 状态从其他值变回待处理时重新触发", () => {
  const records = [
    {
      recordId: "rec-1",
      taskId: "BR-rec-1",
      title: "再次开工",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "oc_123",
    },
  ];
  const seen = new Map([["rec-1", { state: BOARD_STATES.DONE, triggered: true }]]);
  const { triggers } = detectReverseTriggers(records, seen);
  assert.equal(triggers.length, 1);
});

test("detectReverseTriggers 上一轮触发失败回滚后允许重试", () => {
  const records = [
    {
      recordId: "rec-retry",
      taskId: "",
      title: "需要重试",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "oc_123",
    },
  ];
  // triggered=false 且状态仍为待处理：上一轮启动失败回滚，本轮应重新触发。
  const seen = new Map([["rec-retry", { state: BOARD_STATES.TODO, triggered: false }]]);
  const { triggers } = detectReverseTriggers(records, seen);
  assert.equal(triggers.length, 1);
});

test("detectReverseTriggers 非待处理或缺少负责人不触发", () => {
  const records = [
    {
      recordId: "rec-dev",
      taskId: "",
      title: "开发中任务",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.DEV,
      chatId: "",
    },
    {
      recordId: "rec-no-bot",
      taskId: "",
      title: "没填负责人",
      bot: "",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "",
    },
    {
      recordId: "rec-no-title",
      taskId: "",
      title: "",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "",
    },
  ];
  const { triggers } = detectReverseTriggers(records, new Map());
  assert.equal(triggers.length, 0);
});

test("detectReverseTriggers 不重复触发已经确认启动的记录", () => {
  const records = [
    {
      recordId: "rec-old",
      taskId: "BR-rec-old",
      title: "历史待处理",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "oc_123",
    },
  ];
  // task/started 已确认启动后，状态仍短暂为待处理也不能重复派发。
  const seen = new Map([["rec-old", { state: BOARD_STATES.TODO, triggered: true }]]);
  const { triggers } = detectReverseTriggers(records, seen);
  assert.equal(triggers.length, 0);
});
