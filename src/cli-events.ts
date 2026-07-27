type JsonObject = Record<string, unknown>;

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
      return [
        `完成 turns=${value(event.num_turns)} 耗时=${value(event.duration_ms)}ms 成本=$${value(event.total_cost_usd)}`,
        `最终回答: ${value(event.result)}`,
      ];

    default:
      return [];
  }
}

export function parseCliEventLine(line: string): string[] {
  try {
    return formatCliEvent(JSON.parse(line));
  } catch {
    return [];
  }
}
