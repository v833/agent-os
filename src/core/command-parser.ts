/**
 * 会话命令解析器：识别控制命令和新话题的执行引擎前缀，
 * 防止普通任务文本中偶然出现斜杠字样时误触发控制或切换操作。
 */
import type { CliId } from "../cli/types.js";

export type SlashCommand =
  | { name: "close" | "status" | "help" | "new" | "resume" }
  | { name: "compact"; instructions?: string }
  | { name: "cd"; path?: string };

// 飞书还原提及后可能得到“@机器人名称 /status”，机器人名称允许包含空格。
const COMMAND_RE = /^(?:@.+\s+)?\/(close|status|help|new|resume)\s*$/;
const CD_RE = /^(?:@.+\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/;
const COMPACT_RE = /^(?:@.+\s+)?\/compact(?:\s+([\s\S]+?))?\s*$/;
const CLI_REQUEST_RE =
  /^(?:@\S+\s+)?\/(claude|codex|dimagent)(?:\s+([\s\S]*))?$/;

function stripLeadingMention(
  text: string,
  leadingMentionName: string | undefined,
): string {
  const trimmed = text.trim();
  if (!leadingMentionName) return trimmed;
  const prefix = `@${leadingMentionName}`;
  if (!trimmed.startsWith(prefix)) return trimmed;
  const remainder = trimmed.slice(prefix.length);
  // 精确名称之后必须有空白，避免把短名称误匹配成长名称前缀。
  return /^\s/.test(remainder) ? remainder.trimStart() : trimmed;
}

/** 解析受支持的会话命令；普通文本返回 undefined。 */
export function parseCommand(text: string): SlashCommand | undefined {
  const value = text.trim();
  const cdMatch = CD_RE.exec(value);
  if (cdMatch) return { name: "cd", path: cdMatch[1]?.trim() || undefined };

  const compactMatch = COMPACT_RE.exec(value);
  if (compactMatch) {
    return {
      name: "compact",
      instructions: compactMatch[1]?.trim() || undefined,
    };
  }

  const match = COMMAND_RE.exec(value);
  if (!match) return undefined;
  return {
    name: match[1] as "close" | "status" | "help" | "new" | "resume",
  };
}

export interface CliRequest {
  cliId: CliId;
  prompt: string;
}

/** 解析消息开头的引擎选择；精确提及名称允许包含空格。 */
export function parseCliRequest(
  text: string,
  leadingMentionName?: string,
): CliRequest | undefined {
  const match = CLI_REQUEST_RE.exec(
    stripLeadingMention(text, leadingMentionName),
  );
  if (!match) return undefined;
  return {
    cliId: match[1] as CliId,
    prompt: (match[2] ?? "").trim(),
  };
}
