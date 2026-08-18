/**
 * 定时任务周期解析：把用户提供的 5 段 cron 表达式或简化自然语言周期
 * 统一转换为 croner 可执行的 cron 表达式与人类可读描述。
 * 纯函数模块，由 schedule 服务插件复用，不依赖框架。
 */
import { Cron } from "croner";

/** 解析后的调度规格：croner 表达式 + 用于 /schedule list 展示的描述。 */
export interface ScheduleSpec {
  expr: string;
  display: string;
}

/** “每 N 分钟/小时/天”，N 为 1-3 位数字。 */
const EVERY_RE = /^每\s*(\d{1,3})\s*(分钟|小时|天)$/;
/** “每天[早上/上午/中午/下午/晚上] N [点|:MM]”，时间可省略。 */
const DAILY_TIME_RE =
  /^每天(?:早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:\s*[:：]\s*(\d{1,2}))?(?:\s*点(?:半)?)?$/;
const EVERY_HOUR_RE = /^每小时$/;
/** 只允许数字、星号、逗号、斜杠、连字符和空格构成的 5 段 cron。 */
const CRON_RE = /^[\d*,/\-\s]+$/;

function isFivePartCron(input: string): boolean {
  if (!CRON_RE.test(input)) return false;
  return input.trim().split(/\s+/).length === 5;
}

/** 校验 5 段 cron 是否可被 croner 接受，无效时抛出可读错误。 */
function validateCron(expr: string): void {
  try {
    new Cron(expr);
  } catch (error) {
    throw new Error(`cron 表达式无效（${(error as Error).message}）`);
  }
}

/**
 * 解析周期配置；无法识别时抛出中文错误。
 * 支持：5 段 cron（如 "0 9 * * *"）、"每 N 分钟/小时/天"、"每小时"、"每天[时间]"。
 */
export function parseSchedule(input: string): ScheduleSpec {
  const text = input.trim();
  if (!text) throw new Error("周期不能为空");

  if (isFivePartCron(text)) {
    validateCron(text);
    return { expr: text, display: text };
  }

  const every = EVERY_RE.exec(text);
  if (every) {
    const amount = Number(every[1]);
    const unit = every[2];
    // “每 N 分钟”转成从 0 分起步的步进表达式，与 botmux 的墙钟对齐语义一致。
    if (unit === "分钟") {
      if (amount < 1 || amount > 59) {
        throw new Error(`“每 N 分钟”的 N 需在 1-59 之间`);
      }
      return { expr: `*/${amount} * * * *`, display: `每 ${amount} 分钟` };
    }
    if (unit === "小时") {
      if (amount < 1 || amount > 24) {
        throw new Error(`“每 N 小时”的 N 需在 1-24 之间`);
      }
      return { expr: `0 */${amount} * * *`, display: `每 ${amount} 小时` };
    }
    if (amount < 1 || amount > 30) {
      throw new Error(`“每 N 天”的 N 需在 1-30 之间`);
    }
    return { expr: `0 0 */${amount} * *`, display: `每 ${amount} 天` };
  }

  if (EVERY_HOUR_RE.test(text)) {
    return { expr: "0 * * * *", display: "每小时" };
  }

  if (text === "每天") {
    return { expr: "0 0 * * *", display: "每天 00:00" };
  }

  const daily = DAILY_TIME_RE.exec(text);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = daily[2] ? Number(daily[2]) : 0;
    if (hour > 23) throw new Error("小时需在 0-23 之间");
    if (minute > 59) throw new Error("分钟需在 0-59 之间");
    return {
      expr: `${minute} ${hour} * * *`,
      display: `每天 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    };
  }

  throw new Error(
    `无法识别的周期：${input}。支持 cron（如 "0 9 * * *"）或自然语言（如 "每 30 分钟"、"每天 9:00"）。`,
  );
}
