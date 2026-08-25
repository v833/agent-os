/**
 * 可观测性核心领域模型单元测试：测试 Trace/Span 生命周期、Token 聚合、时延分位数与大盘格式化。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePercentile,
  ObservabilityStore,
} from "./observability.js";

test("calculatePercentile 正确计算各分位数", () => {
  assert.equal(calculatePercentile([], 50), 0);
  assert.equal(calculatePercentile([100], 50), 100);

  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(calculatePercentile(values, 50), 55);
  assert.equal(calculatePercentile(values, 90), 91);
  assert.equal(calculatePercentile(values, 0), 10);
  assert.equal(calculatePercentile(values, 100), 100);
});

test("ObservabilityStore 支持 Trace 与 Span 完整生命周期", () => {
  const store = new ObservabilityStore({ maxTraces: 10 });
  const trace = store.startTrace({
    name: "task/run",
    botId: "developer",
    cliEngine: "claude",
    taskId: "task-001",
    startTime: 1000,
  });

  assert.equal(trace.status, "running");
  assert.equal(trace.spans.length, 1);
  assert.equal(trace.spans[0].name, "task/run");

  // 启动子 Span (CLI 执行)
  const cliSpan = store.startSpan({
    traceId: trace.traceId,
    name: "cli/execute",
    startTime: 1100,
    attributes: { "cli.engine": "claude" },
  });
  assert.ok(cliSpan);
  assert.equal(cliSpan.parentSpanId, trace.spans[0].spanId);

  // 启动孙 Span (Tool 执行)
  const toolSpan = store.startSpan({
    traceId: trace.traceId,
    parentSpanId: cliSpan.spanId,
    name: "tool/read_file",
    startTime: 1200,
  });
  assert.ok(toolSpan);

  // 结束孙 Span
  store.endSpan(toolSpan.spanId, {
    status: "ok",
    endTime: 1300,
  });
  assert.equal(toolSpan.durationMs, 100);
  assert.equal(toolSpan.status, "ok");

  // 结束子 Span
  store.endSpan(cliSpan.spanId, {
    status: "ok",
    endTime: 2000,
  });
  assert.equal(cliSpan.durationMs, 900);

  // 结束 Trace
  const finished = store.finishTrace(trace.traceId, {
    status: "ok",
    endTime: 2500,
    stats: {
      totalTokens: 1500,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
    },
    toolCallsCount: 1,
  });

  assert.ok(finished);
  assert.equal(finished.durationMs, 1500);
  assert.equal(finished.status, "ok");
  assert.equal(finished.spans[0].durationMs, 1500);
  assert.equal(finished.spans[0].status, "ok");
  assert.equal(finished.stats?.totalTokens, 1500);

  const duplicate = store.finishTrace(trace.traceId, {
    status: "error",
    endTime: 3000,
    stats: { totalTokens: 9999 },
  });
  assert.equal(duplicate, undefined);
  assert.equal(trace.status, "ok");
  assert.equal(trace.stats?.totalTokens, 1500);

  const paused = store.startTrace({ name: "task/paused", startTime: 3000 });
  store.finishTrace(paused.traceId, { status: "paused", endTime: 3500 });
  assert.equal(paused.spans[0].status, "unset");
});

test("ObservabilityStore 正确聚合多维度指标与 Token 消耗", () => {
  const store = new ObservabilityStore();

  // 任务 1: developer + claude 成功
  const t1 = store.startTrace({
    name: "task/run",
    botId: "developer",
    cliEngine: "claude",
    startTime: 1000,
  });
  store.finishTrace(t1.traceId, {
    status: "ok",
    endTime: 3000,
    stats: { totalTokens: 1000, inputTokens: 800, outputTokens: 200 },
  });
  store.recordToolInvocation("read_file", false, t1.traceId);
  store.recordToolInvocation("read_file", false, t1.traceId);

  // 任务 2: qa + codex 成功
  const t2 = store.startTrace({
    name: "task/run",
    botId: "qa",
    cliEngine: "codex",
    startTime: 2000,
  });
  store.finishTrace(t2.traceId, {
    status: "ok",
    endTime: 4000,
    stats: { totalTokens: 500, inputTokens: 400, outputTokens: 100 },
  });

  // 任务 3: developer + claude 失败
  const t3 = store.startTrace({
    name: "task/run",
    botId: "developer",
    cliEngine: "claude",
    startTime: 5000,
  });
  store.finishTrace(t3.traceId, {
    status: "error",
    error: "Subprocess timeout",
    endTime: 6000,
    stats: { totalTokens: 300, inputTokens: 300, outputTokens: 0 },
  });
  store.recordToolInvocation("bash", true, t3.traceId);

  // 记录 QA 结论
  store.recordQaResult("pass");
  store.recordQaResult("changes_requested");

  const summary = store.computeSummary();

  assert.equal(summary.totalTasks, 3);
  assert.equal(summary.successTasks, 2);
  assert.equal(summary.failedTasks, 1);
  assert.equal(summary.successRate, 67); // 2 / 3 = 66.6% -> 67%
  assert.equal(summary.tokens.total, 1800);
  assert.equal(summary.tokens.input, 1500);
  assert.equal(summary.tokens.output, 300);

  // Bot 维度
  assert.equal(summary.byBot.developer.totalTasks, 2);
  assert.equal(summary.byBot.developer.successTasks, 1);
  assert.equal(summary.byBot.developer.totalTokens, 1300);
  assert.equal(summary.byBot.qa.totalTasks, 1);
  assert.equal(summary.byBot.qa.totalTokens, 500);

  // Engine 维度
  assert.equal(summary.byEngine.claude.totalTasks, 2);
  assert.equal(summary.byEngine.codex.totalTasks, 1);

  // QA 维度
  assert.equal(summary.qa.total, 2);
  assert.equal(summary.qa.pass, 1);
  assert.equal(summary.qa.changesRequested, 1);

  // Tool 维度
  assert.equal(summary.byTool.read_file.invocations, 2);
  assert.equal(summary.byTool.read_file.failures, 0);
  assert.equal(summary.byTool.bash.invocations, 1);
  assert.equal(summary.byTool.bash.failures, 1);

  // Markdown 格式化检查
  const md = store.formatSummaryMarkdown(summary);
  assert.match(md, /Agent OS 可观测性大盘/);
  assert.match(md, /developer/);
  assert.match(md, /claude/);
  assert.match(md, /read_file/);
});

test("ObservabilityStore 有界环形缓冲区超出后按 FIFO 淘汰", () => {
  const store = new ObservabilityStore({ maxTraces: 10 });
  assert.equal(
    new ObservabilityStore({ maxTraces: Number.POSITIVE_INFINITY }).maxTraces,
    500,
  );

  const traceIds: string[] = [];
  for (let i = 0; i < 15; i++) {
    const t = store.startTrace({ name: `task-${i}` });
    traceIds.push(t.traceId);
  }

  // 总记录数不得超过 10
  assert.equal(store.listTraces(50).length, 10);

  // 前 5 条应已被淘汰
  for (let i = 0; i < 5; i++) {
    assert.equal(store.getTrace(traceIds[i]), undefined);
  }

  // 后 10 条应保留
  for (let i = 5; i < 15; i++) {
    assert.ok(store.getTrace(traceIds[i]));
  }
});

test("ObservabilityStore 按 bot 与 chat 隔离 Trace、工具和 QA 指标", () => {
  const store = new ObservabilityStore();
  const current = store.startTrace({
    name: "task/current",
    botId: "developer",
    chatId: "chat-a",
  });
  store.recordToolInvocation("read_file", false, current.traceId);
  store.finishTrace(current.traceId, { status: "ok", stats: { totalTokens: 100 } });
  store.recordQaResult("pass", { botId: "developer", chatId: "chat-a" });

  const other = store.startTrace({
    name: "task/other",
    botId: "developer",
    chatId: "chat-b",
  });
  store.recordToolInvocation("shell", true, other.traceId);
  store.finishTrace(other.traceId, { status: "error", stats: { totalTokens: 900 } });
  store.recordQaResult("blocked", { botId: "developer", chatId: "chat-b" });

  const filter = { botId: "developer", chatId: "chat-a" };
  const summary = store.computeSummary(filter);
  assert.equal(summary.totalTasks, 1);
  assert.equal(summary.tokens.total, 100);
  assert.equal(summary.byTool.read_file.invocations, 1);
  assert.equal(summary.byTool.shell, undefined);
  assert.equal(summary.qa.pass, 1);
  assert.equal(summary.qa.blocked, 0);
  assert.deepEqual(store.listTraces(10, filter).map((trace) => trace.traceId), [
    current.traceId,
  ]);
});
