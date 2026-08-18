/**
 * 会话命令解析器：识别控制命令和新话题的执行引擎前缀，
 * 防止普通任务文本中偶然出现斜杠字样时误触发控制或切换操作。
 */
import type { CliId } from "../cli/types.js";

export type SlashCommand =
  | { name: "close" | "status" | "help" | "new" | "resume" }
  | { name: "compact"; instructions?: string }
  | { name: "cd"; path?: string }
  | { name: "schedule"; action: "add"; schedule: string; prompt: string }
  | { name: "schedule"; action: "list" }
  | { name: "schedule"; action: "remove"; id: string };

// 飞书还原提及后可能得到“@机器人名称 /status”，机器人名称允许包含空格。
const COMMAND_RE = /^(?:@.+\s+)?\/(close|status|help|new|resume)\s*$/;
const CD_RE = /^(?:@.+\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/;
const COMPACT_RE = /^(?:@.+\s+)?\/compact(?:\s+([\s\S]+?))?\s*$/;
const CLI_REQUEST_RE =
  /^(?:@\S+\s+)?\/(claude|codex|dimagent)(?:\s+([\s\S]*))?$/;
// /schedule add 的周期用双引号包裹，避免任务文本里出现斜杠时误切分。
const SCHEDULE_ADD_RE =
  /^(?:@.+\s+)?\/schedule add\s+"([^"]+)"\s+([\s\S]+?)\s*$/;
const SCHEDULE_REMOVE_RE = /^(?:@.+\s+)?\/schedule remove\s+([^\s]+?)\s*$/;
const SCHEDULE_LIST_RE = /^(?:@.+\s+)?\/schedule\s+list\s*$/;

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

  const scheduleAddMatch = SCHEDULE_ADD_RE.exec(value);
  if (scheduleAddMatch) {
    return {
      name: "schedule",
      action: "add",
      schedule: scheduleAddMatch[1],
      prompt: scheduleAddMatch[2].trim(),
    };
  }
  const scheduleRemoveMatch = SCHEDULE_REMOVE_RE.exec(value);
  if (scheduleRemoveMatch) {
    // 兼容用户带 # 前缀的写法（如 #sched-001）。
    return {
      name: "schedule",
      action: "remove",
      id: scheduleRemoveMatch[1].replace(/^#/, ""),
    };
  }
  const scheduleListMatch = SCHEDULE_LIST_RE.exec(value);
  if (scheduleListMatch) {
    return { name: "schedule", action: "list" };
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
