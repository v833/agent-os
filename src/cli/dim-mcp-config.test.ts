/**
 * DimAgent MCP 配置测试：验证用户/项目 mcp.json 的增量合并、幂等更新和坏配置边界。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  dimagentMcpConfigPath,
  ensureDimagentMcpConfig,
  ensureDimagentProjectMcpConfig,
} from "./dim-mcp-config.js";

const server = {
  id: "agent_os_clarification",
  command: process.execPath,
  args: ["server.js"],
  tools: ["request_clarification"],
} as const;

test("DimAgent MCP 配置保留已有 Server，并可幂等更新 Agent OS Server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-os-dim-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "v2", "mcp.json");
  await mkdir(join(root, "v2"), { recursive: true });
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

  await ensureDimagentMcpConfig([server], configPath);
  await ensureDimagentMcpConfig([server], configPath);

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

test("DimAgent MCP 配置拒绝损坏的 JSON 和非对象 mcpServers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-os-dim-mcp-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "mcp.json");
  await writeFile(configPath, "{", "utf8");
  await assert.rejects(
    ensureDimagentMcpConfig([server], configPath),
    /DimAgent MCP 配置格式错误/,
  );

  await writeFile(configPath, JSON.stringify({ mcpServers: [] }), "utf8");
  await assert.rejects(
    ensureDimagentMcpConfig([server], configPath),
    /mcpServers 必须是对象/,
  );
});

test("没有应用工具时不创建 DimAgent MCP 配置", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-os-dim-mcp-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "mcp.json");
  await ensureDimagentMcpConfig([], configPath);
  await assert.rejects(readFile(configPath), { code: "ENOENT" });
});

test("DimAgent headless 使用当前项目的 .mcp.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-os-dim-project-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(dimagentMcpConfigPath(root), join(root, ".mcp.json"));
  await ensureDimagentProjectMcpConfig(root, [server]);

  const parsed = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.deepEqual(parsed.mcpServers.agent_os_clarification, {
    command: process.execPath,
    args: ["server.js"],
  });
});
