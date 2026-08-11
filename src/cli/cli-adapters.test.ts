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
    "--dangerously-skip-permissions",
    "-p",
    "你好",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  assert.deepEqual(adapter.buildResumeArgs("继续", "claude-session"), [
    "--resume",
    "claude-session",
    "--dangerously-skip-permissions",
    "-p",
    "继续",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  assert.deepEqual(adapter.buildCompactPlan("claude-session", "保留接口"), {
    protocol: "claude-stream-json",
    command: "claude",
    args: [
      "--resume",
      "claude-session",
      "--dangerously-skip-permissions",
      "-p",
      "/compact 保留接口",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
  });
});

test("Codex 首次对话和续聊参数符合 exec 协议", () => {
  const adapter = new CodexAdapter();

  assert.deepEqual(adapter.buildArgs("你好"), [
    "exec",
    "--json",
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "你好",
  ]);
  assert.deepEqual(adapter.buildResumeArgs("继续", "codex-thread"), [
    "exec",
    "resume",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "codex-thread",
    "继续",
  ]);
  assert.deepEqual(adapter.buildCompactPlan("codex-thread"), {
    protocol: "codex-app-server",
    command: "codex",
    args: ["app-server"],
    sessionId: "codex-thread",
  });
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

test("Claude Code 一行解析上下文和全部工具调用", () => {
  const adapter = new ClaudeAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session",
      }),
    ),
    [{ type: "session", sessionId: "claude-session" }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 3,
          },
          content: [
            {
              type: "tool_use",
              id: "tool-read",
              name: "Read",
              input: { file_path: "C:\\repo\\src\\index.ts" },
            },
            {
              type: "tool_use",
              id: "tool-bash",
              name: "Bash",
              input: { description: "  运行   测试  " },
            },
          ],
        },
      }),
    ),
    [
      { type: "context", usedTokens: 38 },
      {
        type: "tool_start",
        toolUseId: "tool-read",
        toolName: "Read",
        label: "读取文件",
        detail: "repo/src/index.ts",
      },
      {
        type: "tool_start",
        toolUseId: "tool-bash",
        toolName: "Bash",
        label: "运行命令",
        detail: "运行 测试",
      },
    ],
  );
});

test("Claude Code 解析工具结果、最终统计和结果错误", () => {
  const adapter = new ClaudeAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-read" },
            {
              type: "tool_result",
              tool_use_id: "tool-bash",
              is_error: true,
            },
          ],
        },
      }),
    ),
    [
      { type: "tool_end", toolUseId: "tool-read", failed: false },
      { type: "tool_end", toolUseId: "tool-bash", failed: true },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "result",
        result: "项目名是 agent-os",
        session_id: "claude-session",
        duration_ms: 1_500,
        num_turns: 2,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 3,
        },
        modelUsage: {
          claude: { contextWindow: 200_000 },
          fallback: { contextWindow: 128_000 },
        },
      }),
    ),
    [
      {
        type: "result",
        answer: "项目名是 agent-os",
        sessionId: "claude-session",
        stats: {
          durationMs: 1_500,
          turns: 2,
          totalTokens: 38,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 20,
          cacheCreationTokens: 3,
          contextWindowTokens: 200_000,
        },
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "余额不足",
      }),
    ),
    [{ type: "error", message: "余额不足" }],
  );
  assert.deepEqual(adapter.parseEvents("diagnostic"), []);
  assert.deepEqual(
    adapter.parseEvents(JSON.stringify({ type: "assistant" })),
    [],
  );
});

test("Codex 解析会话、四类工具、上下文、统计和最终回答", () => {
  const adapter = new CodexAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }),
    ),
    [{ type: "session", sessionId: "codex-thread" }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item-1",
          type: "command_execution",
          command: "pwsh.exe -Command Get-Location",
          status: "in_progress",
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "item-1",
        toolName: "Bash",
        label: "运行命令",
        detail: "pwsh.exe -Command Get-Location",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item-1",
          type: "command_execution",
          exit_code: 0,
          status: "completed",
        },
      }),
    ),
    [{ type: "tool_end", toolUseId: "item-1", failed: false }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item-file",
          type: "file_change",
          changes: [{ path: "src/index.ts" }],
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "item-file",
        toolName: "Edit",
        label: "修改文件",
        detail: "src/index.ts",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.started",
        item: { id: "item-search", type: "web_search", query: "Codex CLI" },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "item-search",
        toolName: "WebSearch",
        label: "搜索资料",
        detail: "Codex CLI",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item-mcp",
          type: "mcp_tool_call",
          server: "github",
          tool: "get_issue",
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "item-mcp",
        toolName: "MCP",
        label: "调用外部工具",
        detail: "github.get_issue",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "项目名是 agent-os" },
      }),
    ),
    [{ type: "result", answer: "项目名是 agent-os" }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 76_260,
          cached_input_tokens: 41_216,
          output_tokens: 126,
        },
      }),
    ),
    [
      { type: "context", usedTokens: 76_260 },
      {
        type: "result",
        answer: "",
        stats: {
          totalTokens: 76_386,
          inputTokens: 76_260,
          outputTokens: 126,
          cacheReadTokens: 41_216,
        },
      },
    ],
  );
});

test("Codex 标记命令失败并解析协议错误", () => {
  const adapter = new CodexAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item-failed",
          type: "command_execution",
          exit_code: 1,
          status: "failed",
        },
      }),
    ),
    [{ type: "tool_end", toolUseId: "item-failed", failed: true }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "模型不可用" },
      }),
    ),
    [{ type: "error", message: "模型不可用" }],
  );
  assert.deepEqual(adapter.parseEvents("not-json"), []);
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.completed",
        item: { id: "reasoning", type: "reasoning", text: "分析" },
      }),
    ),
    [],
  );
});

test("适配器能识别失效的续聊会话并忽略普通模型错误", () => {
  assert.equal(
    new CodexAdapter().isSessionUnavailable("Could not find thread abc"),
    true,
  );
  assert.equal(
    new CodexAdapter().isSessionUnavailable("模型不可用"),
    false,
  );
  assert.equal(
    new ClaudeAdapter().isSessionUnavailable("No such session: abc"),
    true,
  );
  assert.equal(
    new ClaudeAdapter().isSessionUnavailable("rate limit exceeded"),
    false,
  );
});
