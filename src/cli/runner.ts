/**
 * 通用 CLI Runner：安全启动适配器声明的无头进程，逐行消费统一事件，
 * 并集中处理超时、取消、Windows 进程树清理和唯一收尾。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveCliCommand } from "./command-resolver.js";
import type { CliAdapter, CliEvent, CliRunResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunCliOptions {
  adapter: CliAdapter;
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: CliEvent) => void;
}

function stopProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }

  // CLI 还会启动工具子进程；taskkill /T 防止取消或超时后留下孤立后代。
  const killer = spawn(
    "taskkill.exe",
    ["/PID", String(child.pid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true },
  );
  const fallback = () => {
    if (child.exitCode === null) child.kill();
  };
  killer.once("error", fallback);
  killer.once("close", (code) => {
    if (code !== 0) fallback();
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
    timeoutMs = DEFAULT_TIMEOUT_MS,
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
    let finalAnswer: string | undefined;
    let finalStats: CliRunResult["stats"];
    let resultError: Error | undefined;
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const stopForAbort = () => stopProcessTree(child);
    signal?.addEventListener("abort", stopForAbort, { once: true });
    // 覆盖 spawn 与监听器注册之间发生 abort 的极小竞态。
    if (signal?.aborted) stopForAbort();

    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessTree(child);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stopForAbort);
      lines.close();
    };
    const fail = (error: Error) => {
      // abort、spawn error 与 close 可能先后到达，只允许第一个出口结束 Promise。
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

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
            finalAnswer = event.answer;
            finalStats = event.stats;
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
      if (finalAnswer === undefined) {
        fail(new Error(`${adapter.displayName} 没有返回最终结果`));
        return;
      }

      settled = true;
      cleanup();
      resolve({
        answer: finalAnswer,
        ...(observedSessionId ? { sessionId: observedSessionId } : {}),
        ...(finalStats ? { stats: finalStats } : {}),
      });
    });
  });
}
