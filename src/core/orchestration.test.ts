/** 编排纯函数测试：拆解 JSON 解析容错、runId 递增、交接单 taskId 编解码与运行表裁剪。 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RUNS,
  nextRunId,
  parseSubTaskSpecs,
  parseSubTaskTaskId,
  subTaskTaskId,
  trimRuns,
  type OrchestrationRun,
  type OrchestrationSubTaskStatus,
} from "./orchestration.js";

test("从 CLI 回答中提取子任务规格（容忍 markdown 代码块包裹）", () => {
  const answer = [
    "好的，拆解结果如下：",
    "```json",
    '{"tasks":[{"id":"t1","prompt":"分析模块 A","bot":"developer"},{"id":"t2","prompt":"审查模块 B","bot":"product"}]}',
    "```",
  ].join("\n");
  assert.deepEqual(parseSubTaskSpecs(answer), [
    { id: "t1", prompt: "分析模块 A", bot: "developer" },
    { id: "t2", prompt: "审查模块 B", bot: "product" },
  ]);
});

test("拆解结果缺少 JSON 或字段不合法时抛错", () => {
  assert.throws(() => parseSubTaskSpecs("无法拆解这个任务"), /找不到 JSON/);
  assert.throws(() => parseSubTaskSpecs('{"tasks":[]}'));
  assert.throws(() =>
    parseSubTaskSpecs('{"tasks":[{"id":"t1","bot":"developer"}]}'),
  );
});

test("runId 按最大序号递增并忽略非编排 id", () => {
  assert.equal(nextRunId([]), "run-001");
  assert.equal(nextRunId(["run-001", "run-003"]), "run-004");
  assert.equal(nextRunId(["run-001", "sched-002"]), "run-002");
});

test("子任务 taskId 编解码往返", () => {
  assert.equal(subTaskTaskId("run-001", "t1"), "run-001#t1");
  assert.deepEqual(parseSubTaskTaskId("run-001#t1"), {
    runId: "run-001",
    subTaskId: "t1",
  });
  // 不合法格式（无 #、只有 #、# 在结尾）必须安全返回 undefined。
  assert.equal(parseSubTaskTaskId("bad"), undefined);
  assert.equal(parseSubTaskTaskId("#t1"), undefined);
  assert.equal(parseSubTaskTaskId("run-001#"), undefined);
});

/** 构造一个全部子任务处于指定状态的 run，startedAt 按 order 递增保证排序可控。 */
function makeRun(
  runId: string,
  order: number,
  statuses: OrchestrationSubTaskStatus[] = ["done"],
): OrchestrationRun {
  return {
    runId,
    prompt: `任务 ${runId}`,
    startedAt: `2026-01-01T00:00:${String(order).padStart(2, "0")}Z`,
    subTasks: statuses.map((status) => ({
      id: `t${statuses.indexOf(status) + 1}`,
      prompt: "p",
      targetBotId: "dev",
      status,
    })),
  };
}

test("超过 MAX_RUNS 条已完成的 run 时淘汰最旧、保留最新", () => {
  const runs = Array.from({ length: MAX_RUNS + 5 }, (_, index) =>
    makeRun(`run-${String(index + 1).padStart(3, "0")}`, index + 1),
  );
  const trimmed = trimRuns(runs);
  assert.equal(trimmed.length, MAX_RUNS, "裁剪后恰好保留 MAX_RUNS 条");
  assert.ok(!trimmed.some((run) => run.runId === "run-001"), "最旧的 run 被淘汰");
  assert.ok(
    trimmed.some((run) => run.runId === `run-${String(MAX_RUNS + 5).padStart(3, "0")}`),
    "最新的 run 被保留",
  );
});

test("仍有 pending 子任务的 run 不参与淘汰，始终保留", () => {
  // MAX_RUNS + 1 条已完成 + 1 条 pending：只淘汰最旧的一条已完成 run，
  // pending run 不计入淘汰名额，必须保留。
  const runs = [
    ...Array.from({ length: MAX_RUNS + 1 }, (_, index) =>
      makeRun(`run-${String(index + 1).padStart(3, "0")}`, index + 1),
    ),
    makeRun("run-pending", MAX_RUNS + 2, ["pending"]),
  ];
  const trimmed = trimRuns(runs);
  assert.equal(trimmed.length, MAX_RUNS + 1, "pending run 不计入淘汰名额");
  assert.ok(
    trimmed.some((run) => run.runId === "run-pending"),
    "未完成的 run 必须保留",
  );
  assert.ok(!trimmed.some((run) => run.runId === "run-001"), "最旧的已完成 run 被淘汰");
});

test("刚好 MAX_RUNS 条已完成的 run 时不做任何裁剪", () => {
  const runs = Array.from({ length: MAX_RUNS }, (_, index) =>
    makeRun(`run-${String(index + 1).padStart(3, "0")}`, index + 1),
  );
  assert.deepEqual(trimRuns(runs), runs);
});
