/**
 * CLI 子进程树清理：为 headless 与 ACP Runner 提供统一的取消收尾。
 * Windows 优先用 taskkill /T；父进程已退出时按创建时间筛选残留后代，避免 PID 复用误杀。
 */
import { spawn, type ChildProcess } from "node:child_process";

const PROCESS_STOP_GRACE_MS = 2_000;
const PROCESS_QUERY_TIMEOUT_MS = 1_500;
// 查询可能先后经历 WMIC 与 PowerShell 两条路径；给查询和 taskkill 留出
// 独立的收尾窗口，但仍保证 stopProcessTree 自身有明确上限。
const PROCESS_STOP_DEADLINE_MS =
  PROCESS_STOP_GRACE_MS + PROCESS_QUERY_TIMEOUT_MS * 2 + 1_000;

interface WindowsProcessRecord {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  CreationDate?: unknown;
}

/** 标识一次具体的进程启动，用时间边界防止后续复用同一 PID 的进程被误清理。 */
export interface ProcessTreeSnapshot {
  rootPid: number;
  startedAt: number;
}

/**
 * 在调用 spawn 前记录 startedAt，再与返回的 PID 组成进程实例快照。
 * 这里不查询系统进程表，避免每轮 CLI 启动都产生一次昂贵的 WMI/CIM 扫描。
 */
export function captureProcessTree(
  pid: number | undefined,
  startedAt: number = Date.now(),
): ProcessTreeSnapshot | undefined {
  if (!pid) return undefined;
  return { rootPid: pid, startedAt };
}

/** 终止 CLI 及其后代；重复调用或进程已经退出时也会尝试清理残留后代。 */
export function stopProcessTree(
  child: ChildProcess,
  snapshot: ProcessTreeSnapshot | undefined = captureProcessTree(child.pid),
): Promise<void> {
  if (!child.pid) return Promise.resolve();

  if (process.platform !== "win32") {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(graceTimer);
        child.removeListener("close", finish);
        resolve();
      };
      const graceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        finish();
      }, PROCESS_STOP_GRACE_MS);
      graceTimer.unref();
      child.once("close", finish);
      child.kill("SIGTERM");
    });
  }

  return new Promise((resolve) => {
    let finished = false;
    let childClosed = child.exitCode !== null;
    let killerDone = false;
    let killer: ChildProcess | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      child.removeListener("close", onChildClose);
      resolve();
    };
    const maybeFinish = () => {
      if (killerDone && childClosed) finish();
    };
    const onChildClose = () => {
      childClosed = true;
      maybeFinish();
    };
    const fallback = () => {
      if (child.exitCode === null) child.kill();
      if (killer?.exitCode === null) killer.kill();
    };
    forceTimer = setTimeout(() => {
      // 先强制结束仍存活的主进程，但不在这里结束 Promise；若进程树查询
      // 尚未完成，后续仍需清理已经脱离父树的后代。
      fallback();
    }, PROCESS_STOP_GRACE_MS);
    forceTimer.unref();
    deadlineTimer = setTimeout(() => {
      // 查询工具本身也可能不可用；到总截止时间必须释放 Runner，避免清理
      // 逻辑成为新的永久挂起点。
      fallback();
      finish();
    }, PROCESS_STOP_DEADLINE_MS);
    deadlineTimer.unref();
    child.once("close", onChildClose);

    void (async () => {
      // 主进程仍存活时 /T 能直接遍历当前进程树，无需扫描系统进程表。
      // 只有父进程提前退出时，才按本次启动的时间窗口查询残留后代。
      const pids =
        child.exitCode === null
          ? []
          : await queryWindowsProcessTree(
              child.pid!,
              snapshot && snapshot.rootPid === child.pid
                ? snapshot.startedAt
                : Date.now(),
              Date.now(),
            );
      if (finished) return;

      const args = [
        ...(child.exitCode === null
          ? ["/PID", String(child.pid), "/T"]
          : []),
        ...pids.flatMap((pid) => ["/PID", String(pid)]),
        "/F",
      ];
      if (child.exitCode !== null && pids.length === 0) {
        killerDone = true;
        maybeFinish();
        return;
      }
      killer = spawn("taskkill.exe", args, {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => {
        killerDone = true;
        fallback();
        maybeFinish();
      });
      killer.once("close", () => {
        killerDone = true;
        // taskkill 失败通常只表示某个 PID 已经先退出；同一次命令中的
        // 其他 PID 仍已尝试处理，不应让 Runner 无限等待。
        maybeFinish();
      });
    })();
  });
}

