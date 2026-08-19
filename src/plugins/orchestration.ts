/**
 * orchestration 编排服务插件：把一个大任务拆成多个子任务并行派发给不同 bot，
 * 并汇总子任务结果供 /panel 展示。P0 采用 issue 中明确的降级方案“同话题多 bot
 * 并行”：每个子任务构造协作交接单（round=1/maxRounds=1）经 ctx.collaboration
 * 注册，再在当前话题 @ 目标 bot 派发——目标 bot 走现有 router 的协作识别启动
 * 任务；成功/失败分别由 task/result、task/failed 事件驱动子任务状态。
 * 运行表有界：同一 bot 只能承接一个子任务（拆解校验整轮拒绝），
 * 已完成的 run 只保留最近 MAX_RUNS 条，防止无界增长。
 */
import { Service, type Context } from "cordis";
import { randomUUID } from "node:crypto";
import type { BotConfig } from "../core/bot-registry.js";
import type { CollaborationMessage } from "../core/collaboration.js";
import {
  MAX_RUNS,
  nextRunId,
  parseSubTaskSpecs,
  parseSubTaskTaskId,
  subTaskTaskId,
  trimRuns,
  type OrchestrationRun,
  type OrchestrationSubTask,
  type SubTaskSpec,
} from "../core/orchestration.js";
import type { Session } from "../core/session-manager.js";
import type { Bot, IncomingMessage } from "../im/lark.js";
import type { TaskResultPayload } from "./types.js";

/** 编排拆解 CLI 调用的最长等待时间；拆解只需一次规划，不应无限等待。 */
const DECOMPOSE_TIMEOUT_MS = 120_000;

/** 启动一次编排所需的全部输入，由 /orchestrate 命令插件组装。 */
export interface StartOrchestrationOptions {
  bot: Bot;
  botConfig: BotConfig;
  session: Session;
  hasThread: boolean;
  message: IncomingMessage;
  prompt: string;
}

/** 构造让编排 bot 输出结构化子任务清单的提示词；成员 id 来自 bot 注册表。 */
function buildDecomposePrompt(members: string[], task: string): string {
  return [
    "你是任务编排者。请把以下大任务拆解为可并行执行的子任务清单。",
    `可派发的成员：${members.join("、")}`,
    "每个子任务的 bot 字段必须从上述成员中选择；每个成员最多承接一个子任务（同一 bot 不能被分配给多个子任务）；子任务应互不依赖、可并行。",
    "只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
    '{"tasks":[{"id":"t1","prompt":"子任务描述","bot":"成员id"}]}',
    `大任务：${task}`,
  ].join("\n\n");
}

/** 编排服务：维护有界运行表、派发子任务并监听任务事件汇总结果。 */
export class OrchestrationService extends Service {
  /** 运行表：完成一次编排即清理最旧的历史 run，见 trimRuns，避免无界增长。 */
  private readonly runs = new Map<string, OrchestrationRun>();

  constructor(ctx: Context) {
    super(ctx, "orchestration");
  }

  list(): OrchestrationRun[] {
    return [...this.runs.values()];
  }

  /** 启动一次编排（拆解 → 派发 → 汇总），内部异常统一消费。 */
  startOrchestration(options: StartOrchestrationOptions): void {
    void this.runOrchestration(options).catch((error) => {
      console.error("[编排] 失败:", (error as Error).message);
    });
  }

  private async runOrchestration(
    options: StartOrchestrationOptions,
  ): Promise<void> {
    const { bot, botConfig, session, hasThread, message, prompt } = options;

    let specs: SubTaskSpec[];
    try {
      specs = await this.decompose(botConfig, session, prompt);
    } catch (error) {
      await bot.reply(
        message.messageId,
        `拆解失败：${(error as Error).message}\n请调整任务描述后重试。`,
        hasThread,
      );
      return;
    }

    // 只派发给已就绪的 bot；存在未知成员时整轮拒绝，避免静默丢子任务。
    const unknownBots = [...new Set(specs.map((spec) => spec.bot))].filter(
      (botId) => !this.ctx.lark.bot(botId),
    );
    if (unknownBots.length) {
      await bot.reply(
        message.messageId,
        `拆解结果里包含未就绪的成员：${unknownBots.join("、")}。请重新描述任务。`,
        hasThread,
      );
      return;
    }

    // 同一目标 bot 在同一话题同一时刻只能执行一个任务：多个子任务派给同一 bot 时，
    // router 的 busy 检查会拒绝第二个（交接单已消费、任务未启动），造成静默丢子任务。
    // 因此派发前整轮拒绝，提示用户调整拆解而不是等到面板永久 pending。
    const duplicatedBots = [
      ...new Set(
        specs
          .map((spec) => spec.bot)
          .filter((botId, index, all) => all.indexOf(botId) !== index),
      ),
    ];
    if (duplicatedBots.length) {
      await bot.reply(
        message.messageId,
        `拆解结果里同一成员被分配了多个子任务：${duplicatedBots.join("、")}。请调整任务描述，让每个成员只承接一个子任务。`,
        hasThread,
      );
      return;
    }

    const run = this.createRun(prompt, specs);
    const failures: string[] = [];
    for (const sub of run.subTasks) {
      try {
        await this.dispatchSubTask(
          sub,
          run.runId,
          bot,
          botConfig.id,
          message.messageId,
          hasThread,
          session.workspaceDir,
        );
      } catch (error) {
        sub.status = "failed";
        sub.error = (error as Error).message;
        failures.push(`#${sub.id}（${sub.targetBotId}）：${sub.error}`);
      }
    }

    const summary = failures.length
      ? [
          `已创建 ${run.runId}：${run.subTasks.length} 个子任务`,
          `其中 ${failures.length} 个派发失败：`,
          ...failures.map((line) => `- ${line}`),
        ].join("\n")
      : `已创建 ${run.runId}：${run.subTasks.length} 个子任务，已派发给对应成员。\n用 /panel 查看进度。`;
    await bot.reply(message.messageId, summary, hasThread);
  }

