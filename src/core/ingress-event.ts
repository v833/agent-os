/**
 * Ingress 事件契约与来源适配器：把外部 Webhook（GitHub / Sentry / 通用）的原始
 * payload 规范化为统一的 IngressEvent，供路由引擎与实体话题映射消费。
 *
 * entityId 是外部实体的稳定唯一键（如 github 的 owner/repo/pull/123、sentry 的
 * issue id）；与 source 拼成 entityKey 用于 1:1 话题映射。
 */
import { z } from "zod";

export const IngressEventSchema = z.object({
  /** 来源侧事件唯一 ID（GitHub Delivery ID / Sentry Id / 请求 Nonce），用于幂等。 */
  eventId: z.string().min(1),
  /** 事件来源：github | sentry | generic。 */
  source: z.enum(["github", "sentry", "generic"]),
  /** 来源侧事件类型，如 pull_request.opened / issue_comment.created / alert.triggered。 */
  eventType: z.string().min(1),
  /** 外部实体唯一键，如 owner/repo/pull/123。 */
  entityId: z.string().min(1),
  /** 人类可读标题。 */
  title: z.string().min(1),
  /** 外部实体详情页链接。 */
  detailUrl: z.string().url().optional(),
  /** 结构化元数据：repo、branch、severity 等，供路由规则匹配。 */
  metadata: z.record(z.string(), z.unknown()).default({}),
  /** 原始 payload 全文，供下游上下文维护。 */
  rawPayload: z.unknown(),
  /** 网关接收时间（ISO）。 */
  receivedAt: z.string().datetime(),
});

export type IngressEvent = z.infer<typeof IngressEventSchema>;

/** 来源适配器输出：规范化事件的关键字段（不含事件时间与原始 payload）。 */
export interface NormalizedIngress {
  eventId: string;
  eventType: string;
  entityId: string;
  title: string;
  detailUrl?: string;
  metadata: Record<string, unknown>;
}

/** 把未知来源事件路由到可识别来源时补全来源名；未知来源在网关层直接 404。 */
export type IngressSource = IngressEvent["source"];

/**
 * 按来源规范化 GitHub payload。支持 pull_request / issues / issue_comment /
 * workflow_run 四类对象。事件类型取自 GitHub 的 "action" 字段并带对象名前缀。
 */
export function normalizeGithubPayload(
  payload: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
): NormalizedIngress {
  const eventId =
    firstHeader(headers["x-github-delivery"]) ?? randomId();
  const repository = payload.repository as
    | { full_name?: string; name?: string; html_url?: string }
    | undefined;
  const repoName = repository?.full_name ?? repository?.name ?? "unknown";
  const repoUrl = repository?.html_url;

  const pullRequest = payload.pull_request as
    | { number?: number; title?: string; html_url?: string }
    | undefined;
  const issue = payload.issue as
    | { number?: number; title?: string; html_url?: string; pull_request?: unknown }
    | undefined;
  const comment = payload.comment as
    | { html_url?: string; body?: string }
    | undefined;
  const workflowRun = payload.workflow_run as
    | { id?: number; display_title?: string; html_url?: string; status?: string }
    | undefined;
  const action = typeof payload.action === "string" ? payload.action : "unknown";
  const prNumber = pullRequest?.number;

  if (comment) {
    const number = issue?.number ?? prNumber;
    // issue_comment 事件挂在 Issue 上；pull_request_review_comment（inline 评论）则
    // 顶层同时携带 pull_request 与 comment。因此 comment 分支必须先于 pull_request
    // 判定，否则 review 评论会被误归一化为 pull_request.*；纯 pull_request 事件不
    // 带 comment，此顺序不影响其命中。PR 相关评论实体按 pull 归并保持上下文连续。
    const onPullRequest =
      Boolean(pullRequest) || Boolean(issue?.pull_request);
    return {
      eventId,
      eventType: `issue_comment.${action}`,
      entityId: number
        ? `${repoName}/${onPullRequest ? "pull" : "issues"}/${number}`
        : `${repoName}/issue/comment`,
      title: `评论 #${number ?? "unknown"}：${truncate(comment.body ?? "", 60)}`,
      detailUrl: comment.html_url ?? issue?.html_url,
      metadata: {
        repo: repoName,
        number,
        action,
        isPullRequest: onPullRequest,
        commentBody: comment.body ?? "",
      },
    };
  }
  if (pullRequest) {
    return {
      eventId,
      eventType: `pull_request.${action}`,
      entityId: `${repoName}/pull/${prNumber ?? "unknown"}`,
      title: pullRequest.title ?? `Pull Request #${prNumber ?? "unknown"}`,
      detailUrl: pullRequest.html_url ?? repoUrl,
      metadata: {
        repo: repoName,
        number: prNumber,
        action,
        draft: getBoolean(pullRequest, "draft"),
      },
    };
  }
  if (issue) {
    return {
      eventId,
      eventType: `issues.${action}`,
      entityId: `${repoName}/issues/${issue.number ?? "unknown"}`,
      title: issue.title ?? `Issue #${issue.number ?? "unknown"}`,
      detailUrl: issue.html_url ?? repoUrl,
      metadata: {
        repo: repoName,
        number: issue.number,
        action,
      },
    };
  }
  if (workflowRun) {
    return {
      eventId,
      eventType: `workflow_run.${action}`,
      entityId: `${repoName}/runs/${workflowRun.id ?? "unknown"}`,
      title: workflowRun.display_title ?? `Workflow Run #${workflowRun.id ?? "unknown"}`,
      detailUrl: workflowRun.html_url ?? repoUrl,
      metadata: {
        repo: repoName,
        runId: workflowRun.id,
        status: workflowRun.status,
        action,
      },
    };
  }
  throw new Error(`无法识别的 GitHub payload 对象: ${eventTypeHint(payload)}`);
}

