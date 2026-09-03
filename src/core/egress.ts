/**
 * Egress 回传核心：向 GitHub PR 评论与外部 Webhook 回传执行进展与 QA 结论。
 * - GitHub 评论幂等更新：评论尾部携带稳定 tag，先列出评论找到同 tag 就地 PATCH。
 * - 通用 Webhook 回调：POST JSON payload，指数退避重试最多 3 次。
 * 全部依赖通过参数注入（fetch），便于单元测试与离线模拟。
 */
import type { QAResult } from "./qa-result.js";

/** PRD 约定的回传状态机。 */
export type EgressStatus =
  | "Started"
  | "InProgress"
  | "QA_Passed"
  | "Completed"
  | "Failed";

export interface EgressGitHubOptions {
  /** GitHub API base，默认 https://api.github.com。 */
  apiBase?: string;
  /** GitHub Personal Access Token（需要 issues:write 权限）。 */
  token: string;
  /** 幂等更新所需的最小评论标识。 */
  tagPrefix?: string;
  /** 测试注入的 fetch；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export interface GitHubIssueRef {
  owner: string;
  repo: string;
  /** PR 或 Issue 编号。 */
  number: number;
}

export interface EgressComment {
  id: number;
  body: string;
}

/** 构建带稳定 tag 的评论正文，更新时按 tag 定位原评论。 */
export function tagComment(body: string, tag: string): string {
  return `${body}\n\n<!-- threadpilot-report-${tag} -->`;
}

/** 从评论正文中识别是否属于给定 tag。 */
export function isTaggedComment(body: string, tag: string): boolean {
  return body.includes(`<!-- threadpilot-report-${tag} -->`);
}

/**
 * GitHub 评论发布客户端：postOrUpdate 实现“有 tag 就地更新、无 tag 新建”的幂等语义。
 */
export class GitHubCommentClient {
  private readonly apiBase: string;
  private readonly token: string;
  private readonly tagPrefix: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EgressGitHubOptions) {
    this.apiBase = options.apiBase ?? "https://api.github.com";
    this.token = options.token;
    this.tagPrefix = options.tagPrefix ?? "threadpilot";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** 在 PR/Issue 上发布或就地更新一条 ThreadPilot 回传评论。 */
  async postOrUpdateComment(
    ref: GitHubIssueRef,
    body: string,
    tag: string,
  ): Promise<{ id: number; updated: boolean }> {
    const fullTag = `${this.tagPrefix}:${tag}`;
    const existing = await this.findTaggedComment(ref, fullTag);
    if (existing) {
      await this.patchComment(ref, existing.id, tagComment(body, fullTag));
      return { id: existing.id, updated: true };
    }
    const created = await this.postComment(ref, tagComment(body, fullTag));
    return { id: created.id, updated: false };
  }

  private async findTaggedComment(
    ref: GitHubIssueRef,
    fullTag: string,
  ): Promise<EgressComment | undefined> {
    const url = `${this.apiBase}/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`;
    const comments = (await this.request("GET", url)) as EgressComment[];
    return comments.find((comment) => isTaggedComment(comment.body, fullTag));
  }

  private async postComment(
    ref: GitHubIssueRef,
    body: string,
  ): Promise<EgressComment> {
    const url = `${this.apiBase}/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`;
    return (await this.request("POST", url, { body })) as EgressComment;
  }

  private async patchComment(
    ref: GitHubIssueRef,
    commentId: number,
    body: string,
  ): Promise<EgressComment> {
    const url = `${this.apiBase}/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`;
    return (await this.request("PATCH", url, { body })) as EgressComment;
  }

  private async request(
    method: string,
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${response.status}: ${text.slice(0, 300)}`);
    }
    return response.json();
  }
}

/** Webhook 回调配置。 */
export interface EgressWebhookOptions {
  url: string;
  /** 可选的期望令牌，作为 X-ThreadPilot-Token 头随请求携带。 */
  token?: string;
  /** 最大重试次数（不含首次），默认 3。 */
  maxRetries?: number;
  /** 测试注入的 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 指数退避基准（毫秒）：第 n 次重试等待 base×2^(n-1)，上限 RETRY_MAX_DELAY_MS。 */
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

function retryDelayMs(retryIndex: number): number {
  return Math.min(
    RETRY_BASE_DELAY_MS * 2 ** (retryIndex - 1),
    RETRY_MAX_DELAY_MS,
  );
}

/** 发送一次 Webhook 回调，失败时按指数退避重试（maxRetries 上限）。 */
export async function postEgressWebhook(
  options: EgressWebhookOptions,
  payload: Record<string, unknown>,
): Promise<{ delivered: boolean; attempts: number }> {
  const maxRetries = options.maxRetries ?? 3;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token) headers["x-threadpilot-token"] = options.token;

  let attempts = 0;
  while (true) {
    attempts += 1;
    let ok = false;
    try {
      const response = await fetchImpl(options.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      ok = response.ok;
    } catch (error) {
      // 网络层失败与非 2xx 响应统一进入下方退避重试。
      void error;
    }
    if (ok) return { delivered: true, attempts };
    if (attempts > maxRetries) {
      return { delivered: false, attempts };
    }
    await sleep(retryDelayMs(attempts));
  }
}

/** 把结构化 QA 结论渲染成 GitHub 评论 Markdown。 */
export function qaResultToMarkdown(qa: QAResult): string {
  const verdictLabel = {
    pass: "✅ QA 通过",
    changes_requested: "🔁 需要修改",
    blocked: "⛔ 阻塞",
  }[qa.verdict];
  const lines = [
    `## ThreadPilot QA 结论：${verdictLabel}`,
    "",
    `**Revision**：\`${qa.revision}\``,
    "",
    "### 测试结果",
    ...qa.tests.map(
      (test) =>
        `- ${test.status === "passed" ? "✅" : test.status === "failed" ? "❌" : "⏭️"} \`${test.command}\` (exit=${test.exitCode})`,
    ),
  ];
  if (qa.findings.length > 0) {
    lines.push("", "### 发现的问题");
    for (const finding of qa.findings) {
      lines.push(
        `- **[${finding.severity}] ${finding.id}** ${finding.location}`,
        `  - 复现：${finding.reproduction}`,
        `  - 期望：${finding.expected}；实际：${finding.actual}`,
        `  - 建议：${finding.recommendation}`,
      );
    }
  }
  return lines.join("\n");
}

/** 组装统一回传 payload（供 GitHub 与 Webhook 共用的结构化摘要）。 */
export function buildEgressPayload(
  status: EgressStatus,
  ref: { entityId: string; title: string; detailUrl?: string },
  detail: string,
): Record<string, unknown> {
  return {
    status,
    entityId: ref.entityId,
    title: ref.title,
    detailUrl: ref.detailUrl,
    detail,
    reportedAt: new Date().toISOString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
