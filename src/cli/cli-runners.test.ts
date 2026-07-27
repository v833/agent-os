/**
 * Claude Code 与 Codex 适配器测试：验证命令参数安全边界，
 * 以及两种真实 JSONL 协议的最终回答、会话 ID 和错误解析。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  claudeArgs,
  parseClaudeResultEvent,
} from "./claude-runner.js";
import { codexArgs, parseCodexEvent } from "./codex-runner.js";
import { resolveCliCommand } from "./command-resolver.js";

test("用户提示词始终作为单独参数传给两个 CLI", () => {
  const prompt = '检查 "package.json"\n$(Remove-Item important.txt)';
  const claude = claudeArgs(prompt);
  const codex = codexArgs(prompt);

  assert.equal(claude[1], prompt);
  assert.equal(claude.filter((argument) => argument === prompt).length, 1);
  assert.equal(codex.at(-1), prompt);
  assert.equal(codex.filter((argument) => argument === prompt).length, 1);
});

test("Windows 下解析到可直接 spawn 的真实 CLI 入口", () => {
  if (process.platform !== "win32") return;

  const codex = resolveCliCommand({
    name: "codex",
    windowsPackageEntry: [
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    ],
    windowsPackageEntryType: "node",
  });
  const claude = resolveCliCommand({
    name: "claude",
    windowsPackageEntry: [
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    ],
    windowsPackageEntryType: "executable",
  });

  assert.equal(existsSync(codex.command), true);
  assert.equal(existsSync(claude.command), true);
  assert.equal(codex.command.toLowerCase().endsWith(".cmd"), false);
  assert.equal(claude.command.toLowerCase().endsWith(".cmd"), false);
});

test("解析 Claude Code 最终回答、会话 ID 和结果错误", () => {
  assert.deepEqual(
    parseClaudeResultEvent({
      type: "result",
      result: "项目名是 agent-os",
      session_id: "claude-session",
    }),
    {
      result: {
        answer: "项目名是 agent-os",
        sessionId: "claude-session",
      },
    },
  );
  assert.match(
    parseClaudeResultEvent({
      type: "result",
      is_error: true,
      result: "余额不足",
    })?.error?.message ?? "",
    /余额不足/,
  );
  assert.equal(parseClaudeResultEvent({ type: "assistant" }), undefined);
});

test("解析 Codex 会话、最终回答和协议错误", () => {
  assert.deepEqual(
    parseCodexEvent({ type: "thread.started", thread_id: "codex-thread" }),
    { sessionId: "codex-thread" },
  );
  assert.deepEqual(
    parseCodexEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "项目名是 agent-os" },
    }),
    { answer: "项目名是 agent-os" },
  );
  assert.match(
    parseCodexEvent({
      type: "turn.failed",
      error: { message: "模型不可用" },
    })?.error?.message ?? "",
    /模型不可用/,
  );
});
