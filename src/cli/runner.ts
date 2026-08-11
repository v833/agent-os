/**
 * 通用 CLI Runner：安全启动适配器声明的无头进程，逐行消费统一事件，
 * 并集中处理瞬时断流重试、超时、取消、Windows 进程树清理和唯一收尾。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveCliCommand } from "./command-resolver.js";
import type { CliAdapter, CliEvent, CliRunResult } from "./types.js";

const PROCESS_STOP_GRACE_MS = 2_000;
const TRANSIENT_STREAM_RETRY_DELAYS_MS = [
  1_000,
  1_500,
  2_000,
  2_500,
  3_000,
] as const;

export interface RunCliOptions {
  adapter: CliAdapter;
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** 可选执行时限；未传入时不自动超时。 */
  timeoutMs?: number;
  onEvent?: (event: CliEvent) => void;
}

/** CLI 失败信息；若进程已返回会话 ID，调用方仍可持久化并续聊。 */
export class CliRunError extends Error {
  constructor(
    message: string,
    readonly sessionId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliRunError";
  }
}

function stopProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let finished = false;
    let killer: ChildProcess | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(graceTimer);
      child.removeListener("close", finish);
      resolve();
    };
    const fallback = () => {
      if (child.exitCode !== null) return;
      child.kill(process.platform === "win32" ? undefined : "SIGKILL");
    };
    // 平台终止命令也可能挂住；宽限期后直接杀父进程并释放 Runner。
    const graceTimer = setTimeout(() => {
      if (killer?.exitCode === null) killer.kill();
      fallback();
      finish();
    }, PROCESS_STOP_GRACE_MS);
    graceTimer.unref();
    child.once("close", finish);

    if (process.platform !== "win32") {
      child.kill("SIGTERM");
      return;
    }

    // CLI 还会启动工具子进程；taskkill /T 防止留下孤立后代。
    killer = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("error", fallback);
    killer.once("close", (code) => {
      if (code !== 0) fallback();
    });
  });
}

