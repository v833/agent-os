/**
 * 原生 compact 执行器测试：用 Node 子进程模拟 Claude stream-json，验证完成、
 * 短会话和取消分支，不依赖本机是否安装真实 CLI。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compactCliSession } from "./native-compact.js";
import type { CliAdapter } from "./types.js";

function fakeClaudeAdapter(script: string): CliAdapter {
  return {
    id: "claude",
    command: process.execPath,
    displayName: "测试 Claude",
    buildArgs: () => [],
    buildResumeArgs: () => [],
    buildCompactPlan: () => ({
      protocol: "claude-stream-json",
      command: process.execPath,
      args: ["-e", script],
    }),
    parseEvents: () => [],
  };
}

function fakeCodexAdapter(script: string): CliAdapter {
  return {
    id: "codex",
    command: process.execPath,
    displayName: "测试 Codex",
    buildArgs: () => [],
    buildResumeArgs: () => [],
    buildCompactPlan: (sessionId) => ({
      protocol: "codex-app-server",
      command: process.execPath,
      args: ["-e", script],
      sessionId,
    }),
    parseEvents: () => [],
  };
}

test("Claude 原生 compact 收到 compact_boundary 后保持会话 ID", async () => {
  const result = await compactCliSession({
    adapter: fakeClaudeAdapter(
      `console.log(JSON.stringify({type:"system",subtype:"compact_boundary"}));`,
    ),
    sessionId: "claude-session",
    cwd: process.cwd(),
  });
  assert.deepEqual(result, {
    sessionId: "claude-session",
    compacted: true,
  });
});

test("Claude 原生 compact 把短会话提示转换为无需整理", async () => {
  const result = await compactCliSession({
    adapter: fakeClaudeAdapter(
      `console.log(JSON.stringify({type:"result",result:"Not enough messages to compact."}));`,
    ),
    sessionId: "claude-session",
    cwd: process.cwd(),
  });
  assert.equal(result.sessionId, "claude-session");
  assert.equal(result.compacted, false);
  assert.match(result.message ?? "", /不需要整理/);
});

test("原生 compact 在开始前已取消时不启动子进程", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    compactCliSession({
      adapter: fakeClaudeAdapter("process.stdout.write('unexpected')"),
      sessionId: "claude-session",
      cwd: process.cwd(),
      signal: controller.signal,
    }),
    /已取消/,
  );
});

test("原生 compact 把 Bot 级环境注入子进程", async () => {
  await assert.rejects(
    compactCliSession({
      adapter: fakeClaudeAdapter(
        `process.stderr.write(process.env.THREADPILOT_TEST_PROXY || "missing"); process.exit(1);`,
      ),
      sessionId: "claude-session",
      cwd: process.cwd(),
      env: { THREADPILOT_TEST_PROXY: "proxy-marker" },
    }),
    /proxy-marker/,
  );
});

test("Codex app-server compact 完成 contextCompaction 事件后返回成功", async () => {
  const script = [
    "const readline=require('node:readline');",
    "const rl=readline.createInterface({input:process.stdin});",
    "rl.on('line', line => {",
    "  const m=JSON.parse(line);",
    "  if(m.id===1) process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');",
    "  if(m.id===2) process.stdout.write(JSON.stringify({id:2,result:{}})+'\\n');",
    "  if(m.id===3) process.stdout.write(JSON.stringify({method:'item/completed',params:{item:{type:'contextCompaction'}}})+'\\n');",
    "});",
  ].join("\n");
  const result = await compactCliSession({
    adapter: fakeCodexAdapter(script),
    sessionId: "codex-thread",
    cwd: process.cwd(),
  });
  assert.deepEqual(result, {
    sessionId: "codex-thread",
    compacted: true,
  });
});