/**
 * 按来源规范化 Sentry webhook payload：兼容 Integration webhook（事件包在 data 下，
 * 触发 action=triggered、解决 action=resolved）与旧式 Issue Alert 结构（event.issue /
 * issue / alert 平铺）。解决型（action/status 指向 resolved）产出 alert.resolved 关闭
 * 事件，否则为 alert.triggered；entityId 使用 issue id，metadata 携带 error 与堆栈。
 */
export function normalizeSentryPayload(
  payload: Record<string, unknown>,
): NormalizedIngress {
  const data = payload.data as
    | { issue?: unknown; event?: unknown; alert?: unknown }
    | undefined;
  const eventRecord = (data?.event ?? payload.event) as
    | {
        issue?: unknown;
        error?: Record<string, unknown>;
        stacktrace?: string;
        timestamp?: string;
      }
    | undefined;
  const issue = (data?.issue ?? eventRecord?.issue ?? payload.issue) as
    | {
        id?: string;
        title?: string;
        short_id?: string;
        permalink?: string;
        status?: string;
      }
    | undefined;
  const alert = (data?.alert ?? payload.alert) as { id?: unknown } | undefined;
  const issueId = issue?.id ?? String(alert?.id ?? "unknown");
  const error = eventRecord?.error as
    | { type?: string; value?: string }
    | undefined;
  const issueStatus =
    (data?.issue as { status?: string } | undefined)?.status ?? issue?.status;
  const resolved =
    payload.action === "resolved" || issueStatus === "resolved";
  return {
    eventId: String(payload.id ?? issueId),
    eventType: resolved ? "alert.resolved" : "alert.triggered",
    entityId: `sentry/${issueId}`,
    title: issue?.title ?? error?.value ?? `Sentry 告警 #${issueId}`,
    detailUrl: issue?.permalink,
    metadata: {
      issueId,
      shortId: issue?.short_id,
      errorType: error?.type,
      errorValue: error?.value,
      stacktrace: eventRecord?.stacktrace,
      eventTimestamp: eventRecord?.timestamp,
      action: payload.action,
      status: issueStatus,
    },
  };
}

/**
 * 通用来源规范化：依赖调用方约定的事件字段。
 * eventId 优先取 headers 的 x-event-id，否则取 payload.eventId。
 */
export function normalizeGenericPayload(
  payload: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  sourceLabel: string,
): NormalizedIngress {
  const eventType =
    typeof payload.eventType === "string"
      ? payload.eventType
      : typeof payload.event_type === "string"
        ? payload.event_type
        : "event";
  const entityId =
    typeof payload.entityId === "string"
      ? payload.entityId
      : typeof payload.entity_id === "string"
        ? payload.entity_id
        : `unknown/${eventType}/${randomId().slice(0, 8)}`;
  const title =
    typeof payload.title === "string"
      ? payload.title
      : `${sourceLabel}.${eventType}`;
  const detailUrl =
    typeof payload.detailUrl === "string" || typeof payload.detailUrl === "object"
      ? stringifyUrl(payload.detailUrl)
      : undefined;
  return {
    eventId:
      firstHeader(headers["x-event-id"]) ??
      (typeof payload.eventId === "string"
        ? payload.eventId
        : randomId()),
    eventType: `${sourceLabel}.${eventType}`,
    entityId,
    title,
    detailUrl,
    metadata: {
      sourceLabel,
      ...pickMetadata(payload),
    },
  };
}

/** 网关层校验入口：按 source 分发到具体规范化函数。 */
export function normalizeIngressPayload(
  source: IngressSource,
  payload: unknown,
  headers: Record<string, string | string[] | undefined>,
): NormalizedIngress {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload 必须是 JSON 对象");
  }
  const record = payload as Record<string, unknown>;
  switch (source) {
    case "github":
      return normalizeGithubPayload(record, headers);
    case "sentry":
      return normalizeSentryPayload(record);
    case "generic":
      return normalizeGenericPayload(record, headers, source);
  }
}

/** 组装完整 IngressEvent；用于测试与网关统一出口。 */
export function buildIngressEvent(
  source: IngressSource,
  payload: unknown,
  headers: Record<string, string | string[] | undefined>,
  receivedAt = new Date().toISOString(),
): IngressEvent {
  const normalized = normalizeIngressPayload(source, payload, headers);
  return IngressEventSchema.parse({
    ...normalized,
    source,
    rawPayload: payload,
    receivedAt,
  });
}

function firstHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getBoolean(object: object, key: string): boolean {
  return (object as Record<string, unknown>)[key] === true;
}

function eventTypeHint(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload);
  return keys.slice(0, 5).join(",") || "<empty>";
}

function truncate(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength
    ? `${singleLine.slice(0, maxLength)}…`
    : singleLine;
}

function stringifyUrl(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  return undefined;
}

/** 提取 payload 中的常用元数据字段，供通用来源路由匹配。 */
function pickMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of ["repo", "branch", "severity", "labels", "status", "source"]) {
    if (payload[key] !== undefined) picked[key] = payload[key];
  }
  return picked;
}
