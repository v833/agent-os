/**
 * QA 审查结论契约：校验 QA 输出的结构、revision 与下一步动作，供协作插件
 * 在 task/result 边界做可靠路由。它位于 CLI 文本结果与协作状态机之间，避免
 * 让模型的自然语言直接决定交付状态。
 */
import { z } from "zod";

const QaTestSchema = z.object({
  command: z.string().trim().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  exitCode: z.number().int(),
});

const QaFindingSchema = z.object({
  id: z.string().trim().min(1),
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  location: z.string().trim().min(1),
  reproduction: z.string().trim().min(1),
  expected: z.string().trim().min(1),
  actual: z.string().trim().min(1),
  recommendation: z.string().trim().min(1),
});

export const QAResultSchema = z.object({
  verdict: z.enum(["pass", "changes_requested", "blocked"]),
  revision: z.string().trim().min(1),
  tests: z.array(QaTestSchema),
  findings: z.array(QaFindingSchema),
  nextAction: z.enum(["close", "return_to_developer", "escalate"]),
});

export type QAResult = z.infer<typeof QAResultSchema>;

/** 从 QA 的回答中提取 JSON，并拒绝 verdict 与 nextAction 不一致的结论。 */
export function parseQAResult(answer: string): QAResult {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("QAResult 中找不到 JSON 对象");
  }

  const result = QAResultSchema.parse(JSON.parse(answer.slice(start, end + 1)));
  const expectedAction = {
    pass: "close",
    changes_requested: "return_to_developer",
    blocked: "escalate",
  }[result.verdict];
  if (result.nextAction !== expectedAction) {
    throw new Error(
      `QAResult 的 verdict=${result.verdict} 必须使用 nextAction=${expectedAction}`,
    );
  }
  if (result.verdict !== "pass" && result.findings.length === 0) {
    throw new Error(`QAResult 的 verdict=${result.verdict} 必须包含 findings`);
  }
  for (const test of result.tests) {
    if (test.status === "passed" && test.exitCode !== 0) {
      throw new Error("QAResult 中 passed 测试的 exitCode 必须为 0");
    }
    if (test.status === "failed" && test.exitCode === 0) {
      throw new Error("QAResult 中 failed 测试的 exitCode 不能为 0");
    }
  }
  if (result.verdict === "pass" && result.tests.length === 0) {
    throw new Error("QAResult 的 pass 结论必须包含至少一项已执行测试");
  }
  if (
    result.verdict === "pass" &&
    result.tests.some((test) => test.status !== "passed")
  ) {
    throw new Error("QAResult 的 pass 结论要求所有测试均为 passed");
  }
  if (
    result.verdict === "pass" &&
    result.findings.some((finding) =>
      finding.severity === "P0" || finding.severity === "P1"
    )
  ) {
    throw new Error("QAResult 的 pass 结论不能包含 P0/P1 finding");
  }
  if (
    result.verdict === "changes_requested" &&
    !result.findings.some((finding) =>
      finding.severity === "P0" || finding.severity === "P1"
    )
  ) {
    throw new Error("QAResult 的 changes_requested 必须包含至少一个 P0/P1 finding");
  }
  return result;
}
