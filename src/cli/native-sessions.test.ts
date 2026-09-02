/**
 * 原生会话列表测试：验证 Claude 项目 JSONL 的 cwd 过滤、标题回退和排序，
 * 避免 /resume 把其他项目的上下文暴露到当前话题。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ClaudeAdapter } from "./claude-adapter.js";
import { DimagentAdapter } from "./dimagent-adapter.js";
import { listNativeCliSessions } from "./native-sessions.js";

test("读取 Claude 当前项目会话并过滤其他 cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "threadpilot-native-sessions-"));
  const cwd = "C:\\projects\\threadpilot";
  const projectDir = join(root, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    await mkdir(projectDir, { recursive: true });
    const older = join(projectDir, "older.jsonl");
    const newer = join(projectDir, "newer.jsonl");
    const foreign = join(projectDir, "foreign.jsonl");
    await writeFile(
      older,
      `${JSON.stringify({ sessionId: "session-old", cwd })}\n${JSON.stringify({ type: "user", message: { content: "旧任务" } })}\n`,
      "utf8",
    );
    await writeFile(
      newer,
      `${JSON.stringify({ sessionId: "session-new", cwd })}\n${JSON.stringify({ type: "ai-title", aiTitle: "新任务" })}\n`,
      "utf8",
    );
    await writeFile(
      foreign,
      `${JSON.stringify({ sessionId: "session-foreign", cwd: "C:\\other" })}\n`,
      "utf8",
    );
    const now = Date.now() / 1000;
    await utimes(older, now - 10, now - 10);
    await utimes(newer, now, now);

    const sessions = await listNativeCliSessions({
      adapter: new ClaudeAdapter(),
      cwd,
    });
    assert.deepEqual(sessions.map((session) => session.id), [
      "session-new",
      "session-old",
    ]);
    assert.equal(sessions[0]?.title, "新任务");
    assert.equal(sessions[1]?.title, "旧任务");
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude 项目目录不存在时返回空列表", async () => {
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const root = await mkdtemp(join(tmpdir(), "threadpilot-native-sessions-empty-"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "missing");
  try {
    const sessions = await listNativeCliSessions({
      adapter: new ClaudeAdapter(),
      cwd: "C:\\projects\\missing",
    });
    assert.deepEqual(sessions, []);
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test("DimAgent 暂不提供原生会话列表", async () => {
  const sessions = await listNativeCliSessions({
    adapter: new DimagentAdapter(),
    cwd: process.cwd(),
  });
  assert.deepEqual(sessions, []);
});
