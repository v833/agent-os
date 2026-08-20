/**
 * AcpDaemon 常驻进程测试：用 Node 子进程模拟标准 stdio server，覆盖
 * 多轮进程复用、并发 session 路由、空闲回收与崩溃重连，不依赖真实 DimAgent。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { AcpDaemon } from "./acp-daemon.js";
import type { CliAdapter, CliEvent } from "./types.js";

/** 常驻进程测试用脚本：session/new 返回递增 id，prompt 应答包含自身 sessionId，
 *  用于验证同一进程上多轮/并发 turn 的通知路由互不串扰。 */
const ACP_RESIDENT_SERVER_SCRIPT = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
let nextSession = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } } });
    return;
  }
  if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: "acp-session-" + (++nextSession) } });
    return;
  }
  if (message.method === "session/resume") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method !== "session/prompt") return;
  const sessionId = message.params.sessionId;
  send({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.AGENT_OS_TEST_PROXY || ("答-" + sessionId) } } }
  });
  send({ id: message.id, result: { stopReason: "end_turn", usage: { totalTokens: 10, inputTokens: 5, outputTokens: 5 } } });
});
`;

class AcpScriptAdapter implements CliAdapter {
  readonly id = "dimagent" as const;
  readonly command = process.execPath;
  readonly displayName = "测试 DimAgent";
  readonly accessMode = "acp" as const;

  buildArgs(): string[] {
    return ["-e", ACP_RESIDENT_SERVER_SCRIPT];
  }

  buildResumeArgs(): string[] {
    return this.buildArgs();
  }

  buildCompactPlan(): never {
    throw new Error("测试不支持 compact");
  }

  parseEvents(): CliEvent[] {
    return [];
  }
}

/** 命令不存在的适配器，用于验证启动失败路径不会泄漏未处理的子进程错误。 */
class MissingCommandAdapter implements CliAdapter {
  readonly id = "dimagent" as const;
  readonly command = "dim-agent-os-no-such-command";
  readonly displayName = "测试缺失命令";
  readonly accessMode = "acp" as const;

  buildArgs(): string[] {
    return ["acp"];
  }

  buildResumeArgs(): string[] {
    return ["acp"];
  }

  buildCompactPlan(): never {
    throw new Error("测试不支持 compact");
  }

  parseEvents(): CliEvent[] {
    return [];
  }
}

test("AcpDaemon 常驻复用：多轮任务共享同一子进程", async () => {
  const daemon = new AcpDaemon(new AcpScriptAdapter());
  try {
    const first = await daemon.runTurn({ prompt: "任务一", cwd: process.cwd() });
    const pidAfterFirst = daemon.pid;
    assert.ok(pidAfterFirst, "首轮后应持有常驻进程");
    assert.equal(first.sessionId, "acp-session-1");

    const second = await daemon.runTurn({
      prompt: "任务二",
      cwd: process.cwd(),
      sessionId: first.sessionId,
    });
    assert.equal(daemon.pid, pidAfterFirst, "第二轮应复用同一进程而不是重新拉起");
    assert.equal(second.sessionId, "acp-session-1");
    assert.equal(second.answer, "答-acp-session-1");
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 把 Bot 级环境注入常驻子进程", async () => {
  const daemon = new AcpDaemon(new AcpScriptAdapter(), undefined, {
    AGENT_OS_TEST_PROXY: "proxy-marker",
  });
  try {
    const result = await daemon.runTurn({ prompt: "检查环境", cwd: process.cwd() });
    assert.equal(result.answer, "proxy-marker");
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 并发：同一进程上多个 session 并行执行且通知不串扰", async () => {
  const daemon = new AcpDaemon(new AcpScriptAdapter());
  try {
    const [a, b] = await Promise.all([
      daemon.runTurn({ prompt: "并发一", cwd: process.cwd() }),
      daemon.runTurn({ prompt: "并发二", cwd: process.cwd() }),
    ]);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(a.answer, `答-${a.sessionId}`);
    assert.equal(b.answer, `答-${b.sessionId}`);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 空闲回收：无任务超过阈值后自动关闭进程", async () => {
  const daemon = new AcpDaemon(new AcpScriptAdapter(), 200);
  try {
    await daemon.runTurn({ prompt: "跑一轮", cwd: process.cwd() });
    assert.ok(daemon.pid, "刚跑完任务应仍持有进程");
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(daemon.pid, undefined, "空闲超时后应回收进程");
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 崩溃重连：进程退出后下一轮自动重建", async () => {
  const daemon = new AcpDaemon(new AcpScriptAdapter());
  try {
    const first = await daemon.runTurn({ prompt: "首轮", cwd: process.cwd() });
    const pidBeforeCrash = daemon.pid;
    assert.ok(pidBeforeCrash);

    // 模拟进程崩溃：强制结束整个进程树，daemon 应感知并标记失效。
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(pidBeforeCrash), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("exit", () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = await daemon.runTurn({
      prompt: "崩溃后重试",
      cwd: process.cwd(),
      sessionId: first.sessionId,
    });
    assert.notEqual(daemon.pid, pidBeforeCrash, "崩溃后应重建新进程");
    assert.equal(second.answer, "答-" + first.sessionId);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 启动失败：命令缺失时立即报错且不泄漏子进程错误", async () => {
  const daemon = new AcpDaemon(new MissingCommandAdapter());
  try {
    await assert.rejects(
      () => daemon.runTurn({ prompt: "x", cwd: process.cwd() }),
      /(?:no such|ENOENT|找不到|missing|spawn)/i,
    );
  } finally {
    await daemon.close();
  }
});
