/**
 * tasks 任务编排服务插件：从原 index.ts 抽取的一轮 CLI 执行编排——
 * 启动 active 状态、资源下载、任务卡片、进度流式更新、取消收尾与结果事件。
 * 实际执行前广播 task/started，成功卡片前广播 task/completion-check，
 * 任务结束后按结果广播 result/failed/paused/cancelled，
 * 由业务插件完成必要的运行时校验与后续接力。
 */
import { Service, type Context } from "cordis";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CliAdapter, CliEvent, CliRunStats } from "../cli/types.js";
import { CliRunError } from "../cli/runner.js";
import { botCliEnvironment, buildBotPrompt, DIRECT_CHAT_ROLE } from "../core/bot-registry.js";
import {
  isRetryRequest,
  resolveRetryPrompt,
  type Session,
} from "../core/session-manager.js";
import {
  requestTaskAbort,
  type AbortTaskOutcome,
  type ActiveRun,
} from "../core/task-abort.js";
import { TaskProgressTracker } from "../core/task-progress.js";
import type {
  StartTaskInput,
  TaskCompletionCheckPayload,
  TaskResultPayload,
  TaskToolMetrics,
  TaskToolCallsOutcome,
  TaskToolCallsPayload,
} from "./types.js";

// Token、轮次和 CLI 耗时按执行轮累加；上下文占用与窗口大小是快照，只保留最新值。
function accumulateCliStats(
  current: CliRunStats | undefined,
  next: CliRunStats,
): CliRunStats {
  const sum = (
    left: number | undefined,
    right: number | undefined,
  ): number | undefined =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  return {
    durationMs: sum(current?.durationMs, next.durationMs),
    turns: sum(current?.turns, next.turns),
    totalTokens: sum(current?.totalTokens, next.totalTokens),
    inputTokens: sum(current?.inputTokens, next.inputTokens),
    outputTokens: sum(current?.outputTokens, next.outputTokens),
    cacheReadTokens: sum(current?.cacheReadTokens, next.cacheReadTokens),
    cacheCreationTokens: sum(
      current?.cacheCreationTokens,
      next.cacheCreationTokens,
    ),
    contextUsedTokens: next.contextUsedTokens ?? current?.contextUsedTokens,
    contextWindowTokens:
      next.contextWindowTokens ?? current?.contextWindowTokens,
  };
}

/** 一轮任务的运行实例与上下文记忆，供停止、进度和后续任务读取。 */
export class TasksService extends Service {
  /** 每轮运行额外记录发起人和唯一 ID，供卡片按钮鉴权并隔离旧卡片。 */
  readonly activeRuns = new Map<string, ActiveRun>();
  /** Claude 的模型窗口通常到本轮结束才返回，按会话记忆后供下一轮实时展示。 */
  readonly contextWindows = new Map<string, number>();

  constructor(ctx: Context) {
    super(ctx, "tasks");
  }

  /** 请求停止指定的一轮任务；发起人鉴权与旧卡片隔离见 task-abort。 */
  requestAbort(
    sessionId: string,
    runId: string,
    operatorOpenId: string,
  ): AbortTaskOutcome {
    return requestTaskAbort(this.activeRuns, sessionId, runId, operatorOpenId);
  }

