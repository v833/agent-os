/**
 * 同话题任务交接测试：验证交接单的目标鉴权、一次性领取和协作轮次键，
 * 确保重复飞书事件不会让目标 bot 重复启动 CLI。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CollaborationInbox,
  collaborationTurnKey,
  DispatchTaskRequestSchema,
  findDispatchTaskRequest,
  type CollaborationMessage,
} from "./collaboration.js";

function message(overrides: Partial<CollaborationMessage> = {}): CollaborationMessage {
  return {
    dispatchId: "dispatch-1",
    taskId: "task-1",
    ownerOpenId: "ou_owner",
    fromBotId: "developer",
    toBotId: "reviewer",
    reportToBotId: "developer",
    objective: "检查实现",
    instruction: "检查刚完成的实现",
    expectedOutput: "给出审查结论",
    round: 1,
    maxRounds: 2,
    workspaceDir: "C:\\projects\\agent-os",
    ...overrides,
  };
}

test("交接单只允许目标 bot 领取一次", () => {
  const inbox = new CollaborationInbox();
  inbox.register(message());

  assert.equal(inbox.consume("dispatch-1", "developer"), undefined);
  assert.deepEqual(inbox.consume("dispatch-1", "reviewer"), message());
  assert.equal(inbox.consume("dispatch-1", "reviewer"), undefined);
});

test("协作轮次键由整项任务、轮次、目标 bot 和交接单组成", () => {
  assert.equal(collaborationTurnKey(message()), "task-1:1:reviewer:dispatch-1");
  assert.equal(
    collaborationTurnKey(message({ toBotId: "other" })),
    "task-1:1:other:dispatch-1",
  );
  assert.equal(
    collaborationTurnKey(message({ round: 2, toBotId: "developer" })),
    "task-1:2:developer:dispatch-1",
  );
  // dispatchId 必须纳入键：重试生成新交接单（同 taskId/round）不被旧记录拦截。
  assert.notEqual(
    collaborationTurnKey(message({ dispatchId: "dispatch-1" })),
    collaborationTurnKey(message({ dispatchId: "dispatch-2" })),
  );
  // 同一交接单的重复事件必须映射到同一键（幂等）。
  assert.equal(
    collaborationTurnKey(message()),
    collaborationTurnKey(message()),
  );
});

test("dispatch_task 提取最近一次派发请求并拒绝非法参数", () => {
  const first = {
    targetBotId: "product",
    objective: "形成产品方案",
    instruction: "澄清需求并提交待确认方案。",
    expectedOutput: "一份可确认的产品方案。",
  };
  const latest = {
    targetBotId: "developer",
    objective: "实现已确认方案",
    instruction: "按已确认方案完成实现和验证。",
  };
  assert.equal(DispatchTaskRequestSchema.safeParse(first).success, true);
  assert.deepEqual(
    findDispatchTaskRequest([
      { toolName: "dispatch_task", input: first },
      { toolName: "Bash", input: {} },
      { toolName: "dispatch_task", input: { ...latest, objective: "" } },
      { toolName: "dispatch_task", input: latest },
    ]),
    latest,
  );
  assert.throws(
    () => findDispatchTaskRequest([
      { toolName: "dispatch_task", input: { ...first, targetBotId: "CEO" } },
    ]),
    /dispatch_task 参数非法/,
  );
});
