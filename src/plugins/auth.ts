/**
 * auth 认证插件：识别 CLI 认证需求（如 agy 未登录 Google OAuth），通过飞书卡片
 * 引导用户完成授权并粘贴登录 key，提交后调用引擎适配器声明的 login 方法完成登录。
 * 检测与登录执行都走 CliAdapter 的可选协议（isAuthRequired / login），
 * 本插件不写死任何引擎——新增登录能力 = 实现适配器方法，无需改本插件。
 */
import { Service, type Context } from "cordis";
import {
  AuthFlowStore,
  extractLoginUrl,
  isAuthRequiredError,
  type AuthFlow,
} from "../core/cli-auth.js";
import type { CliAdapter } from "../cli/types.js";
import type { Session } from "../core/session-manager.js";
import type { CardAction, CardActionResponse } from "../im/lark.js";
import { AUTH_ACTION_NAME, AUTH_INPUT_NAME } from "../im/card.js";
import type { Bot } from "../im/lark.js";
import type { BotConfig } from "../core/bot-registry.js";
import type { TaskResultPayload } from "./types.js";

/** key 模式单次登录进程的兜底超时；授权码通常只有几分钟有效。 */
const KEY_LOGIN_TIMEOUT_MS = 120_000;
/** device 模式等待浏览器授权的兜底超时（用户授权需要时间）。 */
const DEVICE_LOGIN_TIMEOUT_MS = 5 * 60_000;

/** 把登录失败信息压缩成单行、截断的摘要，避免卡片被日志刷爆。 */
function summarizeLoginFailure(message: string): string {
  const summary = message.replace(/\s+/g, " ").trim();
  return summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
}

/** 提取飞书 API 错误详情（含 response body 的 ErrCode/ErrMsg），便于排查卡片被拒原因。 */
function describeLarkError(error: unknown): string {
  const candidate = error as {
    message?: string;
    response?: { data?: unknown };
  };
  if (candidate.response?.data !== undefined) {
    return `${candidate.message ?? "未知错误"}: ${JSON.stringify(candidate.response.data)}`;
  }
  return (error as Error).message ?? String(error);
}

/** 发起登录卡片所需的上下文；任务失败事件与 /login 命令共用。 */
export interface RequestLoginOptions {
  bot: Bot;
  botConfig: BotConfig;
  session: Session;
  replyToMessageId: string;
  hasThread: boolean;
  senderOpenId: string;
  taskId?: string;
  /** 失败任务的错误摘要，用于提取登录 URL；命令主动发起时缺省。 */
  error?: string;
}

export interface RequestLoginResult {
  ok: boolean;
  message: string;
}

export class AuthService extends Service {
  readonly flows = new AuthFlowStore();

  constructor(ctx: Context) {
    super(ctx, "auth");
  }

  /**
   * 创建登录流程并补发登录卡片。重复发起（同一会话已有待完成流程）、
   * 引擎不支持卡片登录或卡片发送失败时返回失败结果，不抛异常。
   */
  async requestLogin(
    options: RequestLoginOptions,
  ): Promise<RequestLoginResult> {
    const { bot, botConfig, session } = options;
    const runtime = this.ctx.lark.bot(botConfig.id);
    if (!runtime) {
      return { ok: false, message: "机器人已离线，请稍后再试。" };
    }
    const adapter = this.ctx.cli.get(
      session.cliId,
      session.accessMode ?? "headless",
    );
    if (!adapter.login) {
      return {
        ok: false,
        message: `${adapter.displayName} 暂不支持卡片登录。`,
      };
    }
    if (this.flows.findForSession(session.id, botConfig.id)) {
      return {
        ok: false,
        message: "当前会话已经有一张待完成的登录卡片，请直接填写后确认。",
      };
    }

    const flow = this.flows.create({
      botId: botConfig.id,
      engineId: session.cliId,
      engineDisplayName: adapter.displayName,
      accessMode: session.accessMode ?? "headless",
      sessionId: session.id,
      taskId: options.taskId,
      ownerOpenId: options.senderOpenId,
      originalMessageId: options.replyToMessageId,
      replyInThread: options.hasThread,
      workspaceDir: session.workspaceDir,
      loginUrl: options.error ? extractLoginUrl(options.error) : undefined,
      errorMessage: options.error ?? "",
      loginMode: adapter.loginMode ?? "key",
    });
    try {
      const cardMessageId = await bot.replyCard(
        options.replyToMessageId,
        this.ctx.cards.authLogin(flow),
        options.hasThread,
      );
      if (!cardMessageId) {
        console.error("[auth] 登录卡片响应里没有 message_id，无法继续更新");
        this.flows.delete(flow.token);
        return { ok: false, message: "登录卡片发送失败，请稍后重试。" };
      }
      flow.cardMessageId = cardMessageId;
      console.log(
        `[auth] 检测到 ${adapter.id} 需要登录，已发送登录卡片 message_id=${cardMessageId}`,
      );
      return { ok: true, message: "" };
    } catch (error) {
      console.error("[auth] 登录卡片发送失败:", (error as Error).message);
      this.flows.delete(flow.token);
      return { ok: false, message: "登录卡片发送失败，请稍后重试。" };
    }
  }