  /** /close 专用停止：标记 cancelMode 后广播中止信号。 */
  abortForClose(sessionId: string): void {
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.cancelMode = "close";
      active.controller.abort();
    }
  }

  private getSessionAdapter(session: Session): CliAdapter {
    return this.ctx.cli.get(session.cliId, session.accessMode ?? "headless");
  }

  private async markSessionIdle(sessionId: string): Promise<void> {
    // /close 可能与后台 finally 同时发生；已关闭会话不能被迟到的清理逻辑改回 idle。
    if (this.ctx.sessions.manager.get(sessionId)?.status !== "active") return;
    await this.ctx.sessions.manager.transition(sessionId, "idle");
    console.log(`[会话] id=${sessionId} status=idle`);
  }

  /** 启动一轮任务；内部异常统一消费，不向上抛出。 */
  startTask(input: StartTaskInput): void {
    void this.runTask(input).catch((error) => {
      console.error("[任务] 回传或收尾失败:", (error as Error).message);
    });
  }

  private async runTask(input: StartTaskInput): Promise<void> {
    const {
      bot,
      botConfig,
      session,
      hasThread,
      replyToMessageId,
      senderOpenId,
      senderUnionId,
      taskId,
      requestedPrompt,
      originalRequestedPrompt,
      isCompacting,
      compactInstructions,
      collaboration,
      senderRuntime,
      resources,
      suppressHandoff,
    } = input;
    const cliAdapter = this.getSessionAdapter(session);
    const taskTitle = isCompacting ? "整理上下文" : cliAdapter.displayName;
    const taskStartTime = Date.now();

    // 503 等错误可能发生在 CLI 返回会话 ID 之前；先保存实际任务，明确重试时才能重放。
    // 先用未包装的原始指令识别“继续执行”，避免角色前缀破坏重试判断。
    const teamContext = this.ctx.root.bail(
      "task/prompt-context",
      botConfig,
      { isDirect: input.isDirect ?? false },
    );
    // 私聊直接指挥：角色切换为直接执行者（不做团队分工），群聊保留团队型角色。
    const effectiveBotConfig = input.isDirect
      ? { ...botConfig, role: DIRECT_CHAT_ROLE }
      : botConfig;
    const prompt = await buildBotPrompt(
      effectiveBotConfig,
      resolveRetryPrompt(session, requestedPrompt),
      teamContext ?? "",
      this.ctx.config.defaultProductDeliveryMode,
    );
    // “继续执行”只消费原始待重试指令，不能把它覆盖成恢复失败后的短语。
    if (
      !isCompacting &&
      (!session.retryPrompt || !isRetryRequest(requestedPrompt))
    ) {
      await this.ctx.sessions.manager.setRetryPrompt(
        session.id,
        requestedPrompt,
      );
    }
    await this.ctx.sessions.manager.transition(session.id, "active");

    const run = new AbortController();
    const activeRun: ActiveRun = {
      controller: run,
      ownerOpenId: senderOpenId,
      runId: randomUUID(),
    };
    this.activeRuns.set(session.id, activeRun);

    for (const resource of resources) {
      try {
        const savePath = await bot.downloadResource(
          replyToMessageId,
          resource.key,
          resource.type,
          join("data", "downloads"),
          resource.fileName,
        );
        console.log(`  [下载] ${resource.type} → ${savePath}`);
      } catch (error) {
        console.error(
          `  [下载失败] ${resource.key}:`,
          (error as Error).message,
        );
      }
    }

    // /close 可能在附件下载期间到达；关闭后不能再发送卡片或启动 CLI。
    if (run.signal.aborted) {
      if (this.activeRuns.get(session.id) === activeRun) {
        this.activeRuns.delete(session.id);
      }
      return;
    }

    let cardId: string | undefined;
    try {
      cardId = await bot.replyCard(
        replyToMessageId,
        this.ctx.cards.task({
          title: taskTitle,
          status: "running",
          detail: isCompacting
            ? cliAdapter.compactDetail && compactInstructions
              ? `${cliAdapter.displayName} 正在${cliAdapter.compactDetail}`
              : `正在调用 ${cliAdapter.displayName} 原生上下文整理`
            : "正在理解任务",
          abortSessionId: session.id,
          abortRunId: activeRun.runId,
        }),
        hasThread,
      );
    } catch (error) {
      // 任务尚未真正启动；创建卡片失败时必须撤销 active 状态，允许用户重试。
      if (this.activeRuns.get(session.id) === activeRun) {
        this.activeRuns.delete(session.id);
      }
      await this.markSessionIdle(session.id);
      throw error;
    }

    if (!cardId) {
      console.error("[卡片] 响应里没有 message_id，无法继续更新");
      // 飞书成功响应也可能缺少 ID，此时同样按启动失败回收会话状态。
      if (this.activeRuns.get(session.id) === activeRun) {
        this.activeRuns.delete(session.id);
      }
      await this.markSessionIdle(session.id);
      return;
    }
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

    const progress = new TaskProgressTracker(
      Date.now,
      this.contextWindows.get(session.id),
      !session.cliSessionId,
    );
    let observedCliSessionId = session.cliSessionId;
    let observedStats: CliRunStats | undefined;
    const observedToolMetrics = new Map<
      string,
      { invocations: number; failures: number }
    >();
    const observedToolNames = new Map<string, string>();
    const observedToolIds = new Set<string>();
    const observedFailedToolIds = new Set<string>();
    let currentExecutionStatsObserved = false;
    const beginCliExecution = () => {
      // 纠正轮可能复用工具调用 ID；去重范围只覆盖单次 CLI 执行。
      observedToolNames.clear();
      observedToolIds.clear();
      observedFailedToolIds.clear();
      currentExecutionStatsObserved = false;
    };
    const snapshotToolMetrics = (): TaskToolMetrics =>
      Object.fromEntries(
        [...observedToolMetrics.entries()].map(([toolName, metrics]) => [
          toolName,
          { ...metrics },
        ]),
      );
    let pendingCliSessionSave: Promise<void> | undefined;
    const rememberCliSession = async (cliSessionId: string) => {
      observedCliSessionId = cliSessionId;
      if (
        this.ctx.sessions.manager.get(session.id)?.cliSessionId === cliSessionId
      ) {
        await pendingCliSessionSave;
        return;
      }
      const save = this.ctx.sessions.manager.setCliSessionId(
        session.id,
        cliSessionId,
      );
      pendingCliSessionSave = save.then(() => undefined);
      await pendingCliSessionSave;
    };
    const cardUpdater = this.ctx.cards.throttled(async (card) => {
      try {
        await bot.updateCard(cardId, card);
      } catch (error) {
        console.error("[卡片] 更新失败:", (error as Error).message);
        throw error;
      }
    });
    let cancellationEmitted = false;
    const renderProgress = (snapshot = progress.snapshot()) => {
      cardUpdater.push(
        this.ctx.cards.task({
          title: taskTitle,
          status: "running",
          detail: isCompacting
            ? `正在调用 ${cliAdapter.displayName} 原生上下文整理`
            : snapshot.current,
          ...(!isCompacting ? { progress: snapshot } : {}),
          abortSessionId: session.id,
          abortRunId: activeRun.runId,
        }),
      );
    };
    const finishCancelled = async () => {
      console.log(`[CLI] 任务已取消 engine=${session.cliId}`);
      try {
        await cardUpdater.finish(
          this.ctx.cards.task({
            title: taskTitle,
            status: "cancelled",
            detail:
              activeRun.cancelMode === "close"
                ? "本次任务已停止，当前会话已经关闭。"
                : isCompacting
                  ? "整理已停止，当前 CLI 会话没有改变。"
                  : "本次任务已停止。你可以继续在当前话题里提问。",
            ...(!isCompacting ? { progress: progress.snapshot() } : {}),
          }),
        );
      } finally {
        if (!isCompacting && !cancellationEmitted) {
          cancellationEmitted = true;
          await this.ctx.parallel("task/cancelled", {
            bot,
            botConfig,
            session: this.ctx.sessions.manager.get(session.id) ?? session,
            requestedPrompt: originalRequestedPrompt ?? requestedPrompt,
            answer: "",
            replyToMessageId,
            hasThread,
            collaboration,
            senderRuntime,
            taskId,
            suppressHandoff,
            senderOpenId,
            durationMs: Date.now() - taskStartTime,
            stats: observedStats,
            toolMetrics: snapshotToolMetrics(),
            traceId: activeRun.runId,
          });
        }
      }
    };
    // 没有新事件时心跳仍会推进耗时；节流器确保最终每秒最多一次 patch。
    const progressHeartbeat = setInterval(renderProgress, 1_000);
    progressHeartbeat.unref();

    // 不等待 CLI，确保长连接仍能接收 /status 和 /close 等控制消息。
    // bot 配置了网络代理（如 agy 访问云端服务）时，把标准代理变量注入 CLI 子进程并
    // 覆盖全局配置（bots.json 的 proxy 优先于 .env 的 HTTP_PROXY 等）；
    // 不配置则继承父进程环境，.env 的全局代理变量自然生效。
    const cliEnv = botCliEnvironment(botConfig);
    const handleCliEvent = (event: CliEvent) => {
      if (
        event.type === "result" &&
        event.stats &&
        !currentExecutionStatsObserved
      ) {
        currentExecutionStatsObserved = true;
        observedStats = accumulateCliStats(observedStats, event.stats);
      }
      if (event.type === "tool_start" || event.type === "tool_call") {
        observedToolNames.set(event.toolUseId, event.toolName);
        if (!observedToolIds.has(event.toolUseId)) {
          observedToolIds.add(event.toolUseId);
          const metrics = observedToolMetrics.get(event.toolName) ?? {
            invocations: 0,
            failures: 0,
          };
          metrics.invocations += 1;
          observedToolMetrics.set(event.toolName, metrics);
        }
      }
      if (
        event.type === "tool_end" &&
        event.failed &&
        !observedFailedToolIds.has(event.toolUseId)
      ) {
        observedFailedToolIds.add(event.toolUseId);
        const toolName = observedToolNames.get(event.toolUseId);
        if (toolName) {
          const metrics = observedToolMetrics.get(toolName);
          if (metrics) metrics.failures += 1;
        }
      }
      if (event.type === "session") {
        // 会话 ID 先于最终结果到达；立即写入，任务被停止或进程重启后仍可 resume。
        void rememberCliSession(event.sessionId).catch((error) => {
          console.error(
            "[会话] 保存实时 CLI 会话 ID 失败:",
            (error as Error).message,
          );
        });
        return;
      }
      if (
        event.type !== "tool_start" &&
        event.type !== "tool_end" &&
        event.type !== "context"
      ) {
        return;
      }

      const snapshot = progress.accept(event);
      const currentDetail = snapshot.currentDetail
        ? ` detail=${snapshot.currentDetail}`
        : "";
      const context =
        snapshot.contextUsedTokens === undefined
          ? ""
          : ` context=${snapshot.contextUsedTokens}`;
      console.log(
        `[进度] ${snapshot.current}${currentDetail} tools=${snapshot.completedCount}/${snapshot.toolCount}${context}`,
      );
      renderProgress(snapshot);
    };
    if (!isCompacting) {
      // 开始事件只提供旁路观测，不得因可选监听器异常或耗时而阻断 CLI 主流程。
      void this.ctx
        .parallel("task/started", {
          botConfig,
          session: this.ctx.sessions.manager.get(session.id) ?? session,
          taskId,
          traceId: activeRun.runId,
          startedAt: taskStartTime,
        })
        .catch((error) => {
          const detail =
            error instanceof AggregateError
              ? error.errors
                  .map((item) =>
                    item instanceof Error ? item.message : String(item),
                  )
                  .join("; ")
              : error instanceof Error
                ? error.message
                : String(error);
          console.error(
            "[任务] 广播开始事件失败:",
            detail,
          );
        });
    }
    const runCorrection = async (correctionPrompt: string) => {
      const correctionSession =
        this.ctx.sessions.manager.get(session.id) ?? session;
      // 纠正轮沿用本轮私聊/群聊语义（角色与团队上下文策略一致）。
      const prompt = await buildBotPrompt(
        effectiveBotConfig,
        correctionPrompt,
        teamContext ?? "",
        this.ctx.config.defaultProductDeliveryMode,
      );
      beginCliExecution();
      const corrected = await this.runCliTask(
        cliAdapter,
        prompt,
        correctionSession,
        run.signal,
        cliEnv,
        handleCliEvent,
      );
      if (corrected.stats && !currentExecutionStatsObserved) {
        observedStats = accumulateCliStats(observedStats, corrected.stats);
      }
      if (corrected.sessionId) await rememberCliSession(corrected.sessionId);
      return corrected;
    };
    beginCliExecution();
    const execution = isCompacting
      ? this.ctx.cli
          .compact({
            adapter: cliAdapter,
            sessionId: session.cliSessionId!,
            cwd: session.workspaceDir,
            instructions: compactInstructions,
            signal: run.signal,
            env: cliEnv,
          })
          .then((result) => ({
            answer: result.message ?? "",
            sessionId: result.sessionId,
            stats: undefined,
            toolCalls: undefined,
          }))
      : this.runCliTask(
          cliAdapter,
          prompt,
          session,
          run.signal,
          cliEnv,
          handleCliEvent,
        ).then((result) => {
          if (result.stats && !currentExecutionStatsObserved) {
            observedStats = accumulateCliStats(observedStats, result.stats);
          }
          return result;
        });

    void execution
      .then(async (result) => {
        clearInterval(progressHeartbeat);
        if (!isCompacting && result.sessionId) {
          await rememberCliSession(result.sessionId);
        }
        // /close、按钮和子进程退出可能竞态；取消后只能写灰色终态。
        if (run.signal.aborted) {
          await finishCancelled();
          return;
        }
        const initialTaskResultPayload: TaskResultPayload = {
          bot,
          botConfig,
          session: this.ctx.sessions.manager.get(session.id) ?? session,
          requestedPrompt: originalRequestedPrompt ?? requestedPrompt,
          answer: result.answer,
          replyToMessageId,
          hasThread,
          collaboration,
          senderRuntime,
          taskId,
          suppressHandoff,
          durationMs: Date.now() - taskStartTime,
          stats: observedStats ?? result.stats,
          toolCalls: result.toolCalls,
          toolMetrics: snapshotToolMetrics(),
          traceId: activeRun.runId,
        };
        if (!isCompacting && result.stats?.contextWindowTokens) {
          this.contextWindows.set(session.id, result.stats.contextWindowTokens);
        }
        const publishToolOutcome = async (
          outcome: TaskToolCallsOutcome,
          resultPayload: TaskResultPayload,
          toolResult: typeof result,
        ) => {
          await cardUpdater.finish(outcome.card);
          await outcome.afterCardPublished?.();
          if (outcome.notificationText && !collaboration) {
            await bot.sendResultNotification({
              replyToMessageId,
              target: { openId: senderOpenId, name: "" },
              text: outcome.notificationText,
              replyInThread: hasThread,
            });
          }
          if (outcome.completion === "completed") {
            // 完成型应用工具替换普通成功卡片，但仍需广播结果供编排收口；
            // 产品文档等流程可通过 suppressHandoff 阻止继续自动交接。
            await this.ctx.parallel("task/result", {
              ...resultPayload,
              suppressHandoff:
                outcome.suppressHandoff ?? resultPayload.suppressHandoff,
            });
          } else {
            await this.ctx.parallel("task/paused", resultPayload);
          }
          console.log(
            `[CLI] ${cliAdapter.id} 已交给应用工具处理 session_id=${toolResult.sessionId ?? "(无)"}`,
          );
        };
        // 澄清等暂停型应用工具必须先认领，不能被产品方案的“成功提交”校验打断。
        if (!isCompacting && result.toolCalls?.length) {
          const initialToolPayload: TaskToolCallsPayload = {
            ...initialTaskResultPayload,
            result,
            runId: activeRun.runId,
            senderOpenId,
            senderUnionId,
            isDirect: input.isDirect ?? false,
            cardMessageId: cardId,
          };
          const initialToolOutcome = await this.ctx.serial(
            "task/tool-calls",
            initialToolPayload,
          );
          if (initialToolOutcome) {
            if (!isCompacting) {
              await this.ctx.sessions.manager.setRetryPrompt(session.id, undefined);
            }
            await publishToolOutcome(
              initialToolOutcome,
              initialTaskResultPayload,
              result,
            );
            return;
          }
        }
        let completedResult = result;
        if (!isCompacting) {
          const completionPayload: TaskCompletionCheckPayload = {
            ...initialTaskResultPayload,
            result,
            runId: activeRun.runId,
            senderOpenId,
            senderUnionId,
            cardMessageId: cardId,
            signal: run.signal,
            runCorrection,
          };
          const completionOutcome = await this.ctx.serial(
            "task/completion-check",
            completionPayload,
          );
          if (completionOutcome) completedResult = completionOutcome.result;
          if (run.signal.aborted) {
            await finishCancelled();
            return;
          }
          if (completedResult.sessionId) {
            await rememberCliSession(completedResult.sessionId);
          }
          if (completedResult.stats?.contextWindowTokens) {
            this.contextWindows.set(
              session.id,
              completedResult.stats.contextWindowTokens,
            );
          }
          await this.ctx.sessions.manager.setRetryPrompt(session.id, undefined);
        }
        const taskResultPayload: TaskResultPayload = {
          ...initialTaskResultPayload,
          session: this.ctx.sessions.manager.get(session.id) ?? session,
          answer: completedResult.answer,
          stats: observedStats ?? completedResult.stats ?? initialTaskResultPayload.stats,
          toolCalls: completedResult.toolCalls ?? initialTaskResultPayload.toolCalls,
          toolMetrics: snapshotToolMetrics(),
          durationMs: Date.now() - taskStartTime,
        };
        if (!isCompacting && completedResult.toolCalls?.length) {
          const toolPayload: TaskToolCallsPayload = {
            ...taskResultPayload,
            result: completedResult,
            runId: activeRun.runId,
            senderOpenId,
            senderUnionId,
            isDirect: input.isDirect ?? false,
            cardMessageId: cardId,
          };
          const outcome = await this.ctx.serial("task/tool-calls", toolPayload);
          if (outcome) {
            await publishToolOutcome(outcome, taskResultPayload, completedResult);
            return;
          }
        }
        await cardUpdater.finish(
          isCompacting
            ? this.ctx.cards.notice({
                title: result.answer ? "暂时无需整理" : "上下文已整理",
                template: result.answer ? "grey" : "green",
                detail:
                  result.answer ||
                  [
                    `${cliAdapter.displayName} 已在当前 CLI 会话内完成原生压缩。`,
                    "CLI 会话 ID 保持不变，下一条任务会继续使用整理后的上下文。",
                  ].join("\n\n"),
              })
            : this.ctx.cards.task({
                title: taskTitle,
                status: "success",
                detail: "执行完成",
                progress: progress.snapshot(),
                answer: completedResult.answer,
                stats: taskResultPayload.stats,
              }),
        );
        if (
          !isCompacting &&
          this.ctx.cards.needsContinuation(completedResult.answer)
        ) {
          for (const chunk of this.ctx.cards.splitLongText(
            this.ctx.cards.continuation(completedResult.answer),
          )) {
            if (run.signal.aborted) break;
            await bot.reply(replyToMessageId, chunk, hasThread);
          }
        }
        console.log(
          `[CLI] ${cliAdapter.id} 完成 session_id=${completedResult.sessionId ?? "(无)"}`,
        );
        if (!collaboration) {
          await bot.sendResultNotification({
            replyToMessageId,
            target: { openId: senderOpenId, name: "" },
            text: isCompacting
              ? "上下文整理已完成，请查看上方结果。"
              : "任务已完成，请查看上方结果。",
            replyInThread: hasThread,
          });
        }
        if (!isCompacting) {
          // 协作交接走事件广播，collaboration 插件自行决定是否继续派发。
          await this.ctx.parallel("task/result", taskResultPayload);
        }
      })
      .catch(async (error) => {
        clearInterval(progressHeartbeat);
        const errorMessage = (error as Error).message;
        const currentSession =
          this.ctx.sessions.manager.get(session.id) ?? session;
        const sessionUnavailable =
          error instanceof CliRunError &&
          Boolean(cliAdapter.isSessionUnavailable?.(errorMessage)) &&
          Boolean(currentSession.cliSessionId);
        const failedCliSessionId =
          (error instanceof CliRunError ? error.sessionId : undefined) ??
          observedCliSessionId;
        if (!isCompacting && failedCliSessionId) {
          try {
            // 进程虽失败，但已建立的线程仍可续接，不能等成功路径才保存。
            await rememberCliSession(failedCliSessionId);
          } catch (persistError) {
            console.error(
              "[会话] 保存失败任务的 CLI 会话 ID 失败:",
              (persistError as Error).message,
            );
          }
        }
        if (sessionUnavailable) {
          try {
            // 续聊指针已失效；清掉后下一次“继续执行”才会按原任务新建会话。
            await this.ctx.sessions.manager.clearCliSessionId(session.id);
            console.warn(
              `[会话] CLI 会话已失效，将在下次重试时重新建立 engine=${cliAdapter.id}`,
            );
          } catch (persistError) {
            console.error(
              "[会话] 清除失效 CLI 会话 ID 失败:",
              (persistError as Error).message,
            );
          }
        }
        if (run.signal.aborted) {
          await finishCancelled();
          return;
        }
        console.error(`[CLI] 执行失败 engine=${cliAdapter.id}:`, errorMessage);
        await cardUpdater.finish(
          this.ctx.cards.task({
            title: taskTitle,
            status: "failed",
            detail: isCompacting
              ? "上下文整理失败，当前 CLI 会话没有改变。"
              : sessionUnavailable
                ? "会话已失效。发送“继续执行”将重新建立会话并继续原任务。"
                : "执行没有完成。你可以调整指令后，在当前话题里重试。",
            technicalDetail: errorMessage,
            ...(!isCompacting ? { progress: progress.snapshot() } : {}),
          }),
        );
        if (!isCompacting) {
          // 失败也走事件广播（与 task/result 语义区分）：编排等可选插件据此标记
          // 子任务失败；collaboration 不监听本事件，不会误触发审查交接。
          // error 与 senderOpenId 供 auth 插件识别认证需求并发起登录卡片。
          await this.ctx.parallel("task/failed", {
            bot,
            botConfig,
            session: this.ctx.sessions.manager.get(session.id) ?? session,
            requestedPrompt: originalRequestedPrompt ?? requestedPrompt,
            answer: "",
            replyToMessageId,
            hasThread,
            collaboration,
            senderRuntime,
            taskId,
            suppressHandoff,
            senderOpenId,
            error: errorMessage,
            durationMs: Date.now() - taskStartTime,
            stats: observedStats,
            toolMetrics: snapshotToolMetrics(),
            traceId: activeRun.runId,
          });
        }
      })
      .finally(async () => {
        clearInterval(progressHeartbeat);
        // 仅清理自己登记的运行实例，防止旧任务的迟到回调删除同会话的新任务。
        if (this.activeRuns.get(session.id) === activeRun) {
          this.activeRuns.delete(session.id);
        }
        try {
          await this.markSessionIdle(session.id);
        } catch (error) {
          console.error(
            "[会话] 保存空闲状态失败:",
            (error as Error).message,
          );
        }
      })
      .catch((error) => {
        // 卡片更新、飞书回复或 finally 持久化失败也必须被消费，避免未处理拒绝。
        console.error("[任务] 回传或收尾失败:", (error as Error).message);
      });
  }

  /** 通过 cli 服务启动一轮 CLI 子进程并转发流式事件。 */
  private runCliTask(
    adapter: CliAdapter,
    prompt: string,
    session: Session,
    signal: AbortSignal,
    env: Record<string, string> | undefined,
    onEvent: (event: CliEvent) => void,
  ) {
    console.log(
      `[CLI] 启动 engine=${adapter.id} access_mode=${adapter.accessMode} cwd=${session.workspaceDir}`,
    );
    return this.ctx.cli.run({
      adapter,
      prompt,
      cwd: session.workspaceDir,
      sessionId: session.cliSessionId,
      signal,
      env,
      onEvent,
    });
  }
}

export const name = "tasks";
export const inject = ["config", "sessions", "cli", "cards"];

export function apply(ctx: Context) {
  new TasksService(ctx);
}
