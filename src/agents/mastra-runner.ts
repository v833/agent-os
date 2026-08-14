/**
 * Mastra 子进程入口：由 MastraAdapter 以 node + tsx 方式拉起，独立完成
 * 一次 Agent 任务，把文本流、工具调用与用量以 JSON randomness 事件写到 stdout。
 * 采用子进程包装是为了完全复用 Agent OS 现有的 CliAdapter 契约和 Runner
 * 生命周期管理（超时、取消、进程树清理），不引入第二套调度链路。
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMastraAgent } from "./mastra-agent.js";

// 子进程的 cwd 是话题工作目录，未必是项目根；必须显式加载项目根 .env，
// 否则 MASTRA_MODEL、API Key 等配置会全部丢失（已有环境变量不被覆盖）。
// quiet 防止 dotenv 的横幅日志污染 stdout 的 JSON Hank 事件流。
loadEnv({
  path: resolve(import.meta.dirname, "..", "..", ".env"),
  override: false,
  quiet: true,
});

/** runner 与 CliAdapter 之间的 HankL 事件协议；与 CliEvent 同构。 */
export type RunnerEvent =
  | {
      type: "tool-start";
      toolUseId: string;
      toolName: string;
      label: string;
      detail?: string;
    }
  | { type: "tool-end"; toolUseId: string; failed: boolean }
  | {
      type: "result";
      answer: string;
      stats?: { inputTokens?: number; outputTokens?: number };
    }
  | { type: "error"; message: string };

function emit(event: RunnerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "读取文件",
  write_file: "写入文件",
  run_command: "运行命令",
};

function toolDetail(toolName: string, args: unknown): string | undefined {
  const record = args as Record<string, unknown> | undefined;
  if (toolName === "read_file" || toolName === "write_file") {
    return shortText(record?.path);
  }
  if (toolName === "run_command") {
    return shortText(record?.command);
  }
  return undefined;
}

/** Mastra fullStream chunk 到统一工具的翻译结果；事件协议与 RunnerEvent 完全一致。 */
// 已经直接复用 RunnerEvent，不再维护第二套事件类型（ParsedToolEvent 已删除，避免两套协议漂移）。

/**
 * 把 Mastra fullStream 的单个 chunk 翻译成 0..n 个统一工具事件。
 * 单独导出便于不依赖真实 LLM 的单元测试，工具失败分支也在此覆盖。
 * 直接复用 RunnerEvent，让解析结果与 Runner 契约保持同一个类型来源。
 */
export function parseMastraChunk(
  chunk: { type?: unknown; payload?: unknown },
  labels: Record<string, string>,
  detailOf: (toolName: string, args: unknown) => string | undefined,
): RunnerEvent[] {
  const payload = chunk.payload as Record<string, unknown> | undefined;
  if (chunk.type === "tool-call" && payload) {
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
    const label = labels[toolName] ?? `调用 ${toolName}`;
    const detail = toolName ? detailOf(toolName, payload.args) : undefined;
    return [
      {
        type: "tool-start",
        toolUseId: toolCallId,
        toolName,
        label,
        ...(detail ? { detail } : {}),
      },
    ];
  }
  if (chunk.type === "tool-result" && payload) {
    return [
      {
        type: "tool-end",
        toolUseId:
          typeof payload.toolCallId === "string" ? payload.toolCallId : "",
        failed: payload.isError === true,
      },
    ];
  }
  if (chunk.type === "tool-error" && payload) {
    return [
      {
        type: "tool-end",
        toolUseId:
          typeof payload.toolCallId === "string" ? payload.toolCallId : "",
        failed: true,
      },
    ];
  }
  return [];
}

/**
 * 消费 fullStream 的所有 chunk：工具 chunk 即时翻译成 tool_start /
 * tool_end 让飞书卡片展示实时进度，结束时汇总文本与用量。
 */
async function runOnce(
  model: string,
  systemPrompt: string,
  prompt: string,
): Promise<void> {
  const agent = createMastraAgent(model, systemPrompt);
  const stream = await agent.stream(prompt);

  for await (const chunk of stream.fullStream) {
    for (const event of parseMastraChunk(chunk, TOOL_LABELS, toolDetail)) {
      emit(event);
    }
  }

  // Mastra 全流没有 result 事件（已实锤）→ 补发 result，与 claude/codex runner 对齐：
  // 它们靠 adapter 的 parseEvents 在 close 时把 finish 汇总成 result。
  emit({
    type: "result",
    answer: (await stream.text) ?? "",
  });

  const answer = (await stream.text) ?? "";
  if (!answer.trim()) {
    // 工具全部完成后文本为空，通常是流提前中断或模型只输出思考内容；
    // 必须把底层原因带出来，避免用户在飞书只看到一句笼统提示。
    const finishReason = await stream.finishReason.catch(() => undefined);
    if (stream.error) {
      emit({
        type: "error",
        message: `Mastra 流提前中断：${stream.error.message}`,
      });
    } else {
      const reasoning = await stream.reasoningText.catch(() => undefined);
      if (reasoning?.trim()) {
        emit({
          type: "result",
          answer: `（模型只输出了思考内容，没有正式回答）\n\n${reasoning.trim()}`,
        });
        return;
      }
      emit({
        type: "error",
        message: `Mastra Agent 没有返回最终结果（finishReason=${finishReason ?? "未知"}）`,
      });
    }
    process.exitCode = 1;
    return;
  }

  // 用量统计是可选信息：解析失败时保留已获得的文本答案，只丢弃统计。
  let stats: { inputTokens?: number; outputTokens?: number } | undefined;
  try {
    const usage = await stream.totalUsage;
    const input = usage?.inputTokens;
    const output = usage?.outputTokens;
    if (typeof input === "number" || typeof output === "number") {
      stats = {
        ...(typeof input === "number" ? { inputTokens: input } : {}),
        ...(typeof output === "number" ? { outputTokens: output } : {}),
      };
    }
  } catch {
    stats = undefined;
  }
  emit({ type: "result", answer, ...(stats ? { stats } : {}) });
}

// ── 入口副作用：只允许直接运行时执行 ──
// 测试（tsx --test）import 本文件会导致 process.argv 没有任务文本，
// 必须用 ESM 入口守卫包住，否则测试进程启动即退出。
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const prompt = process.argv[2]?.trim();
  if (!prompt) {
    emit({ type: "error", message: "缺少任务文本：mastra-runner <prompt>" });
    process.exit(1);
  }
  const model = process.env.MASTRA_MODEL?.trim();
  if (!model) {
    emit({
      type: "error",
      message:
        "缺少 MASTRA_MODEL 配置。请在 .env 中填写模型路由，例如 openai/gpt-5.6-sol、deepseek/deepseek-chat，并配置对应 provider 的 API Key 环境变量。",
    });
    process.exit(1);
  }
  if (!model.includes("/")) {
    emit({
      type: "error",
      message: `MASTRA_MODEL 格式错误：${model}。模型路由需要带 provider 前缀，例如 deepseek/${model}。`,
    });
    process.exit(1);
  }

  runOnce(model, process.env.MASTRA_SYSTEM_PROMPT ?? "", prompt).catch((error) => {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}