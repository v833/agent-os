/**
 * 同话题任务交接测试：验证交接单的目标鉴权、一次性领取和协作轮次键，
 * 确保重复飞书事件不会让目标 bot 重复启动 CLI。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CollaborationInbox,
  collaborationTurnKey,
  type CollaborationMessage,
} from "./collaboration.js";

function message(overrides: Partial<CollaborationMessage> = {}): CollaborationMessage {
  return {
    dispatchId: "dispatch-1",
    taskId: "task-1",
    fromBotId: "developer",
    toBotId: "reviewer",
    workspaceDir: "C:\\projects\\agent-os",
    prompt: "检查刚完成的实现",
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

test("协作轮次键由整项任务和目标 bot 组成", () => {
  assert.equal(collaborationTurnKey(message()), "task-1:reviewer");
  assert.equal(
    collaborationTurnKey(message({ toBotId: "other" })),
    "task-1:other",
  );
});
