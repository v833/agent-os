/**
 * AI CLI 事件适配层：把 Codex 与 Claude Code 的 JSONL 事件
 * 收敛成统一、适合日志和飞书卡片展示的中文时间线文本。
 */
type JsonObject = Record<string, unknown>;

/** 外部 CLI 事件不可信，读取字段前先确认它确实是普通对象。 */
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function value(value: unknown): string {
  return value === undefined ? "未知" : String(value);
}

export function formatCliEvent(event: unknown): string[] {
  if (!isObject(event) || typeof event.type !== "string") return [];

  switch (event.type) {
    // ── Codex（主路径）──
    case "thread.started":
      return [`会话开始 thread_id=${value(event.thread_id)}`];

    case "item.completed": {
      if (!isObject(event.item)) return [];
      if (event.item.type === "agent_message" && event.item.text) {
        return [`模型说: ${String(event.item.text)}`];
      }
      if (event.item.type === "command_execution" && event.item.command) {
        return [`执行命令: ${String(event.item.command)}`];
      }
      return [];
    }

    case "turn.completed":
      return [`完成 tokens=${JSON.stringify(event.usage ?? {})}`];

    // ── Claude Code ──
    case "system":
      if (event.subtype !== "init") return [];
      return [
        `会话开始 session_id=${value(event.session_id)} model=${value(event.model)}`,
      ];

    case "assistant": {
      if (!isObject(event.message) || !Array.isArray(event.message.content)) {
        return [];
      }

      const messages: string[] = [];
      for (const block of event.message.content) {
        if (!isObject(block)) continue;
        if (block.type === "text" && block.text) {
          messages.push(`模型说: ${String(block.text)}`);
        }
        if (block.type === "tool_use") {
          messages.push(`调用工具: ${value(block.name)}`);
        }
      }
      return messages;
    }

    case "result":
      // Mastra 引擎的 result 直接携带最终回答与用量；Claude 的 result 携带账单与正文。
      if (typeof event.answer === "string") {
        const stats = isObject(event.stats) ? event.stats : {};
        const hasTokens =
          typeof stats.inputTokens === "number" ||
          typeof stats.outputTokens === "number";
        return [
          `最终回答: ${event.answer}${hasTokens ? ` tokens=${JSON.stringify(stats)}` : ""}`,
        ];
      }
      return [
        `完成 turns=${value(event.num_turns)} 耗时=${value(event.duration_ms)}ms 成本=${"$"}${value(event.total_cost_usd)}`,
        `最终回答: ${value(event.result)}`,
      ];

    // ── Mastra Agent ──
    case "tool_start":
      return [
        `调用工具: ${value(event.toolName)}${
          typeof event.detail === "string" && event.detail
            ? ` detail=${event.detail}`
            : ""
        }`,
      ];

    case "tool_end":
      return [`工具结束 failed=${event.failed === true}`];

    case "error":
      return [`错误: ${typeof event.message === "string" ? event.message : "未知错误"}`];

    default:
      return [];
  }
}

export function parseCliEventLine(line: string): string[] {
  try {
    return formatCliEvent(JSON.parse(line));
  } catch {
    // CLI 重连或诊断日志可能混入 stdout；噪音行不能中断整条事件流。
    return [];
  }
}
