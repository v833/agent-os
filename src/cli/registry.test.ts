/** CLI 注册表测试：确保入口只能从统一注册点选择双引擎，并校验默认配置。 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  getCliAdapter,
  listCliAdapters,
  parseCliId,
  resolveCliWorkdir,
} from "./registry.js";

test("注册表按 ID 返回 Claude Code 与 Codex 适配器", () => {
  assert.equal(getCliAdapter("claude").displayName, "Claude Code");
  assert.equal(getCliAdapter("codex").displayName, "Codex");
  assert.deepEqual(
    listCliAdapters().map((adapter) => adapter.id),
    ["claude", "codex"],
  );
});

test("默认执行引擎为 Codex，并拒绝未知 DEFAULT_CLI", () => {
  assert.equal(parseCliId(undefined), "codex");
  assert.equal(parseCliId(""), "codex");
  assert.equal(parseCliId("claude"), "claude");
  assert.equal(parseCliId("codex"), "codex");
  assert.throws(() => parseCliId("other"), /DEFAULT_CLI.*claude.*codex/);
});

test("空 CLI_WORKDIR 继续回退旧工作目录", () => {
  const cwd = join(process.cwd(), "current-project");
  const legacy = join(process.cwd(), "legacy-project");
  const preferred = join(process.cwd(), "preferred-project");

  assert.equal(
    resolveCliWorkdir(
      { CLI_WORKDIR: "  ", CLAUDE_WORKDIR: ` ${legacy} ` },
      cwd,
    ),
    legacy,
  );
  assert.equal(
    resolveCliWorkdir(
      { CLI_WORKDIR: preferred, CLAUDE_WORKDIR: legacy },
      cwd,
    ),
    preferred,
  );
  assert.equal(resolveCliWorkdir({ CLI_WORKDIR: "" }, cwd), cwd);
});
