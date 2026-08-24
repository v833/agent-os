/**
 * CLI 认证需求的数据契约：认证错误检测、登录流程状态与登录 URL 提取。
 * auth 插件与引擎适配器共享此核心，避免把认证逻辑写死在平台或任务层。
 */
import { randomUUID } from "node:crypto";
import type { CliAccessMode, CliAdapter, CliId } from "../cli/types.js";

/**
 * 认证需求错误的通用特征；适配器通过 isAuthRequired 声明更精确的判定，
 * auth 插件对未声明该方法的引擎用这里兜底。匹配对象是任务失败的
 * 错误摘要（stderr/退出码），不是用户指令，因此可以安全地按关键词识别。
 */
const AUTH_REQUIRED_PATTERNS: RegExp[] = [
  /authentication\s+required/i,
  /authentication\s+(?:failed|timed\s*out)/i,
  /paste\s+the\s+authorization\s+code/i,
  /please\s+visit\s+the\s+url\s+to\s+log\s+in/i,
  /login\s+(?:required|timeout|timed\s*out)/i,
  /not\s+authenticated/i,
];

/**
 * 判断一段错误文本是否表明执行引擎需要登录。
 * 适配器声明了 isAuthRequired 时完全信任它（引擎协议细节归引擎，避免通用
 * 模式误判）；未声明才用通用特征兜底。
 */
export function isAuthRequiredError(
  message: string,
  adapter?: CliAdapter,
): boolean {
  if (adapter?.isAuthRequired) return adapter.isAuthRequired(message);
  return AUTH_REQUIRED_PATTERNS.some((pattern) => pattern.test(message));
}

/** 从错误文本中提取登录 URL（如 Google OAuth 授权页），供卡片展示。 */
export function extractLoginUrl(message: string): string | undefined {
  const match = /https?:\/\/[^\s)]+/.exec(message);
  return match?.[0];
}

/** 一次登录流程的内存状态；token 只对当前卡片有效，重启后自然失效。 */
export interface AuthFlow {
  token: string;
  botId: string;
  engineId: CliId;
  engineDisplayName: string;
  accessMode: CliAccessMode;
  sessionId: string;
  taskId?: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  originalMessageId: string;
  cardMessageId?: string;
  replyInThread: boolean;
  /** 执行登录进程的工作目录（沿用失败任务的会话工作目录）。 */
  workspaceDir: string;
  loginUrl?: string;
  /** 触发本次登录流程的原始错误文本，失败时在卡片上回显。 */
  errorMessage: string;
  /** 登录交互模式；key=卡片收集授权码，device=启动设备码流程后浏览器授权。 */
  loginMode: "key" | "device";
  status: "awaiting-key" | "submitting";
  /**
   * key 模式两步流程的授权码解析器：登录进程打印授权 URL 后挂起，
   * 用户按该 URL 授权并提交授权码时由 auth 插件调用 resolve。
   */
  pendingCode?: (code: string) => void;
}

export interface CreateAuthFlowOptions {
  botId: string;
  engineId: CliId;
  engineDisplayName: string;
  accessMode: CliAccessMode;
  sessionId: string;
  taskId?: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  originalMessageId: string;
  replyInThread: boolean;
  workspaceDir: string;
  loginUrl?: string;
  errorMessage: string;
  /** 缺省 key 模式（卡片收集授权码）；device 模式见 CliAdapter.loginMode。 */
  loginMode?: "key" | "device";
}

/** 登录流程容器；同一会话只保留一份待完成的流程，避免失败重试刷屏。 */
export class AuthFlowStore {
  private readonly flows = new Map<string, AuthFlow>();

  create(options: CreateAuthFlowOptions): AuthFlow {
    // 同一会话已经有未完成的登录流程时，新流程替换旧的（旧卡片自然失效）。
    for (const [token, flow] of this.flows) {
      if (flow.sessionId === options.sessionId && flow.botId === options.botId) {
        this.flows.delete(token);
      }
    }
    const flow: AuthFlow = {
      token: randomUUID().replaceAll("-", ""),
      status: "awaiting-key",
      loginMode: "key",
      ...options,
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  get(token: string): AuthFlow | undefined {
    return this.flows.get(token);
  }

  findForSession(sessionId: string, botId: string): AuthFlow | undefined {
    for (const flow of this.flows.values()) {
      if (flow.sessionId === sessionId && flow.botId === botId) return flow;
    }
    return undefined;
  }

  delete(token: string): void {
    this.flows.delete(token);
  }
}