/**
 * DimAgent 适配器：把 `dim exec --json` 的 headless 输出接入 Agent OS。
 * DimAgent 的 ACP 接入由通用 AcpAdapter（engines/acp 插件）提供，不再内嵌于此。
 */
import type {
  CliAccessMode,
  CliAdapter,
  CliCompactPlan,
  CliEvent,
  CliRunStats,
} from "./types.js";

interface DimagentEvent {
  type?: unknown;
  subtype?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  id?: unknown;
  toolUseId?: unknown;
  tool_use_id?: unknown;
  toolName?: unknown;
  tool_name?: unknown;
  name?: unknown;
  title?: unknown;
  label?: unknown;
  detail?: unknown;
  command?: unknown;
  answer?: unknown;
  result?: unknown;
  text?: unknown;
  message?: unknown;
  error?: unknown;
  usage?: unknown;
  stats?: unknown;
  item?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  const text = asString(value)?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 1)}…`
    : text;
}

function nestedRecord(event: DimagentEvent, key: "usage" | "stats" | "item") {
  const value = event[key];
  return isRecord(value) ? value : undefined;
}

function parseStats(event: DimagentEvent): CliRunStats | undefined {
  const usage = nestedRecord(event, "usage") ?? nestedRecord(event, "stats");
  if (!usage) return undefined;
  const inputTokens = asNumber(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = asNumber(usage.outputTokens ?? usage.output_tokens);
  const totalTokens = asNumber(usage.totalTokens ?? usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined
      ? { totalTokens }
      : { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function sessionIdOf(event: DimagentEvent): string | undefined {
  return asString(event.sessionId ?? event.session_id);
}

function toolIdOf(event: DimagentEvent): string | undefined {
  return asString(event.toolUseId ?? event.tool_use_id ?? event.id);
}

function eventTypeOf(event: DimagentEvent): string {
  return `${asString(event.type) ?? ""}:${asString(event.subtype) ?? ""}`.toLowerCase();
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.text === "string") return value.text;
  if (!Array.isArray(value.content)) return undefined;
  const text = value.content
    .filter(isRecord)
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("");
  return text || undefined;
}

/** DimAgent 的 headless 适配器；ACP 接入见 AcpAdapter。 */
export class DimagentAdapter implements CliAdapter {
  readonly id = "dimagent" as const;
  readonly command = process.env.DIMAGENT_COMMAND?.trim() || "dim";
  readonly displayName = "DimAgent";
  readonly accessMode: CliAccessMode = "headless";

  buildArgs(prompt: string): string[] {
    return ["exec", "--json", "--policy", "full-access", prompt];
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ["exec", "resume", "--json", sessionId, prompt];
  }

  buildCompactPlan(_sessionId: string, _instructions?: string): CliCompactPlan {
    throw new Error("DimAgent 暂不支持原生 /compact，请在话题中发起整理任务");
  }

  parseEvents(line: string): CliEvent[] {
    let event: DimagentEvent;
    try {
      event = JSON.parse(line) as DimagentEvent;
    } catch {
      return [];
    }

    const events: CliEvent[] = [];
    const sessionId = sessionIdOf(event);
    if (sessionId) events.push({ type: "session", sessionId });

    const type = eventTypeOf(event);
    const item = nestedRecord(event, "item");
    const source = (item ? { ...event, ...item } : event) as DimagentEvent &
      Record<string, unknown>;
    const toolId = toolIdOf(source);
    const toolName = asString(source.toolName ?? source.tool_name ?? source.name);
    const isToolStart =
      toolId &&
      (type.includes("tool_start") ||
        type.includes("tool.started") ||
        type.includes("tool_call"));
    const isToolEnd =
      toolId &&
      (type.includes("tool_end") ||
        type.includes("tool.completed") ||
        type.includes("tool_result"));
    if (isToolStart && !type.includes("result")) {
      events.push({
        type: "tool_start",
        toolUseId: toolId,
        toolName: toolName ?? "Tool",
        label: shortText(source.label ?? source.title) ?? `调用 ${toolName ?? "工具"}`,
        ...(shortText(source.detail ?? source.command)
          ? { detail: shortText(source.detail ?? source.command) }
          : {}),
      });
    } else if (isToolEnd) {
      events.push({
        type: "tool_end",
        toolUseId: toolId,
        failed: source.failed === true || source.status === "failed",
      });
    }

    const isError = type.includes("error") || source.error !== undefined;
    if (isError) {
      const error = isRecord(source.error) ? source.error.message : source.error;
      events.push({
        type: "error",
        message: asString(error ?? source.message) ?? "DimAgent 执行失败",
        ...(sessionId ? { sessionId } : {}),
      });
    }

    const answer =
      contentText(source.answer) ??
      contentText(source.result) ??
      contentText(source.text) ??
      (type.includes("assistant") ? contentText(source.message) : undefined);
    const isResult =
      type.includes("result") ||
      type.includes("completed") ||
      type.includes("turn.completed");
    if (answer !== undefined && isResult && !isToolEnd) {
      events.push({
        type: "result",
        answer,
        ...(sessionId ? { sessionId } : {}),
        ...(parseStats(event) ? { stats: parseStats(event) } : {}),
      });
    }
    const stats = parseStats(event);
    if (stats && !events.some((item) => item.type === "result")) {
      if (stats.inputTokens !== undefined) {
        events.push({ type: "context", usedTokens: stats.inputTokens });
      }
      events.push({ type: "result", answer: "", stats });
    }
    return events;
  }

  isSessionUnavailable(message: string): boolean {
    return (
      /(?:session|conversation)[^\n]*(?:not found|does not exist|expired|invalid|unknown)/i.test(
        message,
      ) ||
      /no (?:such )?(?:session|conversation)\b/i.test(message) ||
      /ACP server 不支持恢复已有会话/.test(message)
    );
  }
}
