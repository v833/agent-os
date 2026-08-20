/**
 * tasks 任务编排服务插件：从原 index.ts 抽取的一轮 CLI 执行编排——
 * 启动 active 状态、资源下载、任务卡片、进度流式更新、取消收尾与结果事件。
 * 任务完成时广播 task/result，由 collaboration 等可选插件继续接力。
 */
import { Service, type Context } from "cordis";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CliAdapter, CliEvent } from "../cli/types.js";
import { CliRunError } from "../cli/runner.js";
import { botCliEnvironment, buildBotPrompt } from "../core/bot-registry.js";
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
  TaskResultPayload,
  TaskToolCallsPayload,
} from "./types.js";

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
      requestedPrompt,
      originalRequestedPrompt,
      isCompacting,
      compactInstructions,
      collaboration,
      senderRuntime,
      resources,
    } = input;
    const cliAdapter = this.getSessionAdapter(session);
    const taskTitle = isCompacting ? "整理上下文" : cliAdapter.displayName;

    // 503 等错误可能发生在 CLI 返回会话 ID 之前；先保存实际任务，明确重试时才能重放。
    // 先用未包装的原始指令识别“继续执行”，避免角色前缀破坏重试判断。
    const teamContext = this.ctx.root.bail(
      "task/prompt-context",
      botConfig,
    );
    const prompt = buildBotPrompt(
      botConfig,
      resolveRetryPrompt(session, requestedPrompt),
      teamContext ?? "",
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
    };
    // 没有新事件时心跳仍会推进耗时；节流器确保最终每秒最多一次 patch。
    const progressHeartbeat = setInterval(renderProgress, 1_000);
    progressHeartbeat.unref();

    // 不等待 CLI，确保长连接仍能接收 /status 和 /close 等控制消息。
    // bot 配置了网络代理（如 agy 访问云端服务）时，把标准代理变量注入 CLI 子进程并
    // 覆盖全局配置（bots.json 的 proxy 优先于 .env 的 HTTP_PROXY 等）；
    // 不配置则继承父进程环境，.env 的全局代理变量自然生效。
    const cliEnv = botCliEnvironment(botConfig);
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
          (event) => {
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
        if (!isCompacting && result.stats?.contextWindowTokens) {
          this.contextWindows.set(session.id, result.stats.contextWindowTokens);
        }
        if (!isCompacting) {
          await this.ctx.sessions.manager.setRetryPrompt(session.id, undefined);
        }
        const taskResultPayload: TaskResultPayload = {
          bot,
          botConfig,
          session: this.ctx.sessions.manager.get(session.id) ?? session,
          requestedPrompt: originalRequestedPrompt ?? requestedPrompt,
          answer: result.answer,
          replyToMessageId,
          hasThread,
          collaboration,
          senderRuntime,
        };
        if (!isCompacting && result.toolCalls?.length) {
          const toolPayload: TaskToolCallsPayload = {
            ...taskResultPayload,
            result,
            runId: activeRun.runId,
            senderOpenId,
          };
          const outcome = await this.ctx.serial("task/tool-calls", toolPayload);
          if (outcome) {
            await cardUpdater.finish(outcome.card);
            console.log(
              `[CLI] ${cliAdapter.id} 已交给应用工具处理 session_id=${result.sessionId ?? "(无)"}`,
            );
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
                answer: result.answer,
                stats: result.stats,
              }),
        );
        if (!isCompacting && this.ctx.cards.needsContinuation(result.answer)) {
          for (const chunk of this.ctx.cards.splitLongText(
            this.ctx.cards.continuation(result.answer),
          )) {
            if (run.signal.aborted) break;
            await bot.reply(replyToMessageId, chunk, hasThread);
          }
        }
        console.log(
          `[CLI] ${cliAdapter.id} 完成 session_id=${result.sessionId ?? "(无)"}`,
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
        const sessionUnavailable =
          error instanceof CliRunError &&
          Boolean(cliAdapter.isSessionUnavailable?.(errorMessage)) &&
          Boolean(session.cliSessionId);
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
export const inject = ["sessions", "cli", "cards"];

export function apply(ctx: Context) {
  new TasksService(ctx);
}
