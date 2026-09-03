/**
 * Ingress 安全层：HMAC-SHA256 验签（GitHub X-Hub-Signature-256 / Sentry
 * Sentry-Hook-Signature / 通用 Bearer Token）、时间戳漂移（≤300s）与 Nonce 防重放。
 *
 * 纯函数 + 可注入时钟，便于单元测试；重放防护使用有界内存 LRU，
 * 不做持久化——服务重启后旧 Nonce 自然失效，符合短期防重放语义。
 */
import {
  createHmac,
  createHash,
  timingSafeEqual,
} from "node:crypto";

/** 允许的时间戳时钟漂移上限（秒），PRD 契约固定为 300。 */
export const MAX_TIMESTAMP_DRIFT_SECONDS = 300;

/** 防重放存储上限：超过后淘汰最旧 Nonce，避免内存无限增长。 */
export const MAX_REPLAY_NONCES = 2_000;

/** 各来源验签失败时对外统一使用的审计类型。 */
export type IngressVerificationFailure =
  | "missing-secret"
  | "missing-signature"
  | "signature-mismatch"
  | "timestamp-missing"
  | "timestamp-drift"
  | "nonce-missing"
  | "replay";

export interface VerificationContext {
  /** 来源侧事件唯一 ID / Delivery ID，作为 Nonce 防重放键。 */
  nonce: string;
  /** 请求时间戳（秒或毫秒，自动识别）。 */
  timestamp?: string | number;
  /** 签名原文（X-Hub-Signature-256 完整值，如 "sha256=..."；Sentry 为裸 hex）。 */
  signature?: string;
  /** Bearer Token 模式下的期望令牌（配 generic 来源使用）。 */
  expectedToken?: string;
  /** HMAC 密钥；generic 来源用 Bearer Token 时可不传。 */
  secret?: string;
  /** 请求体原文，参与 HMAC 计算。 */
  rawBody: string;
  /** 当前时钟（毫秒），测试注入用；缺省取真实时间。 */
  now?: number;
}

export interface VerificationResult {
  ok: boolean;
  /** 失败原因；成功时为 undefined。 */
  failure?: IngressVerificationFailure;
}

/**
 * 按来源执行验签 + 时间戳漂移 + 防重放。source 决定签名格式：
 * - github：secret + X-Hub-Signature-256（sha256=<hex>），nonce 取 X-GitHub-Delivery
 * - sentry：secret + Sentry-Hook-Signature（裸 hex），nonce 取 Request-ID，时间戳取
 *   Sentry-Hook-Timestamp（官方 Integration webhook 头名）
 * - generic：expectedToken 相等校验或 secret+签名，nonce 取 X-Nonce
 */
export function verifyIngressRequest(
  source: string,
  ctx: VerificationContext,
  seenNonces: Set<string> = new Set(),
): VerificationResult {
  const clock = ctx.now ?? Date.now();

  // 1. 时间戳漂移校验（必须提供；防重放的时序前提）。
  const timestampResult = verifyTimestamp(ctx.timestamp, clock);
  if (!timestampResult.ok) return timestampResult;

  // 2. 签名校验。
  const signatureResult = verifySignature(source, ctx);
  if (!signatureResult.ok) return signatureResult;

  // 3. Nonce 防重放（幂等键必须非空：缺失/空值直接拒绝，不落入可重放状态）。
  if (!ctx.nonce) {
    return { ok: false, failure: "nonce-missing" };
  }
  if (seenNonces.has(ctx.nonce)) {
    return { ok: false, failure: "replay" };
  }
  if (seenNonces.size >= MAX_REPLAY_NONCES) {
    const oldest = seenNonces.values().next().value as string | undefined;
    if (oldest !== undefined) seenNonces.delete(oldest);
  }
  seenNonces.add(ctx.nonce);
  return { ok: true };
}