/** 执行一次首次对话或续聊，并返回最终回答及执行引擎会话 ID。 */
export function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    timeoutMs,
    onEvent,
  } = options;

  if (signal?.aborted) {
    return Promise.reject(new Error(`${adapter.displayName} 执行已取消`));
  }

  const executable = resolveCliCommand(adapter.command);
  const adapterArgs = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId)
    : adapter.buildArgs(prompt);

  return new Promise((resolve, reject) => {
    // shell=false 且参数分离，飞书文本无法逃逸成额外系统命令。
    const child = spawn(
      executable.command,
      [...executable.argsPrefix, ...adapterArgs],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const lines = createInterface({ input: child.stdout });
    let observedSessionId = sessionId;
    let observedAnswer: string | undefined;
    let observedStats: CliRunResult["stats"];
    let resultError: Error | undefined;
    let stderr = "";
    let settled = false;
    let timedOut = false;

    let timer: NodeJS.Timeout | undefined;
    let stopPromise: Promise<void> | undefined;
    let stopForAbort: () => void;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", stopForAbort);
      lines.close();
    };
    const fail = (error: Error) => {
      // abort、spawn error 与 close 可能先后到达，只允许第一个出口结束 Promise。
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        observedSessionId
          ? new CliRunError(error.message, observedSessionId, { cause: error })
          : error,
      );
    };
    const stopOnce = () => {
      stopPromise ??= stopProcessTree(child);
      return stopPromise;
    };
    const stopThenFail = (error: Error) => {
      // close 正常到达时会提前 fail；否则宽限期结束后这里保证 Promise 收尾。
      void stopOnce().finally(() => fail(error));
    };
    stopForAbort = () => {
      stopThenFail(new Error(`${adapter.displayName} 执行已取消`));
    };
    signal?.addEventListener("abort", stopForAbort, { once: true });
    // 覆盖 spawn 与监听器注册之间发生 abort 的极小竞态。
    if (signal?.aborted) stopForAbort();

    // 默认不设执行时限；调用方显式传入 timeoutMs 时才启用自动终止。
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        stopThenFail(new Error(`${adapter.displayName} 执行超时`));
      }, timeoutMs);
    }

    lines.on("line", (line) => {
      try {
        for (const event of adapter.parseEvents(line)) {
          // 观察者不能破坏 Runner 内部状态更新；异常会在进程退出后稳定拒绝。
          try {
            onEvent?.(event);
          } catch (error) {
            resultError =
              error instanceof Error ? error : new Error(String(error));
          }
          if ("sessionId" in event && event.sessionId) {
            observedSessionId = event.sessionId;
          }
          if (event.type === "error") {
            resultError = new Error(event.message);
          } else if (event.type === "result") {
            // Codex 会把回答和统计拆成不同事件；空字段不能覆盖已经观察到的值。
            if (event.answer) observedAnswer = event.answer;
            if (event.stats) observedStats = event.stats;
          }
        }
      } catch (error) {
        resultError =
          error instanceof Error ? error : new Error(String(error));
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      if (timedOut) {
        fail(new Error(`${adapter.displayName} 执行超时`));
      } else if (signal?.aborted) {
        fail(new Error(`${adapter.displayName} 执行已取消`));
      } else {
        fail(error);
      }
    });

    child.once("close", (code) => {
      if (settled) return;
      if (timedOut) {
        fail(new Error(`${adapter.displayName} 执行超时`));
        return;
      }
      if (signal?.aborted) {
        fail(new Error(`${adapter.displayName} 执行已取消`));
        return;
      }
      if (resultError) {
        fail(resultError);
        return;
      }
      if (code !== 0) {
        fail(
          new Error(
            stderr.trim() || `${adapter.displayName} 退出，状态码 ${code}`,
          ),
        );
        return;
      }
      if (observedAnswer === undefined) {
        fail(new Error(`${adapter.displayName} 没有返回最终结果`));
        return;
      }

      settled = true;
      cleanup();
      resolve({
        answer: observedAnswer,
        ...(observedSessionId ? { sessionId: observedSessionId } : {}),
        ...(observedStats ? { stats: observedStats } : {}),
      });
    });
  });
}

function isTransientStreamDisconnect(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stream disconnected before completion:\s*upstream request failed/i.test(
    message,
  );
}

function waitForRetry(
  adapter: CliAdapter,
  signal: AbortSignal | undefined,
  delayMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error(`${adapter.displayName} 执行已取消`));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * 对 Codex 流式连接的明确瞬时断流做有限重试；每次重试优先续接已建立的 CLI 会话。
 * 其他 CLI 或错误保持一次执行语义，避免认证、权限或代码错误被静默重复执行。
 */
export async function runCliWithTransientRetry(
  options: RunCliOptions,
): Promise<CliRunResult> {
  let currentSessionId = options.sessionId;

  for (let retryIndex = 0; ; retryIndex += 1) {
    try {
      return await runCli({
        ...options,
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
        onEvent: (event) => {
          if (event.type === "session") currentSessionId = event.sessionId;
          options.onEvent?.(event);
        },
      });
    } catch (error) {
      if (
        options.adapter.id !== "codex" ||
        !isTransientStreamDisconnect(error) ||
        retryIndex >= TRANSIENT_STREAM_RETRY_DELAYS_MS.length ||
        options.signal?.aborted
      ) {
        throw error;
      }
      if (error instanceof CliRunError && error.sessionId) {
        currentSessionId = error.sessionId;
      }

      const delayMs = TRANSIENT_STREAM_RETRY_DELAYS_MS[retryIndex];
      console.warn(
        `[CLI] 检测到流式连接中断，将在 ${delayMs}ms 后重试 (${retryIndex + 1}/${TRANSIENT_STREAM_RETRY_DELAYS_MS.length})`,
      );
      await waitForRetry(options.adapter, options.signal, delayMs);
    }
  }
}
