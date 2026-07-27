/**
 * JSONL 子进程运行底座：安全启动无头 CLI，逐行消费结构化事件，
 * 并统一处理 stderr、异常退出、取消和重复收尾。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface CliRunResult {
  answer: string;
  sessionId?: string;
}

export interface JsonlEventOutcome<T> {
  result?: T;
  error?: Error;
}

export interface RunJsonlProcessOptions<T> {
  command: string;
  args: string[];
  cwd: string;
  displayName: string;
  cancelledMessage: string;
  missingResultMessage: string;
  signal?: AbortSignal;
  onEvent(event: unknown): JsonlEventOutcome<T> | undefined;
}

/** 运行一个输出 JSONL 的 CLI，并在进程正常退出后返回最后一个有效结果。 */
export function runJsonlProcess<T>(
  options: RunJsonlProcessOptions<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(options.cancelledMessage));
      return;
    }

    // 命令和参数分开传入且不启用 shell，飞书文本无法逃逸成额外系统命令。
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    let finalResult: T | undefined;
    let resultError: Error | undefined;
    let stderr = "";
    let settled = false;

    const stopChild = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform !== "win32") {
        child.kill();
        return;
      }

      // Node 默认只杀直接子进程；taskkill /T 同时清理 Claude/Codex 启动的工具后代。
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
    };
    options.signal?.addEventListener("abort", stopChild, { once: true });
    // 处理 spawn 与监听器注册之间恰好发生 abort 的极小竞态。
    if (options.signal?.aborted) stopChild();

    const cleanup = () => {
      options.signal?.removeEventListener("abort", stopChild);
    };

    // 取消、spawn error 和 close 可能先后到达，只允许第一个出口结束 Promise。
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    lines.on("line", (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        // CLI 诊断日志偶尔会混入 stdout，噪音不能破坏后续完整事件。
        return;
      }

      try {
        const outcome = options.onEvent(event);
        if (outcome?.error) resultError = outcome.error;
        if (outcome?.result !== undefined) finalResult = outcome.result;
      } catch (error) {
        resultError =
          error instanceof Error ? error : new Error(String(error));
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      if (options.signal?.aborted) {
        fail(new Error(options.cancelledMessage));
        return;
      }
      fail(error);
    });

    child.once("close", (code) => {
      if (settled) return;
      if (options.signal?.aborted) {
        fail(new Error(options.cancelledMessage));
        return;
      }
      if (resultError) {
        fail(resultError);
        return;
      }
      if (code !== 0) {
        fail(
          new Error(
            stderr.trim() || `${options.displayName} 退出，状态码 ${code}`,
          ),
        );
        return;
      }
      if (finalResult === undefined) {
        fail(new Error(options.missingResultMessage));
        return;
      }

      settled = true;
      cleanup();
      resolve(finalResult);
    });
  });
}
