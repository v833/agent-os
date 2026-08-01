/**
 * Codex 与 Claude Code 适配器测试：验证首次/续聊参数安全边界，
 * 以及两种真实 JSONL 协议到统一事件的映射。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { ClaudeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { resolveCliCommand } from "./command-resolver.js";

test("用户提示词始终作为单独参数传给两个 CLI", () => {
  const prompt = '检查 "package.json"\n$(Remove-Item important.txt)';
  const adapters = [new ClaudeAdapter(), new CodexAdapter()];

  for (const adapter of adapters) {
    const first = adapter.buildArgs(prompt);
    const resumed = adapter.buildResumeArgs(prompt, "session-id");
    assert.equal(first.filter((argument) => argument === prompt).length, 1);
    assert.equal(resumed.filter((argument) => argument === prompt).length, 1);
  }
});

test("Claude Code 首次对话和续聊参数符合 headless 协议", () => {
  const adapter = new ClaudeAdapter();

  assert.deepEqual(adapter.buildArgs("你好"), [
    "-p",
    "你好",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  assert.deepEqual(adapter.buildResumeArgs("继续", "claude-session"), [
    "--resume",
    "claude-session",
    "-p",
    "继续",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
});

test("Codex 首次对话和续聊参数符合 exec 协议", () => {
  const adapter = new CodexAdapter();

  assert.deepEqual(adapter.buildArgs("你好"), [
    "exec",
    "--json",
    "--full-auto",
    "--skip-git-repo-check",
    "你好",
  ]);
  assert.deepEqual(adapter.buildResumeArgs("继续", "codex-thread"), [
    "exec",
    "resume",
    "codex-thread",
    "--json",
    "--full-auto",
    "--skip-git-repo-check",
    "继续",
  ]);
});

test("Windows 下解析到可直接 spawn 的真实 CLI 入口", () => {
  if (process.platform !== "win32") return;

  const codex = resolveCliCommand("codex");
  const claude = resolveCliCommand("claude");

  assert.equal(existsSync(codex.command), true);
  assert.equal(existsSync(claude.command), true);
  assert.equal(codex.command.toLowerCase().endsWith(".cmd"), false);
  assert.equal(claude.command.toLowerCase().endsWith(".cmd"), false);
});

test("Claude Code 解析初始化、最终回答和结果错误", () => {
  const adapter = new ClaudeAdapter();

  assert.deepEqual(
    adapter.parseEvent(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session",
      }),
    ),
    { type: "session", sessionId: "claude-session" },
  );
  assert.deepEqual(
    adapter.parseEvent(
      JSON.stringify({
        type: "result",
        result: "项目名是 agent-os",
        session_id: "claude-session",
      }),
    ),
    {
      type: "result",
      answer: "项目名是 agent-os",
      sessionId: "claude-session",
    },
  );
  assert.deepEqual(
    adapter.parseEvent(
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "余额不足",
      }),
    ),
    { type: "error", message: "余额不足" },
  );
  assert.equal(adapter.parseEvent("diagnostic"), undefined);
  assert.equal(adapter.parseEvent(JSON.stringify({ type: "assistant" })), undefined);
});

test("Codex 解析会话、最终回答和协议错误", () => {
  const adapter = new CodexAdapter();

  assert.deepEqual(
    adapter.parseEvent(
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }),
    ),
    { type: "session", sessionId: "codex-thread" },
  );
  assert.deepEqual(
    adapter.parseEvent(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "项目名是 agent-os" },
      }),
    ),
    { type: "result", answer: "项目名是 agent-os" },
  );
  assert.deepEqual(
    adapter.parseEvent(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "模型不可用" },
      }),
    ),
    { type: "error", message: "模型不可用" },
  );
  assert.equal(adapter.parseEvent("not-json"), undefined);
});
