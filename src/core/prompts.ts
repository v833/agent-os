/**
 * 提示词管理领域模型与核心注册表：纯函数与模板引擎，
 * 提供模板注册、Zod 参数校验、{{var}} 插值、Markdown 文件模板解析、
 * 分层覆盖与 PromptFragment 优先级流水线拼接。
 * 不依赖任何 Cordis 运行时或外部平台，供服务插件与核心逻辑复用。
 */
import { z } from "zod";

/** 模板分层类型：优先级依次升高（builtin < global < workspace） */
export type PromptLayer = "builtin" | "global" | "workspace";

/** 模板分层数字权重：数字越大优先级越高 */
export const PROMPT_LAYER_PRIORITY: Record<PromptLayer, number> = {
  builtin: 0,
  global: 1,
  workspace: 2,
};

/** 单个提示词模板定义 */
export interface PromptTemplateDefinition<T = Record<string, unknown>> {
  /** 唯一模板 ID，建议按领域分段，例如 'qa.review', 'orchestration.decompose' */
  id: string;
  /** 模板说明或用途 */
  description?: string;
  /** 模板字符串（支持 {{var}} 语法）或函数 */
  template: string | ((data: T) => string);
  /** 可选的输入参数 Schema 校验 */
  schema?: z.ZodType<T>;
}

/** 分层覆盖项条目 */
export interface PromptOverrideEntry {
  layer: PromptLayer;
  template: string;
  description?: string;
}

/** 提示词流水线中的单个片段 */
export interface PromptFragment {
  /** 片段唯一标识，例如 'role-identity', 'skills', 'team-context', 'feishu-policy' */
  id: string;
  /** 片段内容 */
  content: string;
  /** 排序权重（数字越小越靠前，默认 100） */
  priority?: number;
  /** 是否启用（根据交互策略、模式或运行时开关决定） */
  enabled?: boolean;
}

/** 从 Markdown 模板中提取的元数据与正文 */
export interface ParsedPromptMarkdown {
  metadata: Record<string, string>;
  template: string;
}

/**
 * 简单的 Mustache 风格变量插值函数，支持 {{key}} 与 {{nested.key}}。
 * 未匹配到的变量替换为空字符串。
 */
export function interpolatePrompt(
  template: string,
  data: Record<string, unknown> = {},
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, keyPath) => {
    const segments = keyPath.split(".");
    let current: unknown = data;
    for (const segment of segments) {
      if (current === undefined || current === null || typeof current !== "object") {
        return "";
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current !== undefined && current !== null ? String(current) : "";
  });
}

/**
 * 找出模板中出现、但 data 中未提供（解析结果为空）的占位符 key。
 * 用于在渲染后告警：格式敏感模板（如 qa.review 的 {{revision}}）若因
 * 调用方漏传或覆盖模板拼错占位符而静默置空，会破坏严格 JSON 校验。
 */
export function findMissingPromptKeys(
  template: string,
  data: Record<string, unknown> = {},
): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, keyPath: string) => {
    if (seen.has(keyPath)) return "";
    seen.add(keyPath);
    const segments = keyPath.split(".");
    let current: unknown = data;
    for (const segment of segments) {
      if (current === undefined || current === null || typeof current !== "object") {
        missing.push(keyPath);
        return "";
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (current === undefined || current === null) {
      missing.push(keyPath);
    }
    return "";
  });
  return missing;
}

/**
 * 解析带可选 YAML Frontmatter 的 Markdown 提示词文件。
 * 格式如下：
 * ---
 * description: 说明
 * ---
 * 模板正文内容...
 */
export function parsePromptMarkdown(raw: string): ParsedPromptMarkdown {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  if (!match) {
    return {
      metadata: {},
      template: normalized.trim(),
    };
  }
  const yamlContent = match[1];
  const template = match[2].trim();
  const metadata: Record<string, string> = {};
  for (const line of yamlContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim();
      const val = trimmed.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "");
      metadata[key] = val;
    }
  }
  return { metadata, template };
}

/**
 * 把多个提示词片段按 priority（默认 100）升序排序，
 * 过滤掉未启用或内容为空的片段，并以双换行拼接成完整提示词。
 */
export function composePromptFragments(
  fragments: Array<PromptFragment | undefined | null | false>,
): string {
  const validFragments: PromptFragment[] = [];
  for (const f of fragments) {
    if (
      f &&
      typeof f === "object" &&
      f.enabled !== false &&
      typeof f.content === "string" &&
      f.content.trim().length > 0
    ) {
      validFragments.push(f);
    }
  }

  return validFragments
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    .map((f) => f.content.trim())
    .join("\n\n");
}