async function queryWindowsProcessTree(
  rootPid: number,
  startedAt: number,
  stoppedAt: number,
): Promise<readonly number[]> {
  const wmic = await runWindowsQuery("wmic.exe", [
    "process",
    "get",
    "ProcessId,ParentProcessId,CreationDate",
    "/value",
  ]);
  if (wmic.code === 0 && wmic.output.trim().length > 0) {
    return descendantPidsFromWmic(wmic.output, rootPid, startedAt, stoppedAt);
  }

  // WMIC 在较新的 Windows 安装中可能不存在；保留 PowerShell/CIM 降级。
  // 创建时间无法解析时宁可留下进程，也不能拿裸 PID 冒险终止无关进程。
  const powershell = await runWindowsQuery("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress",
  ]);
  if (powershell.code !== 0 || powershell.output.trim().length === 0) {
    return [];
  }
  return descendantPidsFromJson(
    powershell.output,
    rootPid,
    startedAt,
    stoppedAt,
  );
}

function runWindowsQuery(
  command: string,
  args: string[],
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const query = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    const timer = setTimeout(() => {
      query.kill();
      finish(null);
    }, PROCESS_QUERY_TIMEOUT_MS);
    timer.unref();
    query.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    query.once("error", () => finish(null));
    query.once("close", (code) => finish(code));
  });
}

function descendantPidsFromWmic(
  output: string,
  rootPid: number,
  startedAt: number,
  stoppedAt: number,
): number[] {
  const records: WindowsProcessRecord[] = [];
  let current: WindowsProcessRecord = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^(CreationDate|ProcessId|ParentProcessId)\s*=\s*(.+?)\s*$/.exec(
      line.trim(),
    );
    if (!match) {
      if (current.ProcessId !== undefined) records.push(current);
      current = {};
      continue;
    }
    current[match[1] as keyof WindowsProcessRecord] = match[2];
  }
  if (current.ProcessId !== undefined) records.push(current);

  return collectDescendantPids(records, rootPid, startedAt, stoppedAt);
}

function descendantPidsFromJson(
  output: string,
  rootPid: number,
  startedAt: number,
  stoppedAt: number,
): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return [];
  }
  const records = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (value): value is WindowsProcessRecord =>
      Boolean(value) && typeof value === "object",
  );
  return collectDescendantPids(records, rootPid, startedAt, stoppedAt);
}

function collectDescendantPids(
  records: readonly WindowsProcessRecord[],
  rootPid: number,
  startedAt: number,
  stoppedAt: number,
): number[] {
  const normalized = records
    .map((record) => ({
      pid: asPid(record.ProcessId),
      parentPid: asPid(record.ParentProcessId),
      createdAt: asCreationTime(record.CreationDate),
    }))
    .filter(
      (record): record is { pid: number; parentPid: number; createdAt: number } =>
        record.pid !== undefined &&
        record.parentPid !== undefined &&
        record.createdAt !== undefined,
    );
  const reusedRoot = normalized.find(
    (record) => record.pid === rootPid && record.createdAt > startedAt,
  );
  const latestCreation = reusedRoot
    ? Math.min(stoppedAt, reusedRoot.createdAt - 1)
    : stoppedAt;
  const children = new Map<number, number[]>();
  for (const record of normalized) {
    if (record.createdAt < startedAt || record.createdAt > latestCreation) {
      continue;
    }
    const list = children.get(record.parentPid) ?? [];
    list.push(record.pid);
    children.set(record.parentPid, list);
  }

  const descendants: number[] = [];
  const pending = [rootPid];
  const seen = new Set([rootPid]);
  while (pending.length > 0) {
    const parentPid = pending.shift()!;
    for (const pid of children.get(parentPid) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      descendants.push(pid);
      pending.push(pid);
    }
  }
  return descendants;
}

function asPid(value: unknown): number | undefined {
  const pid = typeof value === "number" ? value : Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function asCreationTime(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const isoTime = Date.parse(value);
  if (Number.isFinite(isoTime)) return isoTime;

  // WMIC 使用 DMTF 时间：yyyyMMddHHmmss.mmmmmm+UUU，UUU 为 UTC 偏移分钟。
  const match =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d{3}([+-])(\d{3})$/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const localTime = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
  const offsetMinutes = Number(match[9]) * (match[8] === "+" ? 1 : -1);
  return localTime - offsetMinutes * 60_000;
}
