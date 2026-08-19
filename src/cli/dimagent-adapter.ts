/**
 * DimAgent 适配器：把 `dim exec --json` 的 headless 输出接入 Agent OS。
 * DimAgent 的 ACP 接入由通用 AcpAdapter（engines/acp 插件）提供，不再内嵌于此。
 * 注意：dim 0.3.x 的 JSONL 事件格式是 eventType/payload 结构（text:delta 增量、run:ended 收尾），
 * 最终答案跨多行累积，因此本适配器按会话 ID 维护跨行状态（每轮 headless 独占一个会话/进程）。
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
  eventType?: unknown;
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
  payload?: unknown;
}

/** 工具名到进度卡展示文案的映射；未命中时回退为“调用 <工具名>”。 */
const TOOL_LABELS: Record<string, string> = {
  read: "读取文件",
  edit: "修改文件",
  write: "写入文件",
  delete: "删除文件",
  move: "移动文件",
  search: "搜索代码",
  glob: "查找文件",
  grep: "搜索内容",
  exec: "运行命令",
  think: "分析任务",
  fetch: "读取网页",
  WebSearch: "网页搜索",
  WebFetch: "读取网页",
  skill: "加载技能",
  agent: "子代理",
};

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

/** 从工具入参提取进度卡明细：优先 command 字段，其次整体 JSON 摘要。 */
function toolInputDetail(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (isRecord(input)) {
    if (typeof input.command === "string") return input.command;
    return JSON.stringify(input);
  }
  return undefined;
}

/** 把 dim 的 usage（promptTokens/completionTokens/totalTokens）转成统一统计结构。 */
function statsFromUsage(usage: unknown): CliRunStats | undefined {
  if (!isRecord(usage)) return undefined;
  const inputTokens = asNumber(usage.promptTokens);
  const outputTokens = asNumber(usage.completionTokens);
  const totalTokens = asNumber(usage.totalTokens);
  const cacheReadTokens = asNumber(usage.cacheReadTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined
      ? { totalTokens }
      : { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  };
}

/** 单个进行中 run 的跨行累积状态；key 为 dim 会话 ID（headless 每 run 独立会话）。 */
interface DimRunState {
  answer: string;
  sessionEmitted: boolean;
}

/** DimAgent 的 headless 适配器；ACP 接入见 AcpAdapter。 */
export class DimagentAdapter implements CliAdapter {
  readonly id = "dimagent" as const;
  readonly command = process.env.DIMAGENT_COMMAND?.trim() || "dim";
  readonly displayName = "DimAgent";
  readonly accessMode: CliAccessMode = "headless";

  private readonly runStates = new Map<string, DimRunState>();

  buildArgs(prompt: string): string[] {
    return ["exec", "--json", "--policy", "full-access", prompt];
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ["exec", "resume", "--json", sessionId, prompt];
  }

  buildCompactPlan(_sessionId: string, _instructions?: string): CliCompactPlan {
    throw new Error("DimAgent 暂不支持原生 /compact，请在话题中发起整理任务");
  }

  /**
   * 解析 dim 0.3.x 的 JSONL 事件（eventType/payload 结构）。
   * 文本答案通过 text:delta 增量跨行累积，run:ended 时一次性发出 result；
   * 因适配器是全局单例、多轮任务并发共享，状态按会话 ID 隔离，run:ended 后即清理。
   */
  parseEvents(line: string): CliEvent[] {
    let event: DimagentEvent;
    try {
      event = JSON.parse(line) as DimagentEvent;
    } catch {
      return [];
    }

    const sessionId = asString(event.sessionId ?? event.session_id);
    const type = `${asString(event.eventType) ?? asString(event.type) ?? ""}`;
    const payload = isRecord(event.payload) ? event.payload : {};
    const events: CliEvent[] = [];

    // run:accepted 是每个 run 的首事件，此时创建累积状态并尽早发出会话事件，
    // 让 Runner 在后续失败时也能把错误包装成可续聊的 CliRunError。
    if (type === "run:accepted") {
      if (sessionId && !this.runStates.has(sessionId)) {
        this.runStates.set(sessionId, { answer: "", sessionEmitted: false });
        events.push({ type: "session", sessionId });
        this.runStates.get(sessionId)!.sessionEmitted = true;
      }
    }
    const state = sessionId ? this.runStates.get(sessionId) : undefined;

    if (type === "run:started" && state) {
      // 新一轮 run 重新累积答案；续聊的会话也在本进程重新输出全部 text:delta。
      state.answer = "";
    } else if (type === "text:delta" && state && typeof payload.delta === "string") {
      state.answer += payload.delta;
    } else if (type === "context:usage") {
      if (typeof payload.usedTokens === "number") {
        events.push({ type: "context", usedTokens: payload.usedTokens });
      }
    } else if (type === "tool:started") {
      const toolUseId = asString(payload.toolCallId);
      const toolName = asString(payload.toolName) ?? "Tool";
      if (toolUseId) {
        events.push({
          type: "tool_start",
          toolUseId,
          toolName,
          label: TOOL_LABELS[toolName] ?? `调用 ${toolName}`,
          ...(shortText(toolInputDetail(payload.toolInput))
            ? { detail: shortText(toolInputDetail(payload.toolInput)) }
            : {}),
        });
        // tool_call 让 Runner 记录本轮成功调用的应用工具（失败的会在 tool_end 剔除）。
        events.push({
          type: "tool_call",
          toolUseId,
          toolName,
          input: payload.toolInput,
        });
      }
    } else if (type === "tool:completed") {
      const toolUseId = asString(payload.toolCallId);
      if (toolUseId) {
        const toolResult = isRecord(payload.toolResult) ? payload.toolResult : undefined;
        events.push({
          type: "tool_end",
          toolUseId,
          failed: toolResult?.isError === true,
        });
      }
    } else if (type === "run:ended") {
      const status = asString(payload.status) ?? "";
      const reason = asString(payload.reason) ?? "";
      const failed =
        status === "failed" || status === "error" || status === "cancelled" || reason === "error";
      if (failed) {
        events.push({
          type: "error",
          message: `DimAgent 执行未完成（${status || reason || "unknown"}）`,
          ...(sessionId ? { sessionId } : {}),
        });
      } else if (state) {
        events.push({
          type: "result",
          answer: state.answer,
          ...(sessionId ? { sessionId } : {}),
          ...(statsFromUsage(payload.usage) ? { stats: statsFromUsage(payload.usage) } : {}),
        });
      }
      if (sessionId) this.runStates.delete(sessionId);
    }

    // 累积状态回写（run:ended 已在上面清理，避免重新插入导致泄漏）。
    if (sessionId && state && type !== "run:ended") {
      this.runStates.set(sessionId, state);
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
