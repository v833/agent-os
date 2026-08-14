/**
 * 通用 ACP 适配器测试：验证标准 ACP 接入的参数构造、展示名回退、
 * 事件/compact 边界与失效会话识别，证明接入不绑定具体供应商。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AcpAdapter } from "./acp-adapter.js";

test("AcpAdapter 用配置构造启动参数与展示名", () => {
  const adapter = new AcpAdapter({
    id: "dimagent",
    command: "dim",
    args: ["acp"],
    displayName: "DimAgent",
  });

  assert.equal(adapter.id, "dimagent");
  assert.equal(adapter.command, "dim");
  assert.equal(adapter.accessMode, "acp");
  assert.deepEqual(adapter.buildArgs("提示词不进启动参数"), ["acp"]);
  assert.deepEqual(adapter.buildResumeArgs("继续", "sess-1"), ["acp"]);
  assert.deepEqual(adapter.parseEvents('{"type":"result"}'), []);
});

test("AcpAdapter 缺省参数与展示名自动回退", () => {
  const adapter = new AcpAdapter({ id: "codex-acp", command: "codex" });

  assert.deepEqual(adapter.buildArgs(""), []);
  assert.equal(adapter.displayName, "codex-acp (ACP)");
});

test("AcpAdapter 明确拒绝原生 compact 并识别失效会话", () => {
  const adapter = new AcpAdapter({ id: "dimagent", command: "dim" });

  assert.throws(() => adapter.buildCompactPlan("sess-1"), /暂不支持/);
  assert.equal(
    adapter.isSessionUnavailable("session does not exist: sess-1"),
    true,
  );
  assert.equal(
    adapter.isSessionUnavailable("ACP server 不支持恢复已有会话"),
    true,
  );
  assert.equal(adapter.isSessionUnavailable("普通错误"), false);
});
