/**
 * 任务进度聚合器测试：验证并发工具按 ID 配对、耗时与失败记录、
 * 上下文用量、快照隔离和最近活动数量上限。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TaskProgressTracker } from "./task-progress.js";

test("初始快照显示正在理解任务并包含窗口大小和新会话标记", () => {
  const tracker = new TaskProgressTracker(() => 1_000, 200_000, true);

  assert.deepEqual(tracker.snapshot(), {
    current: "正在理解任务",
    elapsedMs: 0,
    toolCount: 0,
    completedCount: 0,
    activities: [],
    contextWindowTokens: 200_000,
    startedNewSession: true,
  });
});

test("按 ID 配对并发工具并记录上下文、耗时和失败状态", () => {
  let now = 1_000;
  const tracker = new TaskProgressTracker(() => now);

  tracker.accept({ type: "context", usedTokens: 1_024 });
  tracker.accept({ type: "context", usedTokens: 2_048 });
  now = 1_010;
  tracker.accept({
    type: "tool_start",
    toolUseId: "tool-a",
    toolName: "Read",
    label: "读取文件",
    detail: "src/index.ts",
  });
  now = 1_020;
  tracker.accept({
    type: "tool_start",
    toolUseId: "tool-b",
    toolName: "Bash",
    label: "运行命令",
  });
  now = 1_040;
  const firstDone = tracker.accept({
    type: "tool_end",
    toolUseId: "tool-a",
    failed: false,
  });

  assert.equal(firstDone.current, "运行命令");
  assert.equal(firstDone.completedCount, 1);
  assert.equal(firstDone.toolCount, 2);
  assert.equal(firstDone.contextStartTokens, 1_024);
  assert.equal(firstDone.contextUsedTokens, 2_048);
  assert.deepEqual(firstDone.activities[0], {
    toolName: "Read",
    label: "读取文件",
    detail: "src/index.ts",
    durationMs: 30,
    failed: false,
  });

  now = 1_055;
  const allDone = tracker.accept({
    type: "tool_end",
    toolUseId: "tool-b",
    failed: true,
  });
  assert.equal(allDone.current, "正在分析执行结果");
  assert.equal(allDone.completedCount, 2);
  assert.deepEqual(allDone.activities[0], {
    toolName: "Bash",
    label: "运行命令",
    durationMs: 35,
    failed: true,
  });
});

test("忽略找不到开始事件的结束事件", () => {
  const tracker = new TaskProgressTracker(() => 1_000);

  const snapshot = tracker.accept({
    type: "tool_end",
    toolUseId: "missing",
    failed: false,
  });

  assert.equal(snapshot.toolCount, 0);
  assert.equal(snapshot.completedCount, 0);
  assert.deepEqual(snapshot.activities, []);
});

test("只保留最近十二条活动且快照数组不能修改内部记录", () => {
  let now = 0;
  const tracker = new TaskProgressTracker(() => now);
  for (let index = 0; index < 13; index += 1) {
    tracker.accept({
      type: "tool_start",
      toolUseId: `tool-${index}`,
      toolName: "Read",
      label: `读取 ${index}`,
    });
    now += 1;
    tracker.accept({
      type: "tool_end",
      toolUseId: `tool-${index}`,
      failed: false,
    });
  }

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.activities.length, 12);
  assert.equal(snapshot.activities[0].label, "读取 12");
  assert.equal(snapshot.activities.at(-1)?.label, "读取 1");

  snapshot.activities.length = 0;
  assert.equal(tracker.snapshot().activities.length, 12);
});
