/**
 * ACP Runner：通过 stdio 驱动 Agent Client Protocol server，完成初始化、
 * 会话新建/恢复、流式事件翻译与取消收尾，供 DimAgent 的 acp 接入模式使用。
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { resolveCliCommand } from "./command-resolver.js";
import { stopProcessTree } from "./process-tree.js";
import type { RunCliOptions } from "./runner.js";
import type { CliEvent, CliRunResult, CliRunStats } from "./types.js";

const TOOL_LABELS: Record<string, string> = {
  read: "读取文件",
  edit: "修改文件",
  delete: "删除文件",
  move: "移动文件",
  search: "搜索代码",
  execute: "运行命令",
  think: "分析任务",
  fetch: "读取网页",
  switch_mode: "切换模式",
  other: "调用工具",
};

/** ACP 失败时保留已经创建或恢复的 session ID，供会话层持久化。 */
export class AcpRunError extends Error {
  constructor(
    message: string,
    readonly sessionId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AcpRunError";
  }
}

function statsFromUsage(usage: acp.Usage | null | undefined): CliRunStats | undefined {
  if (!usage) return undefined;
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedReadTokens !== undefined && usage.cachedReadTokens !== null
      ? { cacheReadTokens: usage.cachedReadTokens }
      : {}),
    ...(usage.cachedWriteTokens !== undefined && usage.cachedWriteTokens !== null
      ? { cacheCreationTokens: usage.cachedWriteTokens }
      : {}),
  };
}

function permissionResponse(
  params: acp.RequestPermissionRequest,
): acp.RequestPermissionResponse {
  // 飞书任务没有同步审批通道；与 dim exec 的 full-access 默认行为一致，
  // 优先选择允许选项，不能安全选择时明确取消本次请求。
  const option =
    params.options.find((item) => item.kind === "allow_always") ??
    params.options.find((item) => item.kind === "allow_once");
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function toolEventLabel(update: acp.ToolCall | acp.ToolCallUpdate): string {
  return TOOL_LABELS[update.kind ?? "other"] ?? "调用工具";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** 执行一轮 ACP prompt；每轮独立启动 server，并用 session/resume 或 load 续接上下文。 */
export async function runAcp(options: RunCliOptions): Promise<CliRunResult> {
  const { adapter, prompt, cwd, sessionId, signal, timeoutMs, onEvent } = options;
  if (signal?.aborted) {
    throw new Error(`${adapter.displayName} 执行已取消`);
  }

  const executable = resolveCliCommand(adapter.command);
  const child = spawn(
    executable.command,
    [...executable.argsPrefix, ...adapter.buildArgs("")],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  let observedSessionId = sessionId;
  let answer = "";
  let observedStats: CliRunStats | undefined;
  let collecting = false;
  let observerError: Error | undefined;
  let workflowFinished = false;
  const startedTools = new Set<string>();
  const completedTools = new Set<string>();

  const emit = (event: CliEvent) => {
    try {
      onEvent?.(event);
    } catch (error) {
      observerError = asError(error);
    }
  };

  const app = acp
    .client({ name: "agent-os" })
    .onRequest(acp.methods.client.session.requestPermission, (context) =>
      permissionResponse(context.params),
    )
    .onNotification(acp.methods.client.session.update, (context) => {
      const { sessionId: updateSessionId, update } = context.params;
      if (!collecting || updateSessionId !== observedSessionId) return;

      if (update.sessionUpdate === "agent_message_chunk") {
        if (update.content.type === "text") answer += update.content.text;
        return;
      }
      if (update.sessionUpdate === "usage_update") {
        emit({ type: "context", usedTokens: update.used });
        observedStats = {
          ...observedStats,
          contextUsedTokens: update.used,
          contextWindowTokens: update.size,
        };
        return;
      }
      if (update.sessionUpdate === "tool_call") {
        if (!startedTools.has(update.toolCallId)) {
          startedTools.add(update.toolCallId);
          emit({
            type: "tool_start",
            toolUseId: update.toolCallId,
            toolName: update.name ?? update.kind ?? "Tool",
            label: toolEventLabel(update),
            detail: update.title,
          });
        }
        if (
          !completedTools.has(update.toolCallId) &&
          (update.status === "completed" || update.status === "failed")
        ) {
          completedTools.add(update.toolCallId);
          emit({
            type: "tool_end",
            toolUseId: update.toolCallId,
            failed: update.status === "failed",
          });
        }
        return;
      }
      if (update.sessionUpdate !== "tool_call_update") return;
      if (!startedTools.has(update.toolCallId)) {
        startedTools.add(update.toolCallId);
        emit({
          type: "tool_start",
          toolUseId: update.toolCallId,
          toolName: update.name ?? update.kind ?? "Tool",
          label: toolEventLabel(update),
          ...(update.title ? { detail: update.title } : {}),
        });
      }
      if (
        !completedTools.has(update.toolCallId) &&
        (update.status === "completed" || update.status === "failed")
      ) {
        completedTools.add(update.toolCallId);
        emit({
          type: "tool_end",
          toolUseId: update.toolCallId,
          failed: update.status === "failed",
        });
      }
    });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const workflow = app.connectWith(stream, async (agent) => {
    const initialized = await agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: "agent-os",
        title: "Agent OS",
        version: "0.1.0",
      },
    });

    if (observedSessionId) {
      const canResume = initialized.agentCapabilities?.sessionCapabilities?.resume;
      if (canResume) {
        await agent.request(acp.methods.agent.session.resume, {
          sessionId: observedSessionId,
          cwd,
          mcpServers: [],
        });
      } else if (initialized.agentCapabilities?.loadSession) {
        await agent.request(acp.methods.agent.session.load, {
          sessionId: observedSessionId,
          cwd,
          mcpServers: [],
        });
      } else {
        throw new Error("DimAgent ACP server 不支持恢复已有会话");
      }
    } else {
      const created = await agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      observedSessionId = created.sessionId;
      emit({ type: "session", sessionId: created.sessionId });
    }

    collecting = true;
    const response = await agent.request(acp.methods.agent.session.prompt, {
      sessionId: observedSessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    collecting = false;
    observedStats = {
      ...observedStats,
      ...statsFromUsage(response.usage),
    };
    if (observerError) throw observerError;
    if (response.stopReason === "cancelled") {
      throw new Error(`${adapter.displayName} 执行已取消`);
    }
    if (!answer) throw new Error(`${adapter.displayName} 没有返回最终结果`);
    emit({
      type: "result",
      answer,
      sessionId: observedSessionId,
      ...(observedStats ? { stats: observedStats } : {}),
    });
    return {
      answer,
      sessionId: observedSessionId,
      ...(observedStats ? { stats: observedStats } : {}),
    };
  });

  let timeout: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error(`${adapter.displayName} 执行已取消`));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (timeoutMs !== undefined) {
      timeout = setTimeout(
        () => reject(new Error(`${adapter.displayName} 执行超时`)),
        timeoutMs,
      );
    }
  });
  const exited = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (workflowFinished) return;
      reject(
        new Error(stderr.trim() || `${adapter.displayName} ACP server 提前退出，状态码 ${code}`),
      );
    });
  });

  try {
    const result = await Promise.race([workflow, interrupted, exited]);
    workflowFinished = true;
    return result;
  } catch (error) {
    throw observedSessionId
      ? new AcpRunError(asError(error).message, observedSessionId, { cause: error })
      : error;
  } finally {
    workflowFinished = true;
    collecting = false;
    if (timeout) clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
    await stopProcessTree(child);
    void workflow.catch(() => undefined);
  }
}
