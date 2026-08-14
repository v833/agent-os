/** CLI 注册表测试：确保入口只能从统一注册点选择引擎。 */
import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { DimagentAdapter } from "./dimagent-adapter.js";
import { AcpAdapter } from "./acp-adapter.js";
import {
  getCliAdapter,
  listCliAdapters,
  registerCliAdapter,
} from "./registry.js";

test("注册表按 ID 和接入模式返回执行适配器", () => {
  // 引擎插件通过 registerCliAdapter 登记；测试先登记全部内置引擎。
  registerCliAdapter(new ClaudeAdapter());
  registerCliAdapter(new CodexAdapter());
  registerCliAdapter(new DimagentAdapter());
  registerCliAdapter(
    new AcpAdapter({
      id: "dimagent",
      command: "dim",
      args: ["acp"],
      displayName: "DimAgent",
    }),
  );
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
