/**
 * Agent OS 插件公共契约：集中声明 Cordis 上的服务与事件，以及路由、命令、
 * 任务、协作之间共享的输入类型。这里是“一切皆为插件”的类型基石——
 * 平台、执行引擎、斜杠命令、任务编排、协作都是挂载在根 Context 上的插件，
 * 通过 ctx.<service> 与类型化事件协作，而不是互相导入具体实现。
 */
import type { Context } from "cordis";

import type { BotConfig } from "../core/bot-registry.js";
import type { CollaborationMessage } from "../core/collaboration.js";
import type { CliRequest, SlashCommand } from "../core/command-parser.js";
import type { Session } from "../core/session-manager.js";
import type { CliAdapter } from "../cli/types.js";
import type { MessageResource } from "../im/message-parser.js";
import type {
  Bot,
  BotIdentity,
  CardAction,
  CardActionResponse,
  IncomingMessage,
} from "../im/lark.js";

import type { CardsService } from "./cards.js";
import type { CliService } from "./cli.js";
import type { CollaborationService } from "./collaboration.js";
import type { CommandsService } from "./commands.js";
import type { ConfigService } from "./config.js";
import type { LarkService } from "./lark.js";
import type { ScheduleService } from "./schedule.js";
import type { SessionsService } from "./sessions.js";
import type { TasksService } from "./tasks.js";
import type { TeamService } from "./team.js";

declare module "cordis" {
  interface Context {
    /** 机器人注册表：加载 config/bots.json 并解析环境变量凭证。 */
    config: ConfigService;
    /** 团队注册表与团队上下文扩展；移除 team 插件即可下线团队能力。 */
    team: TeamService;
    /** 会话模型：把飞书话题映射为稳定会话，约束生命周期。 */
    sessions: SessionsService;
    /** 执行引擎注册表与调度：统一驱动 Codex/Claude/DimAgent。 */
    cli: CliService;
    /** 飞书平台适配：启动多 bot、发送消息与卡片、下载资源。 */
    lark: LarkService;
    /** 卡片渲染：任务卡片、会话卡片、协作卡片的统一出口。 */
    cards: CardsService;
    /** 斜杠命令注册表：每个命令由独立插件登记处理函数。 */
    commands: CommandsService;
    /** bot 间协作：交接单、轮次去重与审查派发。 */
    collaboration: CollaborationService;
    /** 任务编排：一轮 CLI 执行的启动、进度、取消与收尾。 */
    tasks: TasksService;
    /** 定时任务：cron / 自然语言周期到点触发，复用 tasks 流水线。 */
    schedule: ScheduleService;
  }

  interface Events {
    /** 飞书收到新消息；lark 插件发出，router 插件消费并路由。 */
    "bot/message"(message: IncomingMessage, bot: Bot, botConfig: BotConfig): void;
    /** 飞书卡片按钮回调；lark 插件以 serial 分发，返回响应给平台。 */
    "bot/card-action"(
      action: CardAction,
      bot: Bot,
      botConfig: BotConfig,
    ): Promise<CardActionResponse | undefined>;
    /**
     * 任务提示词上下文 provider。没有 team 插件时返回 undefined；
     * team 插件可在插件边界内返回成员名册，不让 tasks 依赖具体团队实现。
     */
    "task/prompt-context"(botConfig: BotConfig): string | undefined;
    /** 一轮任务成功完成；tasks 服务发出，协作插件监听并决定是否继续交接。 */
    "task/result"(payload: TaskResultPayload): void | Promise<void>;
  }
}

/** 一台已启动 bot 的运行时状态：配置、平台句柄与稳定身份；WS 状态由 Bot 提供。 */
export interface BotRuntime {
  config: BotConfig;
  bot: Bot;
  identity: BotIdentity;
}

/** 消息到达时的会话上下文，供命令插件消费。 */
export interface CommandContext {
  ctx: Context;
  bot: Bot;
  botConfig: BotConfig;
  message: IncomingMessage;
  session: Session;
  isNew: boolean;
  hasThread: boolean;
  /** 提及还原后的完整文本。 */
  resolvedText: string;
  cliRequest?: CliRequest;
  command: SlashCommand;
  /** 当前会话选中的执行引擎适配器。 */
  cliAdapter: CliAdapter;
}

/** 命令插件需要实现的处理函数签名。 */
export type CommandHandler = (input: CommandContext) => Promise<void>;

/** 启动一轮任务所需的全部输入，由 router 或 /compact 命令组装。 */
export interface StartTaskInput {
  bot: Bot;
  botConfig: BotConfig;
  session: Session;
  hasThread: boolean;
  replyToMessageId: string;
  senderOpenId: string;
  requestedPrompt: string;
  isCompacting: boolean;
  compactInstructions?: string;
  collaboration?: CollaborationMessage;
  senderRuntime?: BotRuntime;
  resources: MessageResource[];
}

/** 一轮任务成功完成时随 task/result 事件广播给协作插件的信息。 */
export interface TaskResultPayload {
  bot: Bot;
  botConfig: BotConfig;
  session: Session;
  requestedPrompt: string;
  answer: string;
  replyToMessageId: string;
  hasThread: boolean;
  collaboration?: CollaborationMessage;
  senderRuntime?: BotRuntime;
}
