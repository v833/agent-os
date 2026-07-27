/**
 * JSONL 子进程底座测试：用 Node 自身模拟外部 CLI，覆盖分行、噪音、
 * 协议错误、异常退出、缺少结果与 AbortController 取消。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  runJsonlProcess,
  type JsonlEventOutcome,
} from "./jsonl-runner.js";

function runScript<T>(
  script: string,
  onEvent: (event: unknown) => JsonlEventOutcome<T> | undefined,
  signal?: AbortSignal,
) {
  return runJsonlProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    signal,
    displayName: "测试 CLI",
    cancelledMessage: "测试 CLI 执行已取消",
    missingResultMessage: "测试 CLI 没有返回最终结果",
    onEvent,
  });
}

test("忽略日志噪音并把分段 stdout 还原成完整 JSONL", async () => {
  const script = `
    process.stdout.write("diagnostic\\n");
    process.stdout.write('{"type":"result",');
    setTimeout(() => process.stdout.write('"answer":"完成"}\\n'), 10);
  `;

  const result = await runScript(script, (event) => {
    if (
      typeof event === "object" &&
      event !== null &&
      (event as { type?: unknown }).type === "result"
    ) {
      return { result: (event as { answer: string }).answer };
    }
    return undefined;
  });

  assert.equal(result, "完成");
});

test("协议事件明确报错时优先返回该错误", async () => {
  const script = `process.stdout.write('{"type":"error","message":"模型失败"}\\n');`;

  await assert.rejects(
    runScript(script, (event) => {
      if (
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "error"
      ) {
        return { error: new Error("模型失败") };
      }
      return undefined;
    }),
    /模型失败/,
  );
});

test("异常退出时优先返回 stderr", async () => {
  await assert.rejects(
    runScript(
      `process.stderr.write("认证失败"); process.exit(3);`,
      () => undefined,
    ),
    /认证失败/,
  );
});

test("正常退出但没有最终事件时视为协议失败", async () => {
  await assert.rejects(
    runScript(`process.stdout.write("{}\\n");`, () => undefined),
    /没有返回最终结果/,
  );
});

test("AbortController 会终止子进程并返回稳定取消文案", async () => {
  const controller = new AbortController();
  const running = runScript(
    `setInterval(() => {}, 1000);`,
    () => undefined,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(running, /测试 CLI 执行已取消/);
});

test("Windows 取消会终止 CLI 启动的整个进程树", async () => {
  if (process.platform !== "win32") return;

  const controller = new AbortController();
  let descendantPid: number | undefined;
  let notifyDescendant: (() => void) | undefined;
  const descendantStarted = new Promise<void>((resolve) => {
    notifyDescendant = resolve;
  });
  const script = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    process.stdout.write(JSON.stringify({ type: "descendant", pid: child.pid }) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const running = runScript(
    script,
    (event) => {
      if (
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "descendant"
      ) {
        descendantPid = (event as { pid: number }).pid;
        notifyDescendant?.();
      }
      return undefined;
    },
    controller.signal,
  );

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
