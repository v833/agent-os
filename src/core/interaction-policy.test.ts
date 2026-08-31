/** 交互策略测试：验证 direct/team 及显式 /doc 的能力矩阵和旧字段兼容归一化。 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createInteractionPolicy,
  interactionPolicyOf,
  resolveInteractionPolicy,
} from "./interaction-policy.js";

test("direct 普通任务关闭团队与文档能力", () => {
  const policy = resolveInteractionPolicy({ chatType: "p2p" });
  assert.equal(policy.mode, "direct");
  assert.equal(policy.documentRequested, false);
  assert.deepEqual(policy.capabilities, {
    acceptBotMessages: false,
    collaborateWithBots: false,
    runProductWorkflow: false,
    deliverDocument: false,
    suppressHandoff: true,
  });
});

test("direct /doc 只开启文档交付，不开启产品流程", () => {
  const policy = resolveInteractionPolicy(
    { chatType: "p2p" },
    { documentRequested: true },
  );
  assert.equal(policy.mode, "direct");
  assert.equal(policy.documentRequested, true);
  assert.equal(policy.capabilities.deliverDocument, true);
  assert.equal(policy.capabilities.runProductWorkflow, false);
  assert.equal(policy.capabilities.collaborateWithBots, false);
});

test("team 普通任务保留原团队能力，team /doc 不改变协作边界", () => {
  const team = createInteractionPolicy("team");
  const doc = createInteractionPolicy("team", true);
  assert.equal(team.capabilities.acceptBotMessages, true);
  assert.equal(team.capabilities.collaborateWithBots, true);
  assert.equal(team.capabilities.runProductWorkflow, true);
  assert.equal(doc.capabilities.collaborateWithBots, true);
  assert.equal(doc.capabilities.runProductWorkflow, false);
  assert.equal(doc.capabilities.deliverDocument, true);
});

test("缺失策略归一化为 team 默认", () => {
  const policy = interactionPolicyOf({});
  assert.equal(policy.mode, "team");
  assert.equal(policy.documentRequested, false);
  assert.equal(policy.capabilities.acceptBotMessages, true);
});

