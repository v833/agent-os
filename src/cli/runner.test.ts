/**
 * 通用 CLI Runner 测试：用 Node 自身模拟外部 CLI，覆盖 JSONL 分行、
 * 会话恢复、协议错误、超时、取消与 Windows 进程树清理。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CliRunError, runCli, runCliWithTransientRetry } from "./runner.js";
import type { CliAdapter, CliEvent } from "./types.js";

class ScriptAdapter implements CliAdapter {
  readonly id: CliAdapter["id"];
  readonly command = process.execPath;
  readonly displayName = "测试 CLI";

  constructor(
    private readonly script: string,
    id: CliAdapter["id"] = "codex",
  ) {
    this.id = id;
  }

  buildArgs(): string[] {
    return ["-e", this.script];
  }

  buildResumeArgs(): string[] {
    return ["-e", this.script];
  }

  buildCompactPlan(sessionId: string) {
    return {
      protocol: "codex-app-server" as const,
      command: this.command,
      args: ["-e", this.script],
      sessionId,
    };
  }

  parseEvents(line: string): CliEvent[] {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return [];
    }
    const events = Array.isArray(value) ? value : [value];
    return events.filter(
      (event): event is CliEvent =>
        typeof event === "object" &&
        event !== null &&
        typeof (event as { type?: unknown }).type === "string",
    );
  }
}

function runScript(
  script: string,
  options: { sessionId?: string; signal?: AbortSignal; timeoutMs?: number } = {},
) {
  return runCli({
    adapter: new ScriptAdapter(script),
    prompt: "测试",
    cwd: process.cwd(),
    ...options,
  });
}

test("忽略日志噪音并把分段 stdout 还原成完整 JSONL", async () => {
  const result = await runScript(`
    process.stdout.write("diagnostic\\n");
    process.stdout.write('{"type":"result",');
    setTimeout(() => process.stdout.write('"answer":"完成"}\\n'), 10);
  `);

  assert.deepEqual(result, { answer: "完成" });
});

test("stderr 出现认证提示时立即终止进程并返回认证错误（不等引擎超时）", async () => {
  // 模拟 agy 未登录：stderr 打印认证提示后长时间挂起等待。
  const adapter: CliAdapter = {
    id: "agy",
    command: process.execPath,
    displayName: "测试 CLI",
    buildArgs() {
      return [
        "-e",
        `process.stderr.write("Authentication required. Please visit the URL to log in:\\n  https://accounts.google.com/oauth?x=1\\nOr, paste the authorization code here and press Enter:\\n"); setTimeout(() => {}, 60000);`,
      ];
    },
    buildResumeArgs() {
      throw new Error("不应构造续聊参数");
    },
    buildCompactPlan(sessionId) {
      return {
        protocol: "codex-app-server",
        command: process.execPath,
        args: ["-e", ""],
        sessionId,
      };
    },
    parseEvents() {
      return [];
    },
    isAuthRequired(message: string) {
      return /authentication required/i.test(message);
    },
  };

  const started = Date.now();
  await assert.rejects(
    runCli({ adapter, prompt: "测试", cwd: process.cwd() }),
    /Authentication required/,
  );
  assert.ok(
    Date.now() - started < 10_000,
    "检测到认证需求应立即终止，而不是等引擎的 60s 登录超时",
  );
});

test("调用方传入的 env 环境变量会注入子进程", async () => {
  const parser = new ScriptAdapter("");
  const adapter: CliAdapter = {
    id: "agy",
    command: process.execPath,
    displayName: "测试 CLI",
    buildArgs() {
      return [
        "-e",
        `console.log(JSON.stringify({ type: "result", answer: process.env.AGY_TEST_MARKER ?? "missing" }));`,
      ];
    },
    buildResumeArgs() {
      throw new Error("不应构造续聊参数");
    },
    buildCompactPlan(sessionId) {
      return {
        protocol: "codex-app-server",
        command: process.execPath,
        args: ["-e", ""],
        sessionId,
      };
    },
    parseEvents: parser.parseEvents.bind(parser),
  };

  const result = await runCli({
    adapter,
    prompt: "测试",
    cwd: process.cwd(),
    env: { AGY_TEST_MARKER: "注入成功" },
  });

  assert.deepEqual(result, { answer: "注入成功" });
});

test("不传 env 时子进程继承父进程环境（.env 全局代理默认生效）", async () => {
  const saved = process.env.AGY_INHERIT_MARKER;
  process.env.AGY_INHERIT_MARKER = "继承成功";
  try {
    const result = await runScript(
      `console.log(JSON.stringify({ type: "result", answer: process.env.AGY_INHERIT_MARKER ?? "missing" }));`,
    );
    assert.deepEqual(result, { answer: "继承成功" });
  } finally {
    if (saved === undefined) delete process.env.AGY_INHERIT_MARKER;
    else process.env.AGY_INHERIT_MARKER = saved;
  }
});

test("传入的 env 覆盖父进程同名环境变量（bots.json 优先于 .env）", async () => {
  const saved = process.env.AGY_TEST_MARKER;
  process.env.AGY_TEST_MARKER = "全局值";
  try {
    const result = await runCli({
      adapter: new ScriptAdapter(
        `console.log(JSON.stringify({ type: "result", answer: process.env.AGY_TEST_MARKER ?? "missing" }));`,
      ),
      prompt: "测试",
      cwd: process.cwd(),
      env: { AGY_TEST_MARKER: "bot覆盖值" },
    });
    assert.deepEqual(result, { answer: "bot覆盖值" });
  } finally {
    if (saved === undefined) delete process.env.AGY_TEST_MARKER;
    else process.env.AGY_TEST_MARKER = saved;
  }
});

test("会话事件与结果分开发送时返回最新会话 ID", async () => {
  const result = await runScript(`
    console.log(JSON.stringify({ type: "session", sessionId: "new-session" }));
    console.log(JSON.stringify({ type: "result", answer: "完成" }));
  `);

  assert.deepEqual(result, { answer: "完成", sessionId: "new-session" });
});

test("续聊没有返回新 ID 时沿用传入的会话 ID", async () => {
  const result = await runScript(
    `console.log(JSON.stringify({ type: "result", answer: "继续完成" }));`,
    { sessionId: "existing-session" },
  );

  assert.deepEqual(result, {
    answer: "继续完成",
    sessionId: "existing-session",
  });
});

test("传入会话 ID 时 Runner 使用适配器的续聊参数", async () => {
  const parser = new ScriptAdapter("");
  const adapter: CliAdapter = {
    id: "codex",
    command: process.execPath,
    displayName: "测试 CLI",
    buildArgs() {
      throw new Error("不应构造首次对话参数");
    },
    buildResumeArgs(prompt, sessionId) {
      assert.equal(prompt, "继续");
      assert.equal(sessionId, "existing-session");
      return [
        "-e",
        `console.log(JSON.stringify({ type: "result", answer: "已续接" }));`,
      ];
    },
    buildCompactPlan(sessionId) {
      return {
        protocol: "codex-app-server",
        command: process.execPath,
        args: ["-e", ""],
        sessionId,
      };
    },
    parseEvents: parser.parseEvents.bind(parser),
  };

  const result = await runCli({
    adapter,
    prompt: "继续",
    cwd: process.cwd(),
    sessionId: "existing-session",
  });

  assert.deepEqual(result, {
    answer: "已续接",
    sessionId: "existing-session",
  });
});

test("Runner 在构造 CLI 参数前等待适配器准备工作区配置", async () => {
  let prepared = false;
  const parser = new ScriptAdapter("");
  const adapter: CliAdapter = {
    id: "agy",
    command: process.execPath,
    displayName: "测试 CLI",
    async prepareRun(cwd) {
      assert.equal(cwd, process.cwd());
      await new Promise((resolve) => setTimeout(resolve, 5));
      prepared = true;
    },
    buildArgs() {
      assert.equal(prepared, true);
      return [
        "-e",
        `console.log(JSON.stringify({ type: "result", answer: "配置已准备" }));`,
      ];
    },
    buildResumeArgs() {
      throw new Error("不应构造续聊参数");
    },
    buildCompactPlan(sessionId) {
      return {
        protocol: "codex-app-server",
        command: process.execPath,
        args: ["-e", ""],
        sessionId,
      };
    },
    parseEvents: parser.parseEvents.bind(parser),
  };

  const result = await runCli({
    adapter,
    prompt: "测试",
    cwd: process.cwd(),
  });
  assert.deepEqual(result, { answer: "配置已准备" });
});

test("续聊时 stderr 提示会话已失效会把静默新建会话判为失败", async () => {
  const parser = new ScriptAdapter("");
  const adapter: CliAdapter = {
    id: "agy",
    command: process.execPath,
    displayName: "测试 CLI",
    buildArgs() {
      throw new Error("不应构造首次对话参数");
    },
    buildResumeArgs(_prompt, sessionId) {
      assert.equal(sessionId, "stale-session");
      return [
        "-e",
        `
          console.error('warning: conversation "stale-session" not found');
          console.log(JSON.stringify({ type: "session", sessionId: "new-session" }));
          console.log(JSON.stringify({ type: "result", answer: "新会话的回答" }));
        `,
      ];
    },
    buildCompactPlan(sessionId) {
      return {
        protocol: "codex-app-server",
        command: process.execPath,
        args: ["-e", ""],
        sessionId,
      };
    },
    parseEvents: parser.parseEvents.bind(parser),
    // 模拟 agy 对“会话不存在”的 stderr 警告识别。
    isSessionUnavailable(message) {
      return /conversation[^\n]*not found/.test(message);
    },
  };

  await assert.rejects(
    runCli({
      adapter,
      prompt: "继续",
      cwd: process.cwd(),
      sessionId: "stale-session",
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliRunError);
      assert.match(error.message, /会话已失效/);
      assert.equal(error.sessionId, "new-session");
      return true;
    },
  );
});

test("协议事件明确报错时优先返回该错误", async () => {
  await assert.rejects(
    runScript(
      `console.log(JSON.stringify({ type: "error", message: "模型失败" }));`,
    ),
    /模型失败/,
  );
});

test("失败时保留已经观察到的 CLI 会话 ID", async () => {
  await assert.rejects(
    runScript(`
      console.log(JSON.stringify({ type: "session", sessionId: "recoverable" }));
      console.log(JSON.stringify({ type: "error", message: "服务不可用" }));
    `),
    (error: unknown) => {
      assert.ok(error instanceof CliRunError);
      assert.equal(error.message, "服务不可用");
      assert.equal(error.sessionId, "recoverable");
      return true;
    },
  );
});

test("流式连接中断时自动重试并续接已建立的 CLI 会话", async () => {
  let resumeCalls = 0;
  const parser = new ScriptAdapter("");
  const adapter: CliAdapter = {
    id: "codex",
    command: process.execPath,
    displayName: "测试 CLI",
    // 模拟 Codex 声明支持瞬时断流重试。
    retryOnDisconnect: true,
    buildArgs() {
      return [
        "-e",
        `
          console.log(JSON.stringify({ type: "session", sessionId: "retry-session" }));
          console.error("Reconnecting... 1/5 (stream disconnected before completion: Upstream request failed)");
          process.exit(1);
        `,
      ];
    },
    buildResumeArgs(_prompt, sessionId) {
      resumeCalls += 1;
      assert.equal(sessionId, "retry-session");
      return [
        "-e",
        `console.log(JSON.stringify({ type: "result", answer: "重试成功" }));`,
      ];
    },
    buildCompactPlan(sessionId) {
      return {
        protocol: "codex-app-server",
        command: process.execPath,
        args: ["-e", ""],
        sessionId,
      };
    },
    parseEvents: parser.parseEvents.bind(parser),
  };

  const result = await runCliWithTransientRetry({
    adapter,
    prompt: "继续",
    cwd: process.cwd(),
  });

  assert.deepEqual(result, {
    answer: "重试成功",
    sessionId: "retry-session",
  });
  assert.equal(resumeCalls, 1);
});

test("普通 CLI 错误不会触发自动重试", async () => {
  let attempts = 0;
  const adapter = new ScriptAdapter(
    `
      process.stderr.write("认证失败");
      process.exit(3);
    `,
  );
  const originalBuildArgs = adapter.buildArgs.bind(adapter);
  adapter.buildArgs = (...args) => {
    attempts += 1;
    return originalBuildArgs(...args);
  };

  await assert.rejects(
    runCliWithTransientRetry({
      adapter,
      prompt: "测试",
      cwd: process.cwd(),
    }),
    /认证失败/,
  );
  assert.equal(attempts, 1);
});

test("Claude 即使收到同样文案也不会触发 Codex 自动重试", async () => {
  let attempts = 0;
  const adapter = new ScriptAdapter(
    `
      process.stderr.write("stream disconnected before completion: Upstream request failed");
      process.exit(3);
    `,
    "claude",
  );
  const originalBuildArgs = adapter.buildArgs.bind(adapter);
  adapter.buildArgs = (...args) => {
    attempts += 1;
    return originalBuildArgs(...args);
  };

  await assert.rejects(
    runCliWithTransientRetry({
      adapter,
      prompt: "测试",
      cwd: process.cwd(),
    }),
    /stream disconnected before completion/,
  );
  assert.equal(attempts, 1);
});

test("按顺序分发一行中的多个事件并保留最终统计", async () => {
  const observed: CliEvent[] = [];
  const result = await runCli({
    adapter: new ScriptAdapter(`
      console.log(JSON.stringify([
        { type: "context", usedTokens: 100 },
        {
          type: "tool_start",
          toolUseId: "tool-1",
          toolName: "Read",
          label: "读取文件"
        },
        { type: "tool_end", toolUseId: "tool-1", failed: false },
        {
          type: "result",
          answer: "完成",
          stats: { durationMs: 500, turns: 1 }
        }
      ]));
    `),
    prompt: "测试",
    cwd: process.cwd(),
    onEvent: (event) => observed.push(event),
  });

  assert.deepEqual(
    observed.map((event) => event.type),
    ["context", "tool_start", "tool_end", "result"],
  );
  assert.deepEqual(result, {
    answer: "完成",
    stats: { durationMs: 500, turns: 1 },
  });
});

test("tool_call 按 id 去重并剔除失败的调用", async () => {
  const result = await runScript(`
    console.log(JSON.stringify([
      {
        type: "tool_call",
        toolUseId: "tool-a",
        toolName: "request_clarification",
        input: { title: "澄清" }
      },
      {
        type: "tool_call",
        toolUseId: "tool-a",
        toolName: "request_clarification",
        input: { title: "澄清" }
      },
      {
        type: "tool_call",
        toolUseId: "tool-b",
        toolName: "request_clarification",
        input: { title: "澄清二" }
      },
      { type: "tool_end", toolUseId: "tool-b", failed: true },
      { type: "result", answer: "完成" }
    ]));
  `);

  assert.deepEqual(result.toolCalls, [
    {
      toolUseId: "tool-a",
      toolName: "request_clarification",
      input: { title: "澄清" },
    },
  ]);
});

test("Codex 回答先到统计后到时合并为完整结果", async () => {
  const result = await runScript(`
    console.log(JSON.stringify({ type: "result", answer: "完成" }));
    console.log(JSON.stringify({
      type: "result",
      answer: "",
      stats: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }
    }));
  `);

  assert.deepEqual(result, {
    answer: "完成",
    stats: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
  });
});

test("Codex 统计先到回答后到时合并为完整结果", async () => {
  const result = await runScript(`
    console.log(JSON.stringify({
      type: "result",
      answer: "",
      stats: { inputTokens: 40, outputTokens: 10, totalTokens: 50 }
    }));
    console.log(JSON.stringify({ type: "result", answer: "继续完成" }));
  `);

  assert.deepEqual(result, {
    answer: "继续完成",
    stats: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
  });
});

test("事件观察者抛错时 Runner 稳定拒绝而不产生未捕获异常", async () => {
  await assert.rejects(
    runCli({
      adapter: new ScriptAdapter(
        `console.log(JSON.stringify({ type: "result", answer: "完成" }));`,
      ),
      prompt: "测试",
      cwd: process.cwd(),
      onEvent: () => {
        throw new Error("观察者失败");
      },
    }),
    /观察者失败/,
  );
});

test("异常退出时优先返回 stderr", async () => {
  await assert.rejects(
    runScript(`process.stderr.write("认证失败"); process.exit(3);`),
    /认证失败/,
  );
});

test("正常退出但没有最终事件时视为协议失败", async () => {
  await assert.rejects(
    runScript(`process.stdout.write("{}\\n");`),
    /没有返回最终结果/,
  );
});

test("AbortController 会终止子进程并返回稳定取消文案", async () => {
  const controller = new AbortController();
  const running = runScript(`setInterval(() => {}, 1000);`, {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(running, /测试 CLI 执行已取消/);
});

test("取消时保留已经观察到的 CLI 会话 ID", async () => {
  const controller = new AbortController();
  const running = runScript(
    `
      console.log(JSON.stringify({ type: "session", sessionId: "cancelled-session" }));
      setInterval(() => {}, 1000);
    `,
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(running, (error: unknown) => {
    assert.ok(error instanceof CliRunError);
    assert.equal(error.sessionId, "cancelled-session");
    assert.match(error.message, /执行已取消/);
    return true;
  });
});

test("超过时限会终止子进程并返回超时文案", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runScript(`setInterval(() => {}, 1000);`, { timeoutMs: 20 }),
    /测试 CLI 执行超时/,
  );
  assert.ok(Date.now() - startedAt < 3_000, "超时必须在终止宽限期内结束");
});

test("开始前已经取消时不会启动 CLI", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runScript(`throw new Error("不应执行");`, { signal: controller.signal }),
    /测试 CLI 执行已取消/,
  );
});

test("Windows 取消会终止 CLI 启动的整个进程树", async () => {
  if (process.platform !== "win32") return;

  const controller = new AbortController();
  let descendantPid: number | undefined;
  let notifyDescendant: (() => void) | undefined;
  const descendantStarted = new Promise<void>((resolve) => {
    notifyDescendant = resolve;
  });
  const adapter = new ScriptAdapter(`
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    process.stdout.write(JSON.stringify({ type: "descendant", pid: child.pid }) + "\\n");
    setInterval(() => {}, 1000);
  `);
  const originalParseEvents = adapter.parseEvents.bind(adapter);
  adapter.parseEvents = (line) => {
    const event = JSON.parse(line) as { type?: string; pid?: number };
    if (event.type === "descendant") {
      descendantPid = event.pid;
      notifyDescendant?.();
      return [];
    }
    return originalParseEvents(line);
  };
  const running = runCli({
    adapter,
    prompt: "测试",
    cwd: process.cwd(),
    signal: controller.signal,
  });

  await descendantStarted;
  controller.abort();
  await assert.rejects(running, /测试 CLI 执行已取消/);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(descendantPid);
  assert.throws(
    () => process.kill(descendantPid!, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );
});
