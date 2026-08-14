/**
 * sessions 服务插件：把 SessionManager 与 JsonSessionStore 挂到 ctx.sessions，
 * 并在启动时恢复持久化会话。lark 注入它，保证“先恢复会话再连飞书”的顺序。
 */
import { Service, type Context } from "cordis";
import { resolve } from "node:path";
import { JsonSessionStore } from "../core/session-store.js";
import { SessionManager } from "../core/session-manager.js";

/** 提供会话模型统一入口；manager 在 apply 阶段初始化完毕。 */
export class SessionsService extends Service {
  private _manager: SessionManager | undefined;

  constructor(ctx: Context) {
    super(ctx, "sessions");
  }

  init(manager: SessionManager): void {
    this._manager = manager;
  }

  get manager(): SessionManager {
    if (!this._manager) throw new Error("sessions 服务尚未就绪");
    return this._manager;
  }
}

export const name = "sessions";
export const inject = ["config"];

export interface Config {
  storePath?: string;
}

export async function apply(ctx: Context, config: Config = {}) {
  const service = new SessionsService(ctx);
  const store = new JsonSessionStore(
    resolve(process.cwd(), config.storePath ?? "data/sessions.json"),
    ctx.config.bots[0]?.id ?? "default",
    ctx.config.defaultWorkspaces,
  );
  const manager = await SessionManager.open({ store });
  service.init(manager);
  console.log(`[会话] 已恢复 ${manager.size} 个会话`);
}