  /**
   * 监听任务失败：错误文本命中认证需求时，向失败任务的话题补发登录卡片。
   * 同一会话已有待完成的登录流程时不重复发卡（失败重试不会刷屏）。
   */
  async handleTaskFailed(payload: TaskResultPayload): Promise<void> {
    if (payload.origin === "background" || !payload.error) return;
    const { botId } = payload.session;
    const adapter = this.ctx.cli.get(
      payload.session.cliId,
      payload.session.accessMode ?? "headless",
    );
    if (!isAuthRequiredError(payload.error, adapter)) return;
    await this.requestLogin({
      bot: payload.bot,
      botConfig: payload.botConfig,
      session: payload.session,
      replyToMessageId: payload.replyToMessageId,
      hasThread: payload.hasThread,
      senderOpenId: payload.senderOpenId ?? "",
      taskId: payload.taskId,
      error: payload.error,
    });
  }

  /**
   * 处理登录卡片的「确认并登录」动作：校验流程与发起人，调用引擎 login 完成登录，
   * 用卡片状态流转反馈结果。登录只在内存流程上执行，重启后旧卡片自然失效。
   */
  async handleCardAction(
    action: CardAction,
    botId: string,
  ): Promise<CardActionResponse | undefined> {
    if (action.value.action !== AUTH_ACTION_NAME) return undefined;
    const token =
      typeof action.value.authToken === "string" ? action.value.authToken : "";
    const flow = this.flows.get(token);
    console.log(
      `[auth] 收到登录卡片动作 token=${token ? `${token.slice(0, 8)}…` : "(空)"} messageId=${action.messageId} flow=${flow ? "命中" : "无"}`,
    );
    if (
      !flow ||
      flow.botId !== botId ||
      (flow.cardMessageId && flow.cardMessageId !== action.messageId)
    ) {
      console.warn(
        `[auth] 登录卡片失效：${!flow ? "流程不存在" : flow.botId !== botId ? "bot 不匹配" : `messageId 不匹配 flow=${flow.cardMessageId}`}`,
      );
      return { toast: { type: "error", content: "这张登录卡片已经失效。" } };
    }
    if (flow.status === "submitting") {
      // key 模式两步流程：登录进程已就绪（等待授权码），本次点击提交授权码。
      if (flow.loginMode === "key" && flow.pendingCode) {
        const key =
          typeof action.formValue?.[AUTH_INPUT_NAME] === "string"
            ? action.formValue[AUTH_INPUT_NAME].trim()
            : "";
        if (!key) {
          return { toast: { type: "warning", content: "请先粘贴授权码。" } };
        }
        const resolve = flow.pendingCode;
        flow.pendingCode = undefined;
        resolve(key);
        console.log("[auth] 已收到授权码并注入登录进程（等待完成登录）");
        return { toast: { type: "success", content: "已提交授权码，正在完成登录…" } };
      }
      return { toast: { type: "warning", content: "正在登录，请不要重复提交。" } };
    }
    if (
      flow.ownerOpenId &&
      action.operatorOpenId !== flow.ownerOpenId
    ) {
      console.warn(
        `[auth] 权限拒绝：operator=${action.operatorOpenId} owner=${flow.ownerOpenId}`,
      );
      return { toast: { type: "warning", content: "只有任务发起人可以提交登录 key。" } };
    }

    flow.status = "submitting";
    const adapter = this.ctx.cli.get(flow.engineId, flow.accessMode);
    if (!adapter.login) {
      flow.status = "awaiting-key";
      return {
        toast: { type: "error", content: `${flow.engineDisplayName} 暂不支持卡片登录。` },
        card: {
          type: "raw",
          data: this.ctx.cards.authLogin(flow, "该引擎暂不支持卡片登录。"),
        },
      };
    }

    // 更新为进行中状态，防止用户重复提交。
    try {
      await this.ctx.lark.bot(botId)?.bot.updateCard(
        action.messageId,
        this.ctx.cards.authSubmitting(flow),
      );
    } catch (error) {
      console.error("[auth] 提交中卡片更新失败:", (error as Error).message);
    }

    // 登录在后台执行：飞书卡片回调必须在数秒内响应，绝不能 await 引擎登录
    // （agy 注入 / dim 设备码等待可能长达几分钟），否则飞书报“目标服务超时”。
    // 登录全程通过 updateCard 流转卡片状态，这里立即返回 toast 给用户。
    void this.runLoginInBackground(flow, adapter, action.messageId, botId);

    return {
      toast: {
        type: "success",
        content:
          flow.loginMode === "device"
            ? "已开始登录，请按卡片提示在浏览器完成授权。"
            : "已开始登录，请按卡片提示打开授权链接并粘贴授权码。",
      },
    };
  }

