/**
 * ACP Runner 测试：用 Node 子进程模拟标准 stdio server，覆盖初始化、
 * 会话新建/恢复、工具通知、消息分片和用量汇总，不依赖真实 DimAgent 登录。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "./runner.js";
import type { CliAdapter, CliEvent } from "./types.js";

const ACP_SERVER_SCRIPT = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} }
        }
      }
    });
    return;
  }
  if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: "acp-session" } });
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
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "读取 src/index.ts",
        kind: "read",
        status: "in_progress"
      }
    }
  });
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed"
      }
    }
  });
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "usage_update", used: 80, size: 1000 }
    }
  });
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "任务" }
      }
    }
  });
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "完成" }
      }
    }
  });
  send({
    id: message.id,
    result: {
      stopReason: "end_turn",
      usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }
    }
  });
});
`;

class AcpScriptAdapter implements CliAdapter {
  readonly id = "dimagent" as const;
  readonly command = process.execPath;
  readonly displayName = "测试 DimAgent";
  readonly accessMode = "acp" as const;

  buildArgs(): string[] {
    return ["-e", ACP_SERVER_SCRIPT];
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

test("ACP Runner 新建会话并翻译消息、工具和用量事件", async () => {
  const events: CliEvent[] = [];
  const result = await runCli({
    adapter: new AcpScriptAdapter(),
    prompt: "检查项目",
    cwd: process.cwd(),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.answer, "任务完成");
  assert.equal(result.sessionId, "acp-session");
  assert.deepEqual(result.stats, {
    contextUsedTokens: 80,
    contextWindowTokens: 1000,
    totalTokens: 30,
    inputTokens: 20,
    outputTokens: 10,
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["session", "tool_start", "tool_end", "context", "result"],
  );
});

test("ACP Runner 使用 session/resume 续接已有会话", async () => {
  const result = await runCli({
    adapter: new AcpScriptAdapter(),
    prompt: "继续",
    cwd: process.cwd(),
    sessionId: "existing-session",
  });

  assert.equal(result.sessionId, "existing-session");
  assert.equal(result.answer, "任务完成");
});