  private createRun(prompt: string, specs: SubTaskSpec[]): OrchestrationRun {
    const run: OrchestrationRun = {
      runId: nextRunId(this.runs.keys()),
      prompt,
      startedAt: new Date().toISOString(),
      subTasks: specs.map((spec) => ({
        id: spec.id,
        prompt: spec.prompt,
        targetBotId: spec.bot,
        status: "pending",
      })),
    };
    this.runs.set(run.runId, run);
    // 每次创建 run 后触发淘汰：把已完成的旧 run 清理到 MAX_RUNS 以内，
    // 覆盖“子任务同步派发失败、未走事件即终态”的运行也能被清理的场景。
    this.trimRuns();
    console.log(
      `[编排] ${run.runId} 创建，共 ${run.subTasks.length} 个子任务`,
    );
    return run;
  }

  /** 淘汰策略：只保留最近 MAX_RUNS 条已完成的 run，其余从运行表删除。 */
  private trimRuns(): void {
    const trimmed = trimRuns([...this.runs.values()], MAX_RUNS);
    const kept = new Set(trimmed.map((run) => run.runId));
    for (const runId of [...this.runs.keys()]) {
      if (!kept.has(runId)) this.runs.delete(runId);
    }
  }

  /** 用编排 bot 的 CLI 跑一次拆解，返回结构化子任务规格。 */
  private async decompose(
    botConfig: BotConfig,
    session: Session,
    prompt: string,
  ): Promise<SubTaskSpec[]> {
    const adapter = this.ctx.cli.get(
      session.cliId,
      session.accessMode ?? "headless",
    );
    const members = this.ctx.config.bots.map((config) => config.id);
    const result = await this.ctx.cli.run({
      adapter,
      prompt: buildDecomposePrompt(members, prompt),
      cwd: session.workspaceDir,
      // 拆解是编排 bot 的一次独立规划，不复用用户会话上下文，避免污染后续任务。
      timeoutMs: DECOMPOSE_TIMEOUT_MS,
      onEvent: () => {},
    });
    return parseSubTaskSpecs(result.answer);
  }

  /** 派发单个子任务：注册交接单并 @ 目标 bot；失败时撤销交接单。 */
  private async dispatchSubTask(
    sub: OrchestrationSubTask,
    runId: string,
    bot: Bot,
    fromBotId: string,
    replyToMessageId: string,
    hasThread: boolean,
    workspaceDir: string,
  ): Promise<void> {
    const target = this.ctx.lark.bot(sub.targetBotId);
    if (!target) throw new Error(`成员未就绪: ${sub.targetBotId}`);

    const collaboration: CollaborationMessage = {
      dispatchId: randomUUID().replaceAll("-", "").slice(0, 12),
      taskId: subTaskTaskId(runId, sub.id),
      fromBotId,
      toBotId: sub.targetBotId,
      round: 1,
      maxRounds: 1,
      workspaceDir,
      prompt: sub.prompt,
    };
    // 复用协作交接单：router 对 bot@bot 消息只认已注册的交接单，注册失败会丢消息。
    this.ctx.collaboration.register(collaboration);
    try {
      await bot.replyMention(
        replyToMessageId,
        target.identity,
        `【编排 ${runId}·${sub.id}】${sub.prompt}（任务编号：${collaboration.dispatchId}）`,
        hasThread,
      );
    } catch (error) {
      // @ 派发失败时撤销交接单，避免目标 bot 后续在一张失败的通知上重复领取。
      this.ctx.collaboration.consume(collaboration.dispatchId, sub.targetBotId);
      throw error;
    }
  }

  /** task/result 与 task/failed 事件入口：从交接单反解 run/子任务并更新状态。 */
  handleTaskOutcome(
    collaboration: CollaborationMessage | undefined,
    status: "done" | "failed",
    answer?: string,
  ): void {
    if (!collaboration) return;
    const parsed = parseSubTaskTaskId(collaboration.taskId);
    if (!parsed) return;
    const run = this.runs.get(parsed.runId);
    const sub = run?.subTasks.find((item) => item.id === parsed.subTaskId);
    if (!sub) return;
    sub.status = status;
    sub.finishedAt = new Date().toISOString();
    if (answer) sub.answer = answer;
    if (status === "failed" && !sub.error) sub.error = "任务执行失败";
    // 子任务终态可能让 run 变为全终态；顺手清理超限的已完成 run，及时回收内存。
    this.trimRuns();
  }
}

export const name = "orchestration";
export const inject = ["lark", "cli", "config", "collaboration"];

export function apply(ctx: Context) {
  const service = new OrchestrationService(ctx);
  // 事件监听而非直接调用：编排成为可选插件，移除本插件不影响任务与协作。
  ctx.on("task/result", (payload: TaskResultPayload) => {
    service.handleTaskOutcome(payload.collaboration, "done", payload.answer);
  });
  ctx.on("task/failed", (payload: TaskResultPayload) => {
    service.handleTaskOutcome(payload.collaboration, "failed");
  });
}