  /**
   * 后台执行一次登录：登录进程启动后把授权 URL 经 onOutput 实时推回卡片——
   * key 模式展示授权输入卡（URL+输入框+确认），用户提交授权码后经 getCode 延迟注入；
   * device 模式展示授权等待卡，浏览器授权后进程自动完成。结束后用成功/失败卡片收尾。
   */
  private async runLoginInBackground(
    flow: AuthFlow,
    adapter: CliAdapter,
    messageId: string,
    botId: string,
  ): Promise<void> {
    let outputBuffer = "";
    let lastShownUrl = "";
    let lastShownCode = "";
    const showUrlCard = async (url: string, code?: string) => {
      if (url === lastShownUrl && (code ?? "") === lastShownCode) return;
      lastShownUrl = url;
      lastShownCode = code ?? "";
      try {
        if (flow.loginMode === "device") {
          await this.ctx.lark.bot(botId)?.bot.updateCard(
            messageId,
            this.ctx.cards.authDeviceWaiting(flow, url, code),
          );
        } else {
          // key 模式：卡片更新接口（PATCH）不允许在无 form 的卡片上新增 form
          // （飞书返回 400），授权输入卡必须作为新消息发出；随后把 flow 绑定到
          // 新卡，用户在新卡上的确认动作和成功/失败更新都以新卡为准。
          const cardId = await this.ctx.lark.bot(botId)?.bot.replyCard(
            flow.originalMessageId,
            this.ctx.cards.authCode(flow, url),
            flow.replyInThread,
          );
          if (cardId) flow.cardMessageId = cardId;
        }
      } catch (error) {
        console.error(
          "[auth] 授权等待卡片发送失败:",
          describeLarkError(error),
        );
      }
    };
    const onOutput = (chunk: string) => {
      outputBuffer += chunk;
      if (flow.loginMode === "device") {
        const url =
          /Complete URL:\s*(\S+)/.exec(outputBuffer)?.[1] ??
          /Open this URL:\s*(\S+)/.exec(outputBuffer)?.[1];
        const code = /Enter code:\s*(\S+)/.exec(outputBuffer)?.[1];
        if (url) void showUrlCard(url, code);
      } else {
        // key 模式：提取登录进程打印的授权 URL（PKCE 与进程绑定）。
        const url = /https?:\/\/[^\s]+/.exec(outputBuffer)?.[0];
        if (url) {
          console.log(`[auth] 已从登录进程解析授权 URL，展示授权输入卡`);
          void showUrlCard(url);
        }
      }
    };

    try {
      if (flow.loginMode === "device") {
        await adapter.login!("", {
          cwd: flow.workspaceDir,
          timeoutMs: DEVICE_LOGIN_TIMEOUT_MS,
          onOutput,
        });
      } else {
        // key 模式：授权码必须来自本进程打印的授权 URL；登录进程打印提示后挂起，
        // 等用户在授权输入卡提交授权码时 resolve，再注入同一进程。
        // 解析器必须在 login 启动前就位：用户可能在登录进程打印提示之前就点确认，
        // 若等 getCode 被调用才挂载，那次确认的授权码会静默丢失。
        const codePromise = new Promise<string>((resolve) => {
          flow.pendingCode = resolve;
        });
        await adapter.login!("", {
          cwd: flow.workspaceDir,
          timeoutMs: KEY_LOGIN_TIMEOUT_MS,
          onOutput,
          getCode: () => codePromise,
        });
      }
      this.flows.delete(flow.token);
      flow.pendingCode = undefined;
      try {
        await this.ctx.lark.bot(botId)?.bot.replyCard(
          flow.originalMessageId,
          this.ctx.cards.authSuccess(flow),
          flow.replyInThread,
        );
      } catch (error) {
        console.error("[auth] 成功卡片发送失败:", describeLarkError(error));
      }
      console.log(`[auth] ${flow.engineId} 登录成功（会话 ${flow.sessionId}）`);
    } catch (error) {
      const message = (error as Error).message;
      flow.status = "awaiting-key";
      flow.pendingCode = undefined;
      console.error(`[auth] ${flow.engineId} 登录失败:`, message);
      const failure = summarizeLoginFailure(message);
      try {
        await this.ctx.lark.bot(botId)?.bot.replyCard(
          flow.originalMessageId,
          this.ctx.cards.authLogin(flow, failure),
          flow.replyInThread,
        );
      } catch (updateError) {
        console.error(
          "[auth] 失败卡片发送失败:",
          describeLarkError(updateError),
        );
      }
    }
  }
}

export const name = "auth";
export const inject = ["cli", "lark", "cards"];

export function apply(ctx: Context) {
  const service = new AuthService(ctx);
  ctx.on("task/failed", (payload) => service.handleTaskFailed(payload));
  ctx.on("bot/card-action", (action, _bot, botConfig) =>
    service.handleCardAction(action, botConfig.id),
  );
}