/** 渲染字符串模板前告警缺失的占位符 key，避免格式敏感模板静默置空。 */
function warnMissingKeys(
  id: string,
  template: string,
  data: Record<string, unknown>,
): void {
  const missing = findMissingPromptKeys(template, data);
  if (missing.length > 0) {
    console.warn(
      `[Prompts] 模板 "${id}" 渲染时缺少占位符变量: ${missing.join(", ")}`,
    );
  }
}

/**
 * 提示词注册表：负责模板定义、分层覆盖（builtin < global < workspace）与渲染。
 */
export class PromptRegistry {
  private readonly definitions = new Map<string, PromptTemplateDefinition<any>>();
  /**
   * 每个模板按层级分别保存覆盖项；否则高层覆盖清理后无法回退到仍然存在的低层覆盖。
   */
  private readonly overrides = new Map<
    string,
    Map<PromptLayer, PromptOverrideEntry>
  >();

  /** 注册新的内置/默认提示词模板（Layer 1: builtin） */
  define<T>(definition: PromptTemplateDefinition<T>): void {
    this.definitions.set(definition.id, definition);
  }

  /** 获取已注册的模板定义 */
  get<T = Record<string, unknown>>(id: string): PromptTemplateDefinition<T> | undefined {
    return this.definitions.get(id);
  }

  /** 获取当前模板的生效层级 */
  getLayer(id: string): PromptLayer | undefined {
    const override = this.getOverride(id);
    if (override) return override.layer;
    if (this.definitions.has(id)) return "builtin";
    return undefined;
  }

  /** 获取当前模板的覆盖详情 */
  getOverride(id: string): PromptOverrideEntry | undefined {
    const entries = this.overrides.get(id);
    if (!entries) return undefined;
    for (const layer of ["workspace", "global", "builtin"] as const) {
      const entry = entries.get(layer);
      if (entry) return entry;
    }
    return undefined;
  }

  /** 判断是否已定义或已设置覆盖 */
  has(id: string): boolean {
    return this.definitions.has(id) || this.overrides.has(id);
  }

  /** 获取所有已定义的模板列表 */
  list(): PromptTemplateDefinition<any>[] {
    return [...this.definitions.values()];
  }

  /**
   * 设置分层覆盖模板：
   * 只有当 layer 的优先级 >= 已存在覆盖的优先级时，才允许覆盖；
   * 返回 true 表示覆盖成功，false 表示由于低层级无法覆盖高层级被拒绝。
   */
  setOverride(
    id: string,
    template: string,
    layer: PromptLayer = "global",
    description?: string,
  ): boolean {
    const existing = this.getOverride(id);
    if (existing) {
      const currentPriority = PROMPT_LAYER_PRIORITY[existing.layer];
      const newPriority = PROMPT_LAYER_PRIORITY[layer];
      if (newPriority < currentPriority) {
        return false;
      }
    }
    let entries = this.overrides.get(id);
    if (!entries) {
      entries = new Map();
      this.overrides.set(id, entries);
    }
    entries.set(layer, { layer, template, description });
    return true;
  }

  /** 移除指定的覆盖模板 */
  removeOverride(id: string): boolean {
    const entries = this.overrides.get(id);
    const current = this.getOverride(id);
    if (!entries || !current) return false;
    entries.delete(current.layer);
    if (entries.size === 0) this.overrides.delete(id);
    return true;
  }

  /** 清空指定层级的覆盖（若不传 layer 则清空所有覆盖） */
  clearOverrides(layer?: PromptLayer): void {
    if (!layer) {
      this.overrides.clear();
      return;
    }
    for (const [id, entries] of this.overrides.entries()) {
      entries.delete(layer);
      if (entries.size === 0) this.overrides.delete(id);
    }
  }

  /**
   * 渲染指定 ID 的提示词：
   * 1. 存在覆盖模板时，使用最高优先级覆盖模板通过 interpolatePrompt 渲染；
   * 2. 否则使用注册模板：
   *    - 若 template 是函数，先做 Schema 校验后执行函数；
   *    - 若 template 是字符串，先做 Schema 校验后通过 interpolatePrompt 渲染；
   * 3. 模板不存在时抛出异常。
   */
  render<T extends Record<string, unknown> = Record<string, unknown>>(
    id: string,
    data?: T,
  ): string {
    const override = this.getOverride(id);
    const definition = this.definitions.get(id);

    if (override !== undefined) {
      const validatedData = definition?.schema ? definition.schema.parse(data ?? {}) : (data ?? ({} as T));
      warnMissingKeys(id, override.template, validatedData);
      return interpolatePrompt(override.template, validatedData);
    }

    if (!definition) {
      throw new Error(`提示词模板不存在: ${id}`);
    }

    const validatedData = definition.schema
      ? definition.schema.parse(data ?? {})
      : (data ?? ({} as T));

    if (typeof definition.template === "function") {
      return definition.template(validatedData);
    }

    warnMissingKeys(id, definition.template, validatedData);
    return interpolatePrompt(definition.template, validatedData);
  }
}
