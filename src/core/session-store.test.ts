/**
 * JSON 会话存储测试：覆盖首次启动、合法快照、坏记录清理、
 * 中断状态恢复，以及并发保存时按调用顺序保留最终快照。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type Session } from "./session-manager.js";
import { JsonSessionStore } from "./session-store.js";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    threadId: "omt_thread",
    chatId: "oc_chat",
    cliId: "codex",
    status: "idle",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:01:00.000Z",
    ...overrides,
  };
}

async function temporaryStore(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "agent-os-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "data", "sessions.json");
  return { directory, filePath, store: new JsonSessionStore(filePath) };
}

test("会话文件不存在时按首次启动返回空列表", async (t) => {
  const { store } = await temporaryStore(t);
  assert.deepEqual(await store.load(), []);
});

test("保存后可以完整恢复 Codex 和 Claude 会话", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const sessions = [
    session(),
    session({
      id: "session-2",
      threadId: "omt_claude",
      cliId: "claude",
      cliSessionId: "claude-session",
      status: "closed",
    }),
  ];

  await store.save(sessions);

  assert.deepEqual(await store.load(), sessions);
  assert.equal((await readFile(filePath, "utf8")).endsWith("\n"), true);
});

test("加载时过滤坏记录并把中断会话恢复为空闲", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  await store.save([]);
  await writeFile(
    filePath,
    JSON.stringify([
      session({ status: "creating" }),
      session({ id: "session-2", threadId: "omt_active", status: "active" }),
      session({ id: "session-3", threadId: "omt_closed", status: "closed" }),
      session({ id: "session-4", threadId: "omt_bad", cliSessionId: "" }),
      { id: "", status: "idle" },
    ]),
    "utf8",
  );

  const restored = await store.load();

  assert.deepEqual(
    restored.map(({ id, status }) => ({ id, status })),
    [
      { id: "session-1", status: "idle" },
      { id: "session-2", status: "idle" },
      { id: "session-3", status: "closed" },
    ],
  );
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), restored);
});

test("顶层不是数组时拒绝加载会话文件", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  await store.save([]);
  await writeFile(filePath, JSON.stringify({ sessions: [] }), "utf8");

  await assert.rejects(store.load(), /会话文件格式错误/);
});

test("并发保存按调用顺序写入最后一个快照", async (t) => {
  const { store } = await temporaryStore(t);
  const first = [session({ status: "active" })];
  const second = [session({ status: "idle" })];

  await Promise.all([store.save(first), store.save(second)]);

  assert.deepEqual(await store.load(), second);
});

test("一次写入失败不会阻断后续保存", async (t) => {
  const { directory, store } = await temporaryStore(t);
  const dataPath = join(directory, "data");
  // 用同名普通文件阻止 mkdir，稳定模拟一次磁盘写入失败。
  await writeFile(dataPath, "blocked", "utf8");
  await assert.rejects(store.save([session({ status: "active" })]));

  await rm(dataPath);
  const recoveredSnapshot = [session({ status: "idle" })];
  await store.save(recoveredSnapshot);

  assert.deepEqual(await store.load(), recoveredSnapshot);
});

test("模拟重启后原话题复用同一会话并恢复为空闲", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const message = {
    messageId: "om_message",
    chatId: "oc_chat",
    threadId: "omt_thread",
    rootId: "",
  };
  const beforeRestart = await SessionManager.open({
    store,
    createId: () => "session-stable",
  });
  const created = (await beforeRestart.resolve(message)).session;
  await beforeRestart.transition(created.id, "active");
  await beforeRestart.setCliSessionId(created.id, "codex-thread");

  // 新建管理器模拟进程重启；磁盘中的 active 不能在新进程里继续执行。
  const afterRestart = await SessionManager.open({
    store: new JsonSessionStore(filePath),
  });
  const restored = await afterRestart.resolve(message);

  assert.equal(restored.isNew, false);
  assert.equal(restored.session.id, "session-stable");
  assert.equal(restored.session.status, "idle");
  assert.equal(restored.session.cliSessionId, "codex-thread");
});