/** 校验时间戳漂移：允许 ±300s。支持数字（秒/毫秒自动识别）与 ISO8601/HTTP-date 文本。 */
export function verifyTimestamp(
  timestamp: string | number | undefined,
  nowMs: number,
): VerificationResult {
  if (timestamp === undefined || timestamp === "") {
    return { ok: false, failure: "timestamp-missing" };
  }
  // 数字时间戳（毫秒 13 位自动换算为秒）；非数字文本经 Date.parse 兜底，
  // 兼容 Sentry-Hook-Timestamp 与 HTTP Date 头等真实投递的常见格式。
  const numeric = Number(timestamp);
  let seconds: number;
  if (Number.isFinite(numeric)) {
    seconds = numeric > 1_000_000_000_000 ? Math.floor(numeric / 1_000) : numeric;
  } else {
    const parsedMs = Date.parse(String(timestamp));
    if (!Number.isFinite(parsedMs)) {
      return { ok: false, failure: "timestamp-missing" };
    }
    seconds = parsedMs / 1_000;
  }
  const drift = Math.abs(nowMs / 1_000 - seconds);
  if (drift > MAX_TIMESTAMP_DRIFT_SECONDS) {
    return { ok: false, failure: "timestamp-drift" };
  }
  return { ok: true };
}

/** 按来源校验签名格式与内容。 */
function verifySignature(
  source: string,
  ctx: VerificationContext,
): VerificationResult {
  switch (source) {
    case "github":
      return verifyGithubSignature(ctx);
    case "sentry":
      return verifySentrySignature(ctx);
    case "generic":
      return verifyGenericSignature(ctx);
    default:
      return { ok: false, failure: "missing-secret" };
  }
}

/** GitHub：secret + X-Hub-Signature-256，格式 "sha256=<hex>"。 */
function verifyGithubSignature(
  ctx: VerificationContext,
): VerificationResult {
  if (!ctx.secret) return { ok: false, failure: "missing-secret" };
  if (!ctx.signature) return { ok: false, failure: "missing-signature" };
  const match = ctx.signature.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return { ok: false, failure: "signature-mismatch" };
  const expected = createHmac("sha256", ctx.secret)
    .update(ctx.rawBody, "utf8")
    .digest("hex");
  return constantTimeEqual(expected, match[1]!.toLowerCase())
    ? { ok: true }
    : { ok: false, failure: "signature-mismatch" };
}

/** Sentry：secret + Sentry-Hook-Signature（裸 hex，官方 Integration webhook）。 */
function verifySentrySignature(
  ctx: VerificationContext,
): VerificationResult {
  if (!ctx.secret) return { ok: false, failure: "missing-secret" };
  if (!ctx.signature) return { ok: false, failure: "missing-signature" };
  const match = ctx.signature.match(/^[0-9a-f]{64}$/i);
  if (!match) return { ok: false, failure: "signature-mismatch" };
  const expected = createHmac("sha256", ctx.secret)
    .update(ctx.rawBody, "utf8")
    .digest("hex");
  return constantTimeEqual(expected, match[0].toLowerCase())
    ? { ok: true }
    : { ok: false, failure: "signature-mismatch" };
}

/**
 * 通用来源：二选一。
 * 1) 期望令牌（Authorization: Bearer <token>）相等校验（不要求 secret/签名）；
 * 2) 否则按 secret + 裸 hex 签名校验。
 */
function verifyGenericSignature(
  ctx: VerificationContext,
): VerificationResult {
  if (ctx.expectedToken) {
    const token =
      ctx.signature?.replace(/^bearer\s+/i, "") ?? "";
    return constantTimeEqual(token, ctx.expectedToken)
      ? { ok: true }
      : { ok: false, failure: "signature-mismatch" };
  }
  return verifySentrySignature(ctx);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/** 计算 GitHub 格式签名，供测试与网关自测生成签名。 */
export function signGithubRequest(
  secret: string,
  rawBody: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/** 计算 Sentry 格式签名（裸 hex），供测试生成签名。 */
export function signSentryRequest(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** 计算通用 Token 期望值（sha256 hex），供网关审计与测试使用。 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
