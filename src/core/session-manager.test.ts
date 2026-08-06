/**
 * 会话模型测试：验证话题路由、重启恢复、持久化回滚，
 * 以及状态机拒绝非法迁移的行为。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type Session } from "./session-manager.js";
import type { SessionStore } from "./session-store.js";

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

test("同一群聊和话题复用同一个会话", async () => {
  let sequence = 0;
  const manager = new SessionManager({ createId: () => `session-${++sequence}` });

  const first = await manager.resolve(address());
  const second = await manager.resolve(address({ messageId: "om_follow_up" }));

  assert.equal(first.isNew, true);
  assert.equal(second.isNew, false);
  assert.equal(second.session.id, first.session.id);
  assert.equal(first.session.cliId, "codex");
  assert.equal(manager.size, 1);
});

test("新会话使用 resolve 传入的执行引擎", async () => {
  const manager = new SessionManager({ createId: () => "session-claude" });

  const created = (await manager.resolve(address(), "claude")).session;

  assert.equal(created.cliId, "claude");
});

test("已有话题保持创建时的引擎，不接受后续请求覆盖", async () => {
  const manager = new SessionManager({ createId: () => "session-codex" });

  const created = await manager.resolve(address(), "codex");
  const restored = await manager.resolve(address(), "claude");

  assert.equal(created.session.cliId, "codex");
  assert.equal(restored.isNew, false);
  assert.equal(restored.session.cliId, "codex");
});

test("话题地址优先使用 threadId，其次 rootId，最后 messageId", async () => {
  let sequence = 0;
  const manager = new SessionManager({ createId: () => `session-${++sequence}` });

  assert.equal((await manager.resolve(address())).session.threadId, "omt_thread");
  assert.equal(
    (await manager.resolve(address({ threadId: "", rootId: "om_root" })))
      .session.threadId,
    "om_root",
  );
  assert.equal(
    (
      await manager.resolve(
        address({ threadId: "", rootId: "", messageId: "om_self" }),
      )
    ).session.threadId,
    "om_self",
  );
  assert.equal(manager.size, 3);
});

test("相同话题 ID 在不同群中创建不同会话", async () => {
  let sequence = 0;
  const manager = new SessionManager({ createId: () => `session-${++sequence}` });

  const first = await manager.resolve(address({ chatId: "oc_a" }));
  const second = await manager.resolve(address({ chatId: "oc_b" }));

  assert.notEqual(first.session.id, second.session.id);
  assert.equal(manager.size, 2);
});

test("会话只允许合法状态流转并保留 CLI 会话 ID", async () => {
  let now = new Date("2026-07-27T00:00:00.000Z");
  const manager = new SessionManager({
    createId: () => "session-1",
    now: () => now,
  });
  const created = (await manager.resolve(address())).session;

  now = new Date("2026-07-27T00:01:00.000Z");
  const active = await manager.transition(created.id, "active");
  assert.equal(active.status, "active");
  assert.equal(active.updatedAt, "2026-07-27T00:01:00.000Z");

  now = new Date("2026-07-27T00:02:00.000Z");
  const withCliSession = await manager.setCliSessionId(
    created.id,
    "codex-thread",
  );
  assert.equal(withCliSession.cliSessionId, "codex-thread");
  assert.equal(withCliSession.status, "active");
  assert.equal(withCliSession.updatedAt, "2026-07-27T00:02:00.000Z");

  await manager.transition(created.id, "idle");
  await manager.transition(created.id, "active");
  await manager.transition(created.id, "closed");
  assert.equal(manager.get(created.id)?.status, "closed");
  assert.equal(manager.get(created.id)?.cliSessionId, "codex-thread");
  await assert.rejects(manager.transition(created.id, "active"), /不能切换/);
  await assert.rejects(manager.transition("missing", "active"), /会话不存在/);
});

test("CLI 会话 ID 拒绝空值和不存在的 Agent OS 会话", async () => {
  const manager = new SessionManager({ createId: () => "session-1" });
  const created = (await manager.resolve(address())).session;

  await assert.rejects(manager.setCliSessionId(created.id, ""), /不能为空/);
  await assert.rejects(
    manager.setCliSessionId("missing", "codex-thread"),
    /会话不存在/,
  );
  assert.equal(manager.get(created.id)?.cliSessionId, undefined);
});

test("打开管理器时恢复原话题和会话 ID", async () => {
  const restored: Session = {
    id: "session-restored",
    threadId: "omt_thread",
    chatId: "oc_chat",
    cliId: "codex",
    cliSessionId: "codex-thread",
    status: "idle",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:01:00.000Z",
  };
  const store: SessionStore = {
    load: async () => [restored],
    save: async () => {},
  };

  const manager = await SessionManager.open({ store });
  const resolved = await manager.resolve(address());

  assert.equal(manager.size, 1);
  assert.equal(resolved.isNew, false);
  assert.equal(resolved.session.id, "session-restored");
  assert.equal(resolved.session.cliSessionId, "codex-thread");
});

test("保存失败时回滚新建会话、状态变化和 CLI 会话 ID", async () => {
  let failSave = true;
  let sequence = 0;
  const store: SessionStore = {
    load: async () => [],
    save: async () => {
      if (failSave) throw new Error("disk full");
    },
  };
  const manager = await SessionManager.open({
    store,
    createId: () => `session-${++sequence}`,
  });

  await assert.rejects(manager.resolve(address()), /disk full/);
  assert.equal(manager.size, 0);

  failSave = false;
  const created = (await manager.resolve(address())).session;
  failSave = true;

  await assert.rejects(manager.transition(created.id, "active"), /disk full/);
  assert.equal(manager.get(created.id)?.status, "creating");

  await assert.rejects(
    manager.setCliSessionId(created.id, "codex-thread"),
    /disk full/,
  );
  assert.equal(manager.get(created.id)?.cliSessionId, undefined);
});
