/**
 * agy MCP 配置准备测试：验证工作区配置的创建、合并、幂等更新和坏配置边界。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureAgyMcpConfig } from "./agy-mcp-config.js";

const server = {
  id: "agent_os_clarification",
  command: process.execPath,
  args: ["server.js"],
  tools: ["request_clarification"],
} as const;

test("agy MCP 配置合并工作区已有 Server，并可幂等更新 ThreadPilot Server", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-os-agy-mcp-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, ".agents", "mcp_config.json");
  await mkdir(join(cwd, ".agents"), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        existing: { command: "existing", args: [] },
        agent_os_clarification: { command: "old", args: ["old.js"] },
      },
      metadata: "preserved",
    }),
    "utf8",
  );

  await ensureAgyMcpConfig(cwd, [server]);
  await ensureAgyMcpConfig(cwd, [server]);

  const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
    metadata: string;
  };
  assert.equal(parsed.metadata, "preserved");
  assert.deepEqual(parsed.mcpServers.existing, { command: "existing", args: [] });
  assert.deepEqual(parsed.mcpServers.agent_os_clarification, {
    command: process.execPath,
    args: ["server.js"],
  });
});

test("agy MCP 配置拒绝损坏的 JSON 和非对象 mcpServers", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-os-agy-mcp-invalid-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, ".agents", "mcp_config.json");
  await mkdir(join(cwd, ".agents"), { recursive: true });

  await writeFile(configPath, "{", "utf8");
  await assert.rejects(
    ensureAgyMcpConfig(cwd, [server]),
    /agy MCP 配置格式错误/,
  );

  await writeFile(configPath, JSON.stringify({ mcpServers: [] }), "utf8");
  await assert.rejects(
    ensureAgyMcpConfig(cwd, [server]),
    /mcpServers 必须是对象/,
  );
});

test("没有应用工具时不创建 agy 工作区配置", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-os-agy-mcp-empty-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await ensureAgyMcpConfig(cwd, []);
  await assert.rejects(
    readFile(join(cwd, ".agents", "mcp_config.json")),
    { code: "ENOENT" },
  );
});
