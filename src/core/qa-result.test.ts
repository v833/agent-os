/**
 * QAResult 契约测试：覆盖三种合法结论、动作语义和阻断缺陷约束，确保模型文本
 * 只有通过结构校验后才能驱动 QA Gate 状态机。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseQAResult } from "./qa-result.js";

function answer(
  verdict: "pass" | "changes_requested" | "blocked",
  nextAction: "close" | "return_to_developer" | "escalate",
  severity?: "P0" | "P1" | "P2" | "P3",
): string {
  return JSON.stringify({
    verdict,
    revision: "git:abc:fingerprint",
    tests: [{ command: "pnpm test", status: "passed", exitCode: 0 }],
    findings: severity
      ? [{
          id: "QA-001",
          severity,
          location: "src/a.ts:1",
          reproduction: "运行测试",
          expected: "通过",
          actual: "失败",
          recommendation: "修复断言",
        }]
      : [],
    nextAction,
  });
}

test("QAResult 接受三种语义一致的审查结论", () => {
  assert.equal(parseQAResult(answer("pass", "close")).verdict, "pass");
  assert.equal(
    parseQAResult(
      answer("changes_requested", "return_to_developer", "P1"),
    ).verdict,
    "changes_requested",
  );
  assert.equal(
    parseQAResult(answer("blocked", "escalate", "P2")).verdict,
    "blocked",
  );
});

test("QAResult 拒绝动作不一致和没有阻断缺陷的 changes_requested", () => {
  assert.throws(
    () => parseQAResult(answer("pass", "return_to_developer")),
    /nextAction=close/,
  );
  assert.throws(
    () =>
      parseQAResult(
        answer("changes_requested", "return_to_developer", "P2"),
      ),
    /P0\/P1/,
  );
});

test("QAResult 拒绝带失败测试或阻断缺陷的 pass", () => {
  const failedTest = JSON.parse(answer("pass", "close"));
  failedTest.tests[0] = { command: "pnpm test", status: "failed", exitCode: 1 };
  assert.throws(
    () => parseQAResult(JSON.stringify(failedTest)),
    /所有测试均为 passed/,
  );

  assert.throws(
    () => parseQAResult(answer("pass", "close", "P1")),
    /不能包含 P0\/P1/,
  );
});
