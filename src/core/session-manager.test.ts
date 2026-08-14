/**
 * 会话模型测试：验证话题路由、重启恢复、持久化回滚，
 * 以及状态机拒绝非法迁移的行为。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isRetryRequest,
  resolveRetryPrompt,
  SessionManager,
  type Session,
} from "./session-manager.js";
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
  assert.equal(first.session.cliId, "claude");
  assert.equal(first.session.botId, "default");
  assert.equal(manager.size, 1);
});

test("同一群聊和话题被不同 bot 处理时各自拥有独立会话", async () => {
  let sequence = 0;
  const manager = new SessionManager({ createId: () => `session-${++sequence}` });

  const developer = await manager.resolve(address(), "claude", "developer");
  const reviewer = await manager.resolve(address(), "codex", "reviewer");
  const developerFollowUp = await manager.resolve(
    address({ messageId: "om_follow_up" }),
    "codex",
    "developer",
  );

  assert.notEqual(developer.session.id, reviewer.session.id);
  assert.equal(developer.session.botId, "developer");
  assert.equal(reviewer.session.botId, "reviewer");
  assert.equal(developerFollowUp.isNew, false);
  assert.equal(developerFollowUp.session.id, developer.session.id);
  assert.equal(manager.size, 2);
});

test("新会话使用 resolve 传入的执行引擎", async () => {
  const manager = new SessionManager({ createId: () => "session-claude" });

  const created = (await manager.resolve(address(), "claude")).session;

  assert.equal(created.cliId, "claude");
});

test("新会话持久化接入模式，已有话题不受新默认值覆盖", async () => {
  const manager = new SessionManager({ createId: () => "session-dimagent" });
  const created = await manager.resolve(
    address(),
    "dimagent",
    "developer",
    process.cwd(),
    "acp",
  );
  const existing = await manager.resolve(
    address(),
    "dimagent",
    "developer",
    process.cwd(),
    "headless",
  );

  assert.equal(created.session.accessMode, "acp");
  assert.equal(existing.session.accessMode, "acp");
});

test("新会话保存工作目录，切换后清除旧 CLI 会话", async () => {
  const manager = new SessionManager({ createId: () => "session-workspace" });
  const created = (
    await manager.resolve(address(), "codex", "developer", "C:\\projects\\one")
  ).session;
  await manager.setCliSessionId(created.id, "codex-thread");

  const switched = await manager.setWorkspaceDir(
    created.id,
    "C:\\projects\\two",
  );

  assert.equal(switched.workspaceDir, "C:\\projects\\two");
  assert.equal(switched.cliSessionId, undefined);
  assert.equal(switched.status, "creating");
  assert.equal(manager.get(created.id)?.workspaceDir, "C:\\projects\\two");
});

test("已有话题保持创建时的引擎，不接受后续请求覆盖", async () => {
  const manager = new SessionManager({ createId: () => "session-codex" });

  const created = await manager.resolve(
    address(),
    "codex",
    "developer",
    "C:\\projects\\original",
  );
  const restored = await manager.resolve(
    address(),
    "claude",
    "developer",
    "C:\\projects\\new-default",
  );

  assert.equal(created.session.cliId, "codex");
  assert.equal(restored.isNew, false);
  assert.equal(restored.session.cliId, "codex");
  assert.equal(restored.session.workspaceDir, "C:\\projects\\original");
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

test("CLI 未建立会话时明确重试会重放失败任务", async () => {
  const manager = new SessionManager({ createId: () => "session-1" });
  const created = (await manager.resolve(address())).session;
  const pending = await manager.setRetryPrompt(created.id, "检查最新调用错误");

  assert.equal(resolveRetryPrompt(pending, "继续执行"), "检查最新调用错误");
  assert.equal(resolveRetryPrompt(pending, "重试。"), "检查最新调用错误");
  assert.equal(resolveRetryPrompt(pending, "执行另一个任务"), "执行另一个任务");

  const resumable = await manager.setCliSessionId(created.id, "codex-thread");
  assert.equal(resolveRetryPrompt(resumable, "继续执行"), "继续执行");
  assert.equal(isRetryRequest("继续执行。"), true);
  assert.equal(isRetryRequest("继续检查这个文件"), false);
});

test("失效 CLI 会话指针可以清除并保留待重试任务", async () => {
  const manager = new SessionManager({ createId: () => "session-1" });
  const created = (await manager.resolve(address())).session;
  await manager.setRetryPrompt(created.id, "原始任务");
  await manager.setCliSessionId(created.id, "expired-thread");

  const cleared = await manager.clearCliSessionId(created.id);

  assert.equal(cleared.cliSessionId, undefined);
  assert.equal(cleared.retryPrompt, "原始任务");
  assert.equal(resolveRetryPrompt(cleared, "继续执行"), "原始任务");
});

test("成功后可以清除待重试指令", async () => {
  const manager = new SessionManager({ createId: () => "session-1" });
  const created = (await manager.resolve(address())).session;

  await manager.setRetryPrompt(created.id, "原始任务");
  const cleared = await manager.setRetryPrompt(created.id, undefined);

  assert.equal(cleared.retryPrompt, undefined);
  assert.equal("retryPrompt" in cleared, false);
  await assert.rejects(
    manager.setRetryPrompt(created.id, "  "),
    /待重试指令不能为空/,
  );
  await assert.rejects(
    manager.setRetryPrompt("missing", "原始任务"),
    /会话不存在/,
  );
});

test("打开管理器时恢复原话题和会话 ID", async () => {
  const restored: Session = {
    id: "session-restored",
    botId: "developer",
    threadId: "omt_thread",
    chatId: "oc_chat",
    cliId: "codex",
    cliSessionId: "codex-thread",
    workspaceDir: "C:\\projects\\restored",
    status: "idle",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:01:00.000Z",
  };
  const store: SessionStore = {
    load: async () => [restored],
    save: async () => {},
  };

  const manager = await SessionManager.open({ store });
  const resolved = await manager.resolve(address(), "claude", "developer");

  assert.equal(manager.size, 1);
  assert.equal(resolved.isNew, false);
  assert.equal(resolved.session.id, "session-restored");
  assert.equal(resolved.session.cliSessionId, "codex-thread");
  assert.equal(resolved.session.botId, "developer");
  assert.equal(resolved.session.workspaceDir, "C:\\projects\\restored");
});

test("保存失败时回滚新建会话、状态变化和恢复信息", async () => {
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

  await assert.rejects(
    manager.setRetryPrompt(created.id, "原始任务"),
    /disk full/,
  );
  assert.equal(manager.get(created.id)?.retryPrompt, undefined);

  await assert.rejects(
    manager.setWorkspaceDir(created.id, "C:\\projects\\other"),
    /disk full/,
  );
  assert.equal(manager.get(created.id)?.workspaceDir, process.cwd());
});
