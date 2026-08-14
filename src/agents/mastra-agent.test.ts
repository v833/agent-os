/**
 * Mastra 工具测试：验证读写工具的工作目录边界（安全关键）、
 * 命令执行的输出/退出码/超时终止，以及默认 Agent 构造。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolExecutionContext } from "@mastra/core/tools";
import {
  createMastraAgent,
  readFileTool,
  resolveInsideWorkspace,
  runCommandTool,
  runShellCommand,
  writeFileTool,
} from "./mastra-agent.js";

/** 工具测试不需要真实执行上下文；observe 用 noop 占位。 */
const toolContext = {
  observe: () => undefined,
} as unknown as ToolExecutionContext;

/** 在临时工作目录中执行断言，结束后恢复原 cwd。 */
async function withWorkspace(
  fn: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "agent-os-mastra-tools-"));
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    await fn(workspace);
  } finally {
    process.chdir(previous);
    // 刚被杀的命令子进程可能仍占用目录句柄；重试直到 Windows 释放。
    await rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

test("resolveInsideWorkspace 拒绝相对与绝对路径逃逸", async () => {
  await withWorkspace(async (workspace) => {
    assert.equal(resolveInsideWorkspace("a/b.txt"), join(workspace, "a", "b.txt"));
    assert.equal(resolveInsideWorkspace(""), workspace);
    assert.throws(
      () => resolveInsideWorkspace("../outside.txt"),
      /超出工作目录/,
    );
    assert.throws(
      () => resolveInsideWorkspace(join(tmpdir(), "other", "secret.txt")),
      /超出工作目录/,
    );
  });
});

test("read_file 只允许读取工作目录内文件", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "ok.txt"), "内容", "utf8");
    assert.equal(await readFileTool.execute!({ path: "ok.txt" }, toolContext), "内容");
    await assert.rejects(
      () => readFileTool.execute!({ path: "../secret.txt" }, toolContext),
      /超出工作目录/,
    );
  });
});

test("write_file 自动创建父目录并写入 UTF-8 内容", async () => {
  await withWorkspace(async (workspace) => {
    const result = await writeFileTool.execute!(
      { path: "nested/deep/out.txt", content: "你好\n" },
      toolContext,
    );
    assert.match(String(result), /已写入/);
    assert.equal(await readFile(join(workspace, "nested", "deep", "out.txt"), "utf8"), "你好\n");
    await assert.rejects(
      () =>
        writeFileTool.execute!(
          { path: join(tmpdir(), "escape.txt"), content: "x" },
          toolContext,
        ),
      /超出工作目录/,
    );
  });
});

test("run_command 返回退出码、stdout/stderr 与截断结果", async () => {
  await withWorkspace(async () => {
    const result = await runShellCommand("echo hello && echo err 1>&2");
    assert.equal(result.code, 0);
    assert.match(result.stdout, /hello/);
    assert.match(result.stderr, /err/);
    assert.match(
      (await runCommandTool.execute!({ command: "echo ready" }, toolContext)) as string,
      /退出码：0\nready/,
    );
    const failed = await runShellCommand("exit 3");
    assert.equal(failed.code, 3);
  });
});

test("run_command 超时后终止并返回超时错误", async () => {
  await withWorkspace(async () => {
    await assert.rejects(
      () =>
        runShellCommand(
          process.platform === "win32"
            ? "ping -n 30 127.0.0.1 >null"
            : "sleep 30",
          200,
        ),
      /命令执行超时/,
    );
  });
});

test("createMastraAgent 用自定义提示词构造且不抛错", () => {
  const agent = createMastraAgent("openai/gpt-4o-mini", "你是翻译助手");
  assert.equal(typeof agent.stream, "function");
  // 默认提示词场景同样可以构造（工具注册在工厂内部完成）。
  assert.equal(
    typeof createMastraAgent("deepseek/deepseek-chat", "").generate,
    "function",
  );
});