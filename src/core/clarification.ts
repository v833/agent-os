/**
 * 澄清请求数据结构：约束 Agent 结构化提问的稳定契约。
 * 既是 MCP 工具的参数 Schema，也是后续飞书卡片的输入，全链路只定义一次。
 */
import { z } from "zod";

/** clarification 插件注册到应用工具服务的稳定工具名。 */
export const CLARIFICATION_TOOL_NAME = "request_clarification";

const OptionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().trim().min(1).max(100),
});

const QuestionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    prompt: z.string().trim().min(1).max(300),
    options: z.array(OptionSchema).min(2).max(4),
    recommendedOptionId: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .optional(),
  })
  .superRefine((question, ctx) => {
    const optionIds = question.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "同一道问题的选项 ID 不能重复",
        path: ["options"],
      });
    }
    if (
      question.recommendedOptionId &&
      !optionIds.includes(question.recommendedOptionId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "推荐项必须指向当前问题中的选项",
        path: ["recommendedOptionId"],
      });
    }
  });

/** 一次澄清请求的完整结构：标题 + 最多 5 道问题，每题 2～4 个选项。 */
export const ClarificationRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(80).default("需求澄清"),
    intro: z.string().trim().max(300).optional().default(""),
    questions: z.array(QuestionSchema).min(1).max(5),
  })
  .superRefine((request, ctx) => {
    const questionIds = request.questions.map((question) => question.id);
    if (new Set(questionIds).size !== questionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "同一份澄清请求的问题 ID 不能重复",
        path: ["questions"],
      });
    }
  });

export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;

/** 从工具调用历史中提取最近一次通过校验的澄清请求；没有则返回 undefined。 */
export function findClarificationRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ClarificationRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== CLARIFICATION_TOOL_NAME) continue;
    const parsed = ClarificationRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
