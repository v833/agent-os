/**
 * 会话命令解析器：只识别完整独立的斜杠命令，
 * 防止普通任务文本中偶然出现“/status”等字样时误触发控制操作。
 */
export type CommandName = "close" | "status" | "help";

export interface SlashCommand {
  name: CommandName;
}

// 飞书还原提及后可能得到“@机器人名称 /status”，机器人名称允许包含空格。
const COMMAND_RE = /^(?:@.+\s+)?\/(close|status|help)\s*$/;

/** 解析受支持的会话命令；普通文本返回 undefined。 */
export function parseCommand(text: string): SlashCommand | undefined {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return undefined;
  return { name: match[1] as CommandName };
}
