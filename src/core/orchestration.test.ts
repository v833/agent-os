/** 编排纯函数测试：拆解 JSON 解析容错、重复子任务 ID 校验、runId 递增、交接单 taskId 编解码、
 * 重试令牌实例绑定与运行表裁剪。 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RUNS,
  nextRunId,
  parseRetryToken,
  parseSubTaskSpecs,
  parseSubTaskTaskId,
  retryToken,
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

test("拆解结果包含重复子任务 ID 时整轮拒绝", () => {
  assert.throws(
    () =>
      parseSubTaskSpecs(
        '{"tasks":[{"id":"t1","prompt":"A","bot":"developer"},{"id":"t1","prompt":"B","bot":"developer"}]}',
      ),
    /重复子任务 ID：t1/,
  );
});

test("子任务 ID 大小写不同不算重复（各自独立定位）", () => {
  const specs = parseSubTaskSpecs(
    '{"tasks":[{"id":"T1","prompt":"A","bot":"developer"},{"id":"t1","prompt":"B","bot":"developer"}]}',
  );
  assert.equal(specs.length, 2, "大小写不同的 ID 应被当作两个不同子任务");
  assert.deepEqual(
    specs.map((s) => s.id),
    ["T1", "t1"],
  );
});

test("子任务 ID 带空白时按 trim 后查重，重复仍被拒绝", () => {
  assert.throws(
    () =>
      parseSubTaskSpecs(
        '{"tasks":[{"id":"t1","prompt":"A","bot":"developer"},{"id":"  t1  ","prompt":"B","bot":"developer"}]}',
      ),
    /重复子任务 ID：t1/,
  );
  // 唯一的带空白 ID 会在解析阶段规范化后保存，避免交接 taskId 与卡片 ID 不一致。
  const specs = parseSubTaskSpecs(
    '{"tasks":[{"id":"  t1  ","prompt":"A","bot":"developer"}]}',
  );
  assert.equal(specs.length, 1);
  assert.equal(specs[0].id, "t1");
  assert.throws(
    () =>
      parseSubTaskSpecs(
        '{"tasks":[{"id":"   ","prompt":"A","bot":"developer"}]}',
      ),
    /至少包含 1 个字符|too_small/i,
  );
});

test("runId 按最大序号递增并忽略非编排 id", () => {
  assert.equal(nextRunId([]), "run-001");
  assert.equal(nextRunId(["run-001", "run-003"]), "run-004");
  assert.equal(nextRunId(["run-001", "sched-002"]), "run-002");
});

test("子任务 taskId 编解码往返（绑定 run 实例 instanceId）", () => {
  assert.equal(
    subTaskTaskId("5f8a9b3c-1d2e-4a5b-8c9d-0e1f2a3b4c5d", "t1"),
    "5f8a9b3c-1d2e-4a5b-8c9d-0e1f2a3b4c5d#t1",
  );
  assert.deepEqual(
    parseSubTaskTaskId("5f8a9b3c-1d2e-4a5b-8c9d-0e1f2a3b4c5d#t1"),
    {
      instanceId: "5f8a9b3c-1d2e-4a5b-8c9d-0e1f2a3b4c5d",
      subTaskId: "t1",
    },
  );
  // 不合法格式（无 #、只有 #、# 在结尾）必须安全返回 undefined。
  assert.equal(parseSubTaskTaskId("bad"), undefined);
  assert.equal(parseSubTaskTaskId("#t1"), undefined);
  assert.equal(parseSubTaskTaskId("5f8a9b3c-1d2e-4a5b-8c9d-0e1f2a3b4c5d#"), undefined);
});

test("retryToken 绑定 run 实例标识，格式为 instanceId:subTaskId:nonce", () => {
  const instance = "5f8a9b3c-1d2e-4a5b-8c9d-0e1f2a3b4c5d";
  assert.equal(retryToken(instance, "t1", "abc"), `${instance}:t1:abc`);
  // 同一子任务不同 nonce 令牌不同，服务侧据此防重复点击。
  assert.notEqual(
    retryToken(instance, "t1", "a"),
    retryToken(instance, "t1", "b"),
  );
  // 不同子任务（即使 nonce 相同）令牌也不同，避免跨子任务复用。
  assert.notEqual(
    retryToken(instance, "t1", "x"),
    retryToken(instance, "t2", "x"),
  );
  // 不同 run 实例令牌也不同，避免旧 run 令牌误用于新 run。
  assert.notEqual(
    retryToken(instance, "t1", "x"),
    retryToken("9e7b6c5d-4a3b-4c2d-8e1f-0a1b2c3d4e5f", "t1", "x"),
  );
});

test("parseRetryToken 完整解析令牌结构，格式不合法返回 undefined", () => {
  const instance = "5f8a9b3c-1d2e-4a5b-8c9d-0e1f2a3b4c5d";
  assert.deepEqual(parseRetryToken(`${instance}:t1:abc`), {
    instanceId: instance,
    subTaskId: "t1",
    nonce: "abc",
  });
  assert.equal(parseRetryToken(""), undefined);
  assert.equal(parseRetryToken("a:b"), undefined);
  assert.equal(parseRetryToken("a:b:c:d"), undefined);
  assert.equal(parseRetryToken(":t1:abc"), undefined);
  assert.equal(parseRetryToken("a::abc"), undefined);
  const encoded = retryToken(instance, "api:auth", "nonce:1");
  assert.deepEqual(parseRetryToken(encoded), {
    instanceId: instance,
    subTaskId: "api:auth",
    nonce: "nonce:1",
  });
  assert.equal(parseRetryToken("a:%E0%A4:abc"), undefined);
});

/** 构造一个全部子任务处于指定状态的 run，startedAt 按 order 递增保证排序可控。 */
function makeRun(
  runId: string,
  order: number,
  statuses: OrchestrationSubTaskStatus[] = ["done"],
): OrchestrationRun {
  return {
    runId,
    instanceId: `instance-${runId}`,
    prompt: `任务 ${runId}`,
    ownerOpenId: "ou_owner",
    chatId: "chat1",
    botId: "testbot",
    startedAt: `2026-01-01T00:00:${String(order).padStart(2, "0")}Z`,
    subTasks: statuses.map((status) => ({
      id: `t${statuses.indexOf(status) + 1}`,
      prompt: "p",
      targetBotId: "dev",
      status,
      retryCount: 0,
      attempt: 0,
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
