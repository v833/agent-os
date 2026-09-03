/**
 * Ingress Webhook 网关：对外暴露统一入口 POST /api/v1/ingress/webhook/:source，
 * 完成验签（HMAC / Bearer）、时间戳漂移、Nonce 防重放与 payload 规范化，
 * 解析成功立即返回 200 + eventId（业务处理异步进行），失败按原因返回 401/403/400。
 *
 * 遵循 schedule-api 模式：node:http 常驻服务、可注入处理器、返回关闭函数。
 * 处理器由 ingress 插件提供，网关不直接依赖具体业务实现。
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  verifyIngressRequest,
  type IngressVerificationFailure,
} from "./ingress-security.js";
import {
  buildIngressEvent,
  type IngressEvent,
  type IngressSource,
} from "./ingress-event.js";

const MAX_BODY_BYTES = 256 * 1024;

/** 单来源验签配置：secret 与 Bearer Token 二选一（generic 可都配，token 优先）。 */
export interface IngressSourceAuth {
  secret?: string;
  expectedToken?: string;
}

/** 网关鉴权配置：按来源命名空间的密钥映射。 */
export interface IngressAuthConfig {
  github?: IngressSourceAuth;
  sentry?: IngressSourceAuth;
  generic?: IngressSourceAuth;
}

export interface IngressGatewayOptions {
  auth: IngressAuthConfig;
  port: number;
  /** 监听地址；缺省 0.0.0.0（供 GitHub/Sentry 等外部来源回调）。 */
  host?: string;
  /** 处理器：规范化后的 IngressEvent 交业务插件调度；返回值未用，仅保证完成。 */
  handleEvent: (event: IngressEvent) => void | Promise<void>;
  /** 审计日志；缺省打印到 console。 */
  log?: (line: string) => void;
  /** 测试注入时钟（毫秒）。 */
  now?: number;
}

export interface IngressGateway {
  close: () => void;
  port: number;
}

export function startIngressGateway(
  options: IngressGatewayOptions,
): IngressGateway {
  const { auth, port, handleEvent, now } = options;
  const host = options.host ?? "0.0.0.0";
  const log = options.log ?? ((line: string) => console.log(line));
  const seenNonces = new Set<string>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const segments = url.pathname.split("/").filter(Boolean);

      if (method === "GET" && segments[0] === "health") {
        return sendJson(res, 200, { ok: true });
      }
      if (
        method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "v1" &&
        segments[2] === "ingress" &&
        segments[3] === "webhook" &&
        segments[4]
      ) {
        return handleWebhook(req, res, segments[4] as IngressSource);
      }
      return sendJson(res, 404, { error: "接口不存在" });
    } catch (error) {
      log(`[ingress] 网关错误: ${(error as Error).message}`);
      return sendJson(res, 500, { error: "网关内部错误" });
    }
  });

  const gateway: IngressGateway = {
    close: () => {
      server.close();
      if (typeof (server as any).closeAllConnections === "function") {
        (server as any).closeAllConnections();
      }
    },
    port: 0,
  };
  server.unref();
  server.listen(port, host, () => {
    const address = server.address() as { port: number } | null;
    if (address) gateway.port = address.port;
    log(`[ingress] Webhook 网关已启动 http://${host}:${gateway.port}/api/v1/ingress/webhook/:source`);
  });

  return gateway;

  async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    source: IngressSource,
  ): Promise<void> {
    const sourceAuth = auth[source];
    if (!sourceAuth) {
      return sendJson(res, 404, { error: `未注册的 Webhook 来源: ${source}` });
    }

    const rawBody = await readBody(req);
    const headers = req.headers;

    // 按来源官方投递头取幂等/时序/签名：GitHub（x-hub-signature-256、x-github-delivery）、
    // Sentry Integration（sentry-hook-signature、request-id、sentry-hook-timestamp）、
    // 通用（authorization、x-nonce）。时间戳头缺省回落到 HTTP Date 头。
    const nonce =
      firstHeader(headers["x-github-delivery"]) ??
      firstHeader(headers["request-id"]) ??
      firstHeader(headers["x-nonce"]) ??
      "";
    const timestamp =
      firstHeader(headers["x-timestamp"]) ??
      firstHeader(headers["sentry-hook-timestamp"]) ??
      firstHeader(headers["date"]);
    const signature =
      firstHeader(headers["x-hub-signature-256"]) ??
      firstHeader(headers["sentry-hook-signature"]) ??
      firstHeader(headers["authorization"]);

    const verification = verifyIngressRequest(
      source,
      {
        nonce,
        timestamp,
        signature,
        expectedToken: sourceAuth.expectedToken,
        secret: sourceAuth.secret,
        rawBody,
        now,
      },
      seenNonces,
    );

    if (!verification.ok) {
      const failure: IngressVerificationFailure = verification.failure!;
      log(`[ingress] 验签失败 source=${source} nonce=${nonce} reason=${failure}`);
      // 重放与签名失败统一 401/403：签名不匹配 401，重放与漂移 403。
      const status =
        failure === "signature-mismatch" ||
        failure === "missing-secret" ||
        failure === "missing-signature"
          ? 401
          : 403;
      return sendJson(res, status, {
        error: "请求校验失败",
        reason: failure,
      });
    }

    let event: IngressEvent;
    try {
      event = buildIngressEvent(source, JSON.parse(rawBody), headers, new Date(now ?? Date.now()).toISOString());
    } catch (error) {
      log(`[ingress] payload 解析失败 source=${source} error=${(error as Error).message}`);
      return sendJson(res, 400, { error: "payload 无法识别" });
    }

    // 解析成功立即回执，业务处理异步进行，避免 Webhook 等待长任务。
    sendJson(res, 200, { ok: true, eventId: event.eventId });
    log(`[ingress] 已接收 source=${source} event=${event.eventType} entity=${event.entityId} id=${event.eventId}`);
    await Promise.resolve(handleEvent(event)).catch((error) => {
      log(`[ingress] 事件处理失败 id=${event.eventId} error=${(error as Error).message}`);
    });
  }
}

function firstHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
