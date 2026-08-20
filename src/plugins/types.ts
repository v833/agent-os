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
import type { OrchestrationRun } from "../core/orchestration.js";
import type { QAResult } from "../core/qa-result.js";
import type { Session } from "../core/session-manager.js";
import type { CliAdapter, CliRunResult } from "../cli/types.js";
import type { CardJson } from "../im/card.js";
import type { MessageResource } from "../im/message-parser.js";
import type {
  Bot,
  BotIdentity,
  CardAction,
  CardActionResponse,
  IncomingMessage,
} from "../im/lark.js";

import type { ApplicationToolsService } from "./application-tools.js";
import type { CardsService } from "./cards.js";
import type { CliService } from "./cli.js";
import type { CollaborationService } from "./collaboration.js";
import type { CommandsService } from "./commands.js";
import type { ConfigService } from "./config.js";
import type { LarkService } from "./lark.js";
import type { OrchestrationService } from "./orchestration.js";
import type { ScheduleService } from "./schedule.js";
import type { SessionsService } from "./sessions.js";
import type { TasksService } from "./tasks.js";
import type { TeamService } from "./team.js";
import type { WorkspacesService } from "./workspaces.js";
import type { ClarificationService } from "./clarification.js";

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
    /** 应用工具注册表：业务插件登记 MCP Server，执行引擎读取通用描述。 */
    applicationTools: ApplicationToolsService;
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
    /** 多话题并行编排：拆解大任务、派发子任务并汇总结果（移除本插件即下线编排）。 */
    orchestration: OrchestrationService;
    /** 工作区稳定 revision 指纹，供 QA Gate 固定和验证审查版本。 */
    workspaces: WorkspacesService;
    /** 需求澄清：逐题飞书流程、同话题替代与原 CLI 会话续接。 */
    clarification: ClarificationService;
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
    /** 一轮 CLI 成功结束后，应用工具插件可优先认领结果并替换普通成功收尾。 */
    "task/tool-calls"(
      payload: TaskToolCallsPayload,
    ): Promise<TaskToolCallsOutcome | undefined>;
    /** 普通消息启动任务前的可选改写点；澄清插件用它让同话题补充替代旧卡片。 */
    "task/message"(
      payload: TaskMessagePayload,
    ): Promise<TaskMessageOutcome | undefined>;
    /** 一轮任务成功完成；tasks 服务发出，协作插件监听并决定是否继续交接。 */
    "task/result"(payload: TaskResultPayload): void | Promise<void>;
    /**
     * 一轮任务执行失败；tasks 服务在失败收尾时发出。
     * 与 task/result 语义区分（后者只在成功时广播），编排等插件据此标记子任务失败。
     */
    "task/failed"(payload: TaskResultPayload): void | Promise<void>;
    /** QA Gate 已解析、校验并绑定实际 revision 的结构化审查结论。 */
    "qa/result"(payload: QAResultPayload): void | Promise<void>;
    /** 编排运行状态更新广播；orchestration 服务发出，live-panel 插件消费并节流刷新面板卡片。 */
    "orchestration/update"(
      payload: OrchestrationUpdatePayload,
    ): void | Promise<void>;
    /** 编排 run 被淘汰广播；live-panel 插件据此清理挂起卡片与节流引用。 */
    "orchestration/evicted"(
      payload: OrchestrationEvictedPayload,
    ): void | Promise<void>;
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
  senderUnionId?: string;
  /** 同一飞书话题的稳定任务编号；旧的定时/协作入口可以不提供。 */
  taskId?: string;
  requestedPrompt: string;
  /** 应用工具恢复轮次使用；CLI 收到 requestedPrompt，最终结果仍关联最初任务。 */
  originalRequestedPrompt?: string;
  isCompacting: boolean;
  compactInstructions?: string;
  collaboration?: CollaborationMessage;
  senderRuntime?: BotRuntime;
  resources: MessageResource[];
  /** 应用工具恢复任务可禁止普通协作与 QA 自动交接，但仍广播结果供编排汇总。 */
  suppressHandoff?: boolean;
}

/** router 准备启动普通消息时交给可选业务插件的上下文。 */
export interface TaskMessagePayload {
  bot: Bot;
  botConfig: BotConfig;
  message: IncomingMessage;
  taskId: string;
  requestedPrompt: string;
}

/** 可选业务插件对本轮提示词和原始任务归属的改写。 */
export interface TaskMessageOutcome {
  requestedPrompt: string;
  originalRequestedPrompt?: string;
}

/** 应用工具插件认领任务结果后返回的替代终态卡片。 */
export interface TaskToolCallsOutcome {
  card: CardJson;
}

/** 一轮 CLI 的应用工具调用及恢复任务所需上下文。 */
export interface TaskToolCallsPayload extends TaskResultPayload {
  result: CliRunResult;
  runId: string;
  senderOpenId: string;
  senderUnionId?: string;
  /** 当前运行卡片的 message_id，供流程卡片严格绑定回调来源。 */
  cardMessageId: string;
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
  taskId?: string;
  suppressHandoff?: boolean;
}

/** QA Gate 从普通 CLI 文本中解析出的结构化、可路由结论。 */
export interface QAResultPayload extends TaskResultPayload {
  qaResult: QAResult;
}

/** 实时面板挂卡片所需锚点：回复目标与话题参数，由编排服务创建 run 时记录。 */
export interface OrchestrationPanelAnchor {
  bot: Bot;
  replyToMessageId: string;
  hasThread: boolean;
}

/** 编排运行状态更新事件负载：run 快照 + 首次挂卡片锚点。 */
export interface OrchestrationUpdatePayload {
  run: OrchestrationRun;
  /**
   * 挂实时面板卡片的锚点；仅创建 run 后的首次广播携带（编排服务在派发完成后发一次），
   * live-panel 首次收到时 replyCard 挂起卡片，后续更新只携带 run 快照。
   */
  anchor?: OrchestrationPanelAnchor;
}

/** 编排 run 被淘汰事件负载：live-panel 按 runId 清理挂起卡片与节流引用。 */
export interface OrchestrationEvictedPayload {
  runId: string;
}
