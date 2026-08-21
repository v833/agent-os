/**
 * 产品方案完成校验：位于任务成功收尾与产品确认插件之间，确保“方案完成”
 * 一定伴随真实的 request_spec_approval 工具调用，最多允许同一 CLI 会话纠正一次。
 */
import type { CliRunResult } from "../cli/types.js";
import { findProductSpecRequest } from "../core/product-spec.js";

/** 纠正提示固定为内部契约，避免模型只补充文字而没有再次调用提交工具。 */
export const PRODUCT_SPEC_SUBMISSION_CORRECTION_PROMPT = [
  "本轮产品方案没有留下有效的 request_spec_approval 工具调用，因此不能按普通任务完成。",
  "请检查刚刚生成或更新的唯一产品方案产物，立即调用 request_spec_approval 提交最终版本。",
  "调用必须包含最终采用的 deliveryMode，以及该模式要求的全部产物字段；不要只在文字回复中罗列路径或 URL。",
  "提交工具调用完成后停止本轮。",
].join("\n");

export interface ProductSpecSubmissionOptions {
  /** 首次 CLI 结果。 */
  result: CliRunResult;
  /** 没有有效提交时，沿用同一 CLI 会话执行一次纠正。 */
  runCorrection: (prompt: string) => Promise<CliRunResult>;
}

/**
 * 返回可用于后续卡片处理的最终 CLI 结果；第二次仍未提交时抛错，
 * 调用方必须在此异常边界结束成功卡片和成功通知。
 */
export async function ensureProductSpecSubmission(
  options: ProductSpecSubmissionOptions,
): Promise<CliRunResult> {
  if (findProductSpecRequest(options.result.toolCalls)) {
    return options.result;
  }

  const corrected = await options.runCorrection(
    PRODUCT_SPEC_SUBMISSION_CORRECTION_PROMPT,
  );
  if (!findProductSpecRequest(corrected.toolCalls)) {
    throw new Error(
      "产品方案完成后未调用 request_spec_approval，已纠正一次仍未提交。",
    );
  }
  return corrected;
}
