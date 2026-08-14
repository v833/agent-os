/** CLI 注册表测试：确保入口只能从统一注册点选择引擎，并校验默认配置。 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  getCliAdapter,
  listCliAdapters,
  parseCliId,
  resolveCliWorkdir,
} from "./registry.js";

test("注册表按 ID 和接入模式返回执行适配器", () => {
  assert.equal(getCliAdapter("claude").displayName, "Claude Code");
  assert.equal(getCliAdapter("codex").displayName, "Codex");
  assert.equal(getCliAdapter("dimagent").accessMode, "headless");
  assert.equal(getCliAdapter("dimagent", "acp").accessMode, "acp");
  assert.throws(() => getCliAdapter("codex", "acp"), /不支持 ACP/);
  assert.deepEqual(
    listCliAdapters().map((adapter) => adapter.id),
    ["claude", "codex", "dimagent"],
  );
});

test("默认执行引擎为 Codex，并拒绝未知 DEFAULT_CLI", () => {
  assert.equal(parseCliId(undefined), "codex");
  assert.equal(parseCliId(""), "codex");
  assert.equal(parseCliId("claude"), "claude");
  assert.equal(parseCliId("codex"), "codex");
  assert.equal(parseCliId("dimagent"), "dimagent");
  assert.throws(
    () => parseCliId("other"),
    /DEFAULT_CLI.*claude.*codex.*dimagent/,
  );
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
