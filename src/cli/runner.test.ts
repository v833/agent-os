/**
 * 通用 CLI Runner 测试：用 Node 自身模拟外部 CLI，覆盖 JSONL 分行、
 * 会话恢复、协议错误、超时、取消与 Windows 进程树清理。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "./runner.js";
import type { CliAdapter, CliEvent } from "./types.js";

class ScriptAdapter implements CliAdapter {
  readonly id = "codex" as const;
  readonly command = process.execPath;
  readonly displayName = "测试 CLI";

  constructor(private readonly script: string) {}

  buildArgs(): string[] {
    return ["-e", this.script];
  }

  buildResumeArgs(): string[] {
    return ["-e", this.script];
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

test("协议事件明确报错时优先返回该错误", async () => {
  await assert.rejects(
    runScript(
      `console.log(JSON.stringify({ type: "error", message: "模型失败" }));`,
    ),
    /模型失败/,
  );
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

test("超过时限会终止子进程并返回超时文案", async () => {
  await assert.rejects(
    runScript(`setInterval(() => {}, 1000);`, { timeoutMs: 20 }),
    /测试 CLI 执行超时/,
  );
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
