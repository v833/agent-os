/**
 * 任务停止模型测试：验证发起人权限、重复停止和运行实例隔离，
 * 确保旧卡片不能误停同一会话后来启动的新任务。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  requestTaskAbort,
  type ActiveRun,
} from "./task-abort.js";

function activeRun(
  ownerOpenId = "ou_owner",
  runId = "run-current",
): ActiveRun {
  return {
    controller: new AbortController(),
    ownerOpenId,
    runId,
  };
}

test("发起人可以停止当前运行且重复点击只返回正在停止", () => {
  const run = activeRun();
  const activeRuns = new Map([["session-1", run]]);

  assert.equal(
    requestTaskAbort(activeRuns, "session-1", "run-current", "ou_owner"),
    "stopped",
  );
  assert.equal(run.cancelMode, "stop");
  assert.equal(run.controller.signal.aborted, true);
  assert.equal(
    requestTaskAbort(activeRuns, "session-1", "run-current", "ou_owner"),
    "already_stopping",
  );
});

test("非发起人不能停止任务", () => {
  const run = activeRun();
  const activeRuns = new Map([["session-1", run]]);

  assert.equal(
    requestTaskAbort(activeRuns, "session-1", "run-current", "ou_other"),
    "forbidden",
  );
  assert.equal(run.controller.signal.aborted, false);
  assert.equal(run.cancelMode, undefined);
});

test("任务不存在或旧卡片运行 ID 不匹配时返回 not_found", () => {
  const run = activeRun();
  const activeRuns = new Map([["session-1", run]]);

  assert.equal(
    requestTaskAbort(activeRuns, "missing", "run-current", "ou_owner"),
    "not_found",
  );
  assert.equal(
    requestTaskAbort(activeRuns, "session-1", "run-old", "ou_owner"),
    "not_found",
  );
  assert.equal(run.controller.signal.aborted, false);
});

test("已经由 close 触发的取消不会被按钮改写为 stop", () => {
  const run = activeRun();
  run.cancelMode = "close";
  run.controller.abort();
  const activeRuns = new Map([["session-1", run]]);

  assert.equal(
    requestTaskAbort(activeRuns, "session-1", "run-current", "ou_owner"),
    "already_stopping",
  );
  assert.equal(run.cancelMode, "close");
});
