/**
 * Mastra Agent 工厂：把 Mastra 框架封装成 Agent OS 的第三种执行引擎。
 * 模型通过 Mastra 模型路由（"provider/model" 字符串 + 对应 API Key 环境变量）
 * 配置，无需安装额外的 provider 包；内置读写文件与执行命令三个受限工具。
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";

/** 最大可读文件；防止把超大文件塞进模型上下文。 */
const MAX_READ_CHARS = 1024 * 1024;
/** 单次写入内容上限；超出属于异常任务，直接失败。 */
const MAX_WRITE_CHARS = 1024 * 1024;
/** 默认运行命令超时：单条命令不应无限期占用任务。 */
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
/** 命令输出截断上限，避免工具结果撑爆上下文。 */
const MAX_COMMAND_OUTPUT_CHARS = 200_000;

/**
 * 校验工具路径只能落在工作目录（runner 的 cwd）内。
 * 这是飞书入口到 Agent 再到文件系统的最后一道边界：绝对路径和 ..
 * 逃逸都会在这里失败，避免 Agent 被提示词误导读写工作区之外的文件。
 * 导出为独立函数便于测试安全边界。
 */
export function resolveInsideWorkspace(input: string): string {
  const workspace = resolve(process.cwd());
  const target = resolve(workspace, input);
  const relative = target.toLocaleLowerCase();
  const rootKey = workspace.toLocaleLowerCase();
  if (relative !== rootKey && !relative.startsWith(`${rootKey}${sep}`)) {
    throw new Error(`文件路径超出工作目录，已拒绝：${input}`);
  }
  return target;
}

/** 终止命令进程树；Windows 用 taskkill /T 防止孤儿子进程。 */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform !== "win32") {
    child.kill("SIGKILL");
    return;
  }
  const killer = spawn(
    "taskkill.exe",
    ["/PID", String(child.pid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true },
  );
  killer.once("error", () => child.kill());
}

/** 在工作目录内执行 shell 命令，返回截断后的输出与退出码。 */
export function runShellCommand(
  command: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd: process.cwd(),
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // 超时即终止进程树；但要等 taskkill 真正结束再 reject，
    // 否则刚被杀的子进程仍占用工作目录句柄，测试清理临时目录时会撞 EBUSY。
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      const closeSettled = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        // taskkill 失败或进程已退出时 close 可能不触发；3 秒兜底防 Promise 悬挂。
        const fallback = setTimeout(() => resolve(), 3000);
        fallback.unref();
      });
      void closeSettled.then(() => {
        reject(new Error(`命令执行超时（${timeoutMs / 1000} 秒）：${command}`));
      });
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return; // 超时路径已由 timer reject，避免二次结算。
      resolvePromise({
        stdout: stdout.slice(0, MAX_COMMAND_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_COMMAND_OUTPUT_CHARS),
        code,
      });
    });
  });
}

/** 把命令输出整理成适合返回给模型的文本（含退出码信息）。 */
export function formatCommandResult(input: {
  stdout: string;
  stderr: string;
  code: number | null;
}): string {
  const parts: string[] = [];
  if (input.stdout) parts.push(input.stdout);
  if (input.stderr) parts.push(`[stderr]\n${input.stderr}`);
  const body = parts.join("\n").trim() || "(无输出)";
  return `退出码：${input.code}\n${body}`;
}

/** 读取工作目录内的文本文件（UTF-8，最大 1MB）。 */
export const readFileTool = createTool({
  id: "read_file",
  description:
    "读取工作目录内的文本文件（UTF-8 编码，最大 1MB）。路径相对工作目录。",
  inputSchema: z.object({
    path: z.string().describe("文件路径，相对工作目录"),
  }),
  execute: async ({ path }) => {
    const target = resolveInsideWorkspace(path);
    const content = await readFile(target, "utf8");
    if (content.length > MAX_READ_CHARS) {
      throw new Error(
        `文件超过 1MB 读取上限，请改用 run_command 按需处理：${path}`,
      );
    }
    return content;
  },
});

/** 写入工作目录内的文本文件（UTF-8），父目录不存在时自动创建。 */
export const writeFileTool = createTool({
  id: "write_file",
  description:
    "写入工作目录内的文本文件（UTF-8 编码）。父目录不存在时自动创建。",
  inputSchema: z.object({
    path: z.string().describe("文件路径，相对工作目录"),
    content: z.string().describe("完整文件内容"),
  }),
  execute: async ({ path, content }) => {
    if (content.length > MAX_WRITE_CHARS) {
      throw new Error("写入内容超过 1MB 上限，请拆分文件");
    }
    const target = resolveInsideWorkspace(path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
    return `已写入 ${path}（${content.length} 字符）`;
  },
});

/** 在工作目录执行 shell 命令并返回输出。 */
export const runCommandTool = createTool({
  id: "run_command",
  description:
    "在工作目录执行 shell 命令并返回输出。适用于运行测试、构建、git 操作等。",
  inputSchema: z.object({
    command: z.string().describe("要在 shell 中执行的一条命令"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60 * 1000)
      .optional()
      .describe("超时毫秒数，默认 5 分钟"),
  }),
  execute: async ({ command, timeoutMs }) =>
    formatCommandResult(await runShellCommand(command, timeoutMs)),
});

/** 根据环境变量构建可独立运行的 Mastra Agent。 */
export function createMastraAgent(
  model: string,
  systemPrompt: string,
): Agent {
  const instructions =
    systemPrompt.trim() ||
    "你是 Agent OS 里的执行引擎。请先理解任务，需要时使用提供的工具在\n" +
      "工作目录里读写文件或执行命令，最后用中文直接回答结果。";

  return new Agent({
    id: "agent-os-engine",
    name: "Agent OS Engine",
    instructions,
    model,
    tools: {
      read_file: readFileTool,
      write_file: writeFileTool,
      run_command: runCommandTool,
    },
  });
}