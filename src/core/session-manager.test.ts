import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "./session-manager.js";

function address(overrides: Partial<{
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
}> = {}) {
  return {
    messageId: "om_message",
    chatId: "oc_chat",
    threadId: "omt_thread",
    rootId: "",
    ...overrides,
  };
}

test("同一群聊和话题复用同一个会话", () => {
  let sequence = 0;
  const manager = new SessionManager({ createId: () => `session-${++sequence}` });

  const first = manager.resolve(address());
  const second = manager.resolve(address({ messageId: "om_follow_up" }));

  assert.equal(first.isNew, true);
  assert.equal(second.isNew, false);
  assert.equal(second.session.id, first.session.id);
  assert.equal(first.session.cliId, "codex");
  assert.equal(manager.size, 1);
});

test("话题地址优先使用 threadId，其次 rootId，最后 messageId", () => {
  let sequence = 0;
  const manager = new SessionManager({ createId: () => `session-${++sequence}` });

  assert.equal(manager.resolve(address()).session.threadId, "omt_thread");
  assert.equal(
    manager.resolve(address({ threadId: "", rootId: "om_root" })).session.threadId,
    "om_root",
  );
  assert.equal(
    manager.resolve(address({ threadId: "", rootId: "", messageId: "om_self" })).session.threadId,
    "om_self",
  );
  assert.equal(manager.size, 3);
});

test("相同话题 ID 在不同群中创建不同会话", () => {
  let sequence = 0;
  const manager = new SessionManager({ createId: () => `session-${++sequence}` });

  const first = manager.resolve(address({ chatId: "oc_a" }));
  const second = manager.resolve(address({ chatId: "oc_b" }));

  assert.notEqual(first.session.id, second.session.id);
  assert.equal(manager.size, 2);
});

test("会话只允许合法状态流转并更新时间", () => {
  let now = new Date("2026-07-27T00:00:00.000Z");
  const manager = new SessionManager({
    createId: () => "session-1",
    now: () => now,
  });
  const created = manager.resolve(address()).session;

  now = new Date("2026-07-27T00:01:00.000Z");
  const active = manager.transition(created.id, "active");
  assert.equal(active.status, "active");
  assert.equal(active.updatedAt, "2026-07-27T00:01:00.000Z");

  manager.transition(created.id, "idle");
  manager.transition(created.id, "active");
  manager.transition(created.id, "closed");
  assert.equal(manager.get(created.id)?.status, "closed");
  assert.throws(() => manager.transition(created.id, "active"), /不能切换/);
  assert.throws(() => manager.transition("missing", "active"), /会话不存在/);
});
