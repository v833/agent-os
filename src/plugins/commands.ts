/**
 * commands 服务插件：提供斜杠命令注册表。每个斜杠命令是独立插件，
 * 通过 ctx.commands.register(name, handler) 登记，router 收到命令后按名派发。
 */
import { Service, type Context } from "cordis";
import type { CommandHandler } from "./types.js";

/** 斜杠命令注册表：name → 处理函数。 */
export class CommandsService extends Service {
  private readonly handlers = new Map<string, CommandHandler>();

  constructor(ctx: Context) {
    super(ctx, "commands");
  }

  register(name: string, handler: CommandHandler): void {
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  get(name: string): CommandHandler | undefined {
    return this.handlers.get(name);
  }
}

export const name = "commands";

export function apply(ctx: Context) {
  new CommandsService(ctx);
}
