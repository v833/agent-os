/**
 * CLI 子进程树清理：为 headless 与 ACP Runner 提供统一的取消收尾，
 * Windows 使用 taskkill /T，避免外部 Agent 留下仍在运行的工具进程。
 */
import { spawn, type ChildProcess } from "node:child_process";

const PROCESS_STOP_GRACE_MS = 2_000;

/** 终止 CLI 及其后代；重复调用或进程已经退出时安全返回。 */
export function stopProcessTree(child: ChildProcess): Promise<void> {
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
    // taskkill 或 SIGTERM 自身也可能卡住；宽限期后强制释放 Runner。
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

    killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", fallback);
    killer.once("close", (code) => {
      if (code !== 0) fallback();
    });
  });
}

