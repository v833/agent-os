/**
 * egress 插件：全双工异步回调闭环。监听任务生命周期事件（task/started、
 * task/result、task/failed、qa/result），借助 ingress 插件维护的实体→话题映射，
 * 把执行进展与 QA 结论回传外部：
 * - GitHub 实体 → 在 PR/Issue 评论就地更新（稳定 tag 幂等）。
 * - 配置了回调 URL → POST 通用 Webhook（指数退避重试）。
 * 未命中实体映射或未配置通道时静默跳过，不影响主流程。
 */
import type { Context } from "cordis";
import { z } from "zod";
import {
  GitHubCommentClient,
  buildEgressPayload,
  postEgressWebhook,
  qaResultToMarkdown,
  type EgressStatus,
} from "../core/egress.js";
import type { QAResultPayload, TaskResultPayload, TaskStartedPayload } from "./types.js";

export const EgressConfigSchema = z.object({
  github: z
    .object({
      token: z.string().optional(),
      apiBase: z.string().optional(),
    })
    .optional(),
  webhook: z
    .object({
      url: z.string().url().optional(),
      token: z.string().optional(),
    })
    .optional(),
});
export type EgressConfig = z.infer<typeof EgressConfigSchema>;

export const name = "egress";
export const inject = ["ingress"];

export async function apply(ctx: Context, config: EgressConfig = {}) {
  const parsed = EgressConfigSchema.parse(config);
  const github = parsed.github?.token
    ? new GitHubCommentClient({
        token: parsed.github.token,
        apiBase: parsed.github.apiBase,
      })
    : undefined;

  // GitHub 实体键约定为 owner/repo/pull/123 或 owner/repo/issues/456。
  ctx.on("task/started", async (payload) => {
    const status: EgressStatus = "Started";
    await report({
      payload,
      status,
      detail: truncate(payload.requestedPrompt ?? "", 200),
    });
  });

  ctx.on("task/result", async (payload) => {
    await report({
      payload,
      status: "Completed",
      detail: truncate(payload.answer, 300),
    });
  });

  ctx.on("task/failed", async (payload) => {
    await report({
      payload,
      status: "Failed",
      detail: truncate(payload.error ?? "任务执行失败", 300),
    });
  });

  ctx.on("qa/result", async (payload) => {
    const status: EgressStatus =
      payload.qaResult.verdict === "pass" ? "QA_Passed" : "Failed";
    await report({
      payload,
      status,
      detail: qaResultToMarkdown(payload.qaResult),
    });
  });

  async function report(options: {
    payload: TaskStartedPayload | TaskResultPayload | QAResultPayload;
    status: EgressStatus;
    detail: string;
  }): Promise<void> {
    const session = options.payload.session;
    const topic = ctx.ingress.store.findByThread(session.chatId, session.threadId);
    if (!topic) return;

    const egressPayload = buildEgressPayload(
      options.status,
      {
        entityId: topic.entityId,
        title: topic.lastSummary || topic.entityId,
        detailUrl: undefined,
      },
      options.detail,
    );

    // GitHub 评论通道（优先）：source 为 github 且已配置 token。
    if (github && topic.source === "github") {
      const ref = parseGithubRef(topic.entityId);
      if (ref) {
        try {
          const result = await github.postOrUpdateComment(
            ref,
            options.detail,
            topic.entityKey,
          );
          console.log(
            `[egress] GitHub 回传 ${options.status} ${ref.owner}/${ref.repo}#${ref.number} updated=${result.updated}`,
          );
        } catch (error) {
          console.error(
            `[egress] GitHub 回传失败 ${options.status}: ${(error as Error).message}`,
          );
        }
      }
      return;
    }

    // 通用 Webhook 通道。
    if (parsed.webhook?.url) {
      try {
        const outcome = await postEgressWebhook(
          { url: parsed.webhook.url, token: parsed.webhook.token },
          egressPayload,
        );
        console.log(
          `[egress] Webhook 回传 ${options.status} delivered=${outcome.delivered} attempts=${outcome.attempts}`,
        );
      } catch (error) {
        console.error(
          `[egress] Webhook 回传失败 ${options.status}: ${(error as Error).message}`,
        );
      }
    }
  }
}

/** 解析 GitHub 实体键为 owner/repo/number；无法解析返回 undefined。 */
export function parseGithubRef(entityId: string): {
  owner: string;
  repo: string;
  number: number;
} | undefined {
  const match = entityId.match(/^([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)$/);
  if (!match) return undefined;
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]),
  };
}

function truncate(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength
    ? `${singleLine.slice(0, maxLength)}…`
    : singleLine;
}
