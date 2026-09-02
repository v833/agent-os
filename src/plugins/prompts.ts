/**
 * prompts 提示词管理服务插件：
 * 贯彻 Cordis 插件化思想，集中管理提示词模板、支持 Markdown 文件分层覆盖、
 * 并提供任务级提示词流水线（Prompt Pipeline）组装能力。
 */
import { Service, type Context } from "cordis";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { BotConfig, ProductDeliveryMode } from "../core/bot-registry.js";
import { interactionPolicyOf, type InteractionPolicy } from "../core/interaction-policy.js";
import {
  buildDocRequestPolicy,
  buildFeishuOutputPolicy,
  buildLarkIdentityPolicy,
  buildProductDeliveryPolicy,
  buildProjectSkillPolicy,
  DIRECT_CHAT_ROLE,
  managesProductDocuments,
  selectTaskSkills,
} from "../core/prompt-policies.js";
import {
  composePromptFragments,
  parsePromptMarkdown,
  PromptRegistry,
  type PromptFragment,
  type PromptLayer,
  type PromptTemplateDefinition,
} from "../core/prompts.js";
import type { Session } from "../core/session-manager.js";

/**
 * 提示词流水线收集器。
 *
 * 架构设计说明：
 * 在 Cordis 事件系统中，若事件采用返回值模式，`ctx.parallel` 返回的是 `Promise<void>` 无法汇总多个插件的返回值；
 * 若使用 `ctx.serial` / `ctx.bail` 则只能拿到第一个非 undefined 返回值，无法实现多插件协同贡献。
 * 因此，采用收集器模式 `collector.add(...)`：
 * 由 prompts 服务创建收集器并作为参数传入 `task/prompt-compose`，所有监听该事件的插件均可并发向收集器注册片段，
 * 最终由流水线统一进行 priority 升序稳定排序与合并，达到完全解耦与高扩展性。
 */
export interface PromptComposeCollector {
  add(...fragments: Array<PromptFragment | undefined | null | false>): void;
}

/** 提示词插件配置参数 */
export interface PromptsConfig {
  /** 全局提示词模板目录（相对于 cwd 或绝对路径），默认 "prompts" */
  promptsDir?: string;
  /** Agent OS 启动工作区的覆盖模板相对目录，默认 ".agents/prompts" */
  workspaceOverrideDir?: string;
}

export const PromptsConfigSchema = z.object({
  promptsDir: z.string().optional().default("prompts"),
  workspaceOverrideDir: z.string().optional().default(".agents/prompts"),
});

/** 提示词服务，挂载在 ctx.prompts */
export class PromptsService extends Service {
  readonly registry = new PromptRegistry();
  readonly options: PromptsConfig;

  constructor(ctx: Context, options: PromptsConfig = {}) {
    super(ctx, "prompts");
    this.options = PromptsConfigSchema.parse(options);
    this.registerBuiltinTemplates();
  }

  /** 注册提示词模板 */
  define<T = Record<string, unknown>>(definition: PromptTemplateDefinition<T>): void {
    this.registry.define(definition);
  }

  /** 获取模板定义 */
  get<T = Record<string, unknown>>(id: string): PromptTemplateDefinition<T> | undefined {
    return this.registry.get(id);
  }

  /** 获取模板生效层级 */
  getLayer(id: string): PromptLayer | undefined {
    return this.registry.getLayer(id);
  }

  /** 判断模板是否存在 */
  has(id: string): boolean {
    return this.registry.has(id);
  }

  /** 获取全部已注册模板 */
  list(): PromptTemplateDefinition<any>[] {
    return this.registry.list();
  }

  /** 渲染提示词 */
  render<T extends Record<string, unknown> = Record<string, unknown>>(
    id: string,
    data?: T,
  ): string {
    return this.registry.render(id, data);
  }

  /** 设置内存覆盖模板 */
  setOverride(
    id: string,
    template: string,
    layer: PromptLayer = "global",
    description?: string,
  ): boolean {
    return this.registry.setOverride(id, template, layer, description);
  }

  /** 移除覆盖 */
  removeOverride(id: string): boolean {
    return this.registry.removeOverride(id);
  }

  /**
   * 递归扫描指定目录下的 .md 文件，将相对路径规范为模板 ID 载入覆盖。
   * 目录路径在执行时先通过 resolve(process.cwd(), dir) 规范化为绝对路径，避免由于 cwd 变化造成路径错乱。
   * 例如: dir/qa/review.md -> 模板 ID "qa.review"
   *
   * 覆盖语义限制：文件覆盖模板只支持纯字符串 `{{var}}` 插值，不支持条件逻辑。
   * 对于内置为函数模板的策略（如 `policy.feishu-output`），用同名 .md 覆盖会丢失其按
   * direct/documentRequested 生成的条件分支，且不会告警。此类策略建议改用
   * `task/prompt-compose` 事件提供同名片段来覆盖，而非文件覆盖。
   */
  async loadFromDirectory(
    directory: string,
    layer: PromptLayer = "global",
    baseDirectory = directory,
  ): Promise<number> {
    let count = 0;
    const resolvedDir = isAbsolute(directory)
      ? directory
      : resolve(process.cwd(), directory);
    const resolvedBase = isAbsolute(baseDirectory)
      ? baseDirectory
      : resolve(process.cwd(), baseDirectory);

    let entries;
    try {
      entries = await readdir(resolvedDir, { withFileTypes: true });
    } catch (err) {
      // 目录不存在（ENOENT）静默跳过；其余错误告警，但不影响其他已存在的目录。
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[Prompts] 加载提示词目录失败: ${directory}`,
          (err as Error).message,
        );
      }
      return count;
    }

    for (const entry of entries) {
      const fullPath = join(resolvedDir, entry.name);
      try {
        if (entry.isDirectory()) {
          count += await this.loadFromDirectory(fullPath, layer, resolvedBase);
        } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          const raw = await readFile(fullPath, "utf-8");
          const parsed = parsePromptMarkdown(raw);
          const relPath = relative(resolvedBase, fullPath);
          // 将路径 separators 转换为点分 ID，例如 qa/review.md -> qa.review
          const templateId = relPath
            .replace(/\.md$/i, "")
            .replace(/\\/g, "/")
            .replace(/\//g, ".");
          if (this.registry.setOverride(
            templateId,
            parsed.template,
            layer,
            parsed.metadata.description,
          )) {
            count++;
          }
        }
      } catch (err) {
        // 单个文件损坏或暂时不可读时继续扫描兄弟文件，避免策略集合被部分截断。
        console.warn(
          `[Prompts] 加载提示词文件失败: ${fullPath}`,
          (err as Error).message,
        );
      }
    }
    return count;
  }

  /**
   * 任务主提示词组装流水线：
   * 1. 广播 `task/prompt-compose` 收集所有插件贡献的 PromptFragment；
   * 2. 加载 bot 的 Skills 并生成 projectSkill 片段；
   * 3. 补充基础身份（Role / SystemPrompt）与当前任务片段；
   * 4. 排序并拼接输出。
   */
  async composeTaskPrompt(
    botConfig: BotConfig,
    prompt: string,
    options: {
      interaction?: InteractionPolicy;
      session?: Session;
      defaultProductDeliveryMode?: ProductDeliveryMode;
    } = {},
  ): Promise<string> {
    const interaction = interactionPolicyOf(options);
    const direct = interaction.mode === "direct";
    const documentRequested = interaction.documentRequested;

    // 1. 收集插件事件贡献的片段
    const fragments: PromptFragment[] = [];
    const collector: PromptComposeCollector = {
      add(...items) {
        for (const item of items) {
          if (item) fragments.push(item);
        }
      },
    };

    const defaultProductDeliveryMode =
      options.defaultProductDeliveryMode ??
      this.ctx.config?.defaultProductDeliveryMode ??
      "local";
    // 提示词扩展属于执行前置条件；监听器失败时阻止 CLI 启动，避免带着不完整策略执行。
    try {
      await this.ctx.parallel(
        "task/prompt-compose",
        collector,
        botConfig,
        prompt,
        {
          interaction,
          session: options.session,
          defaultProductDeliveryMode,
        },
      );
    } catch (error) {
      const detail = error instanceof AggregateError
        ? error.errors
            .map((item) => item instanceof Error ? item.message : String(item))
            .join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(
        `[Prompts] 提示词扩展失败（bot=${botConfig.id}）：${detail}`,
        { cause: error },
      );
    }

    // 2. 基础角色与身份片段（priority 10）
    const hasUsableFragment = (id: string): boolean =>
      fragments.some(
        (f) =>
          f.id === id &&
          f.enabled !== false &&
          typeof f.content === "string" &&
          f.content.trim().length > 0,
      );

    if (!hasUsableFragment("role-identity")) {
      const roleContent = direct
        ? this.render("role.direct-chat")
        : `你的角色：${botConfig.role}\n\n${botConfig.systemPrompt.trim()}`.trim();
      fragments.push({
        id: "role-identity",
        priority: 10,
        content: roleContent,
      });
    }

    // 3. Project Skills 片段（priority 30）
    if (!hasUsableFragment("project-skills")) {
      const skills = selectTaskSkills(
        botConfig.skills,
        interaction.mode,
        documentRequested,
      );
      const skillContent = await buildProjectSkillPolicy(
        botConfig.workspaceDir,
        skills,
      );
      if (skillContent) {
        fragments.push({
          id: "project-skills",
          priority: 30,
          content: skillContent,
        });
      }
    }

    // 4. 核心策略片段注入（priority 40~55）
    // 4.1 飞书输出规则（priority 40，始终注入）
    if (!hasUsableFragment("feishu-output-policy")) {
      fragments.push({
        id: "feishu-output-policy",
        priority: 40,
        content: this.render("policy.feishu-output", { direct, documentRequested }),
      });
    }

    // 4.2 lark-cli 身份规则（priority 45，非 direct 或显式 /doc 时注入）
    if ((!direct || documentRequested) && !hasUsableFragment("lark-identity-policy")) {
      fragments.push({
        id: "lark-identity-policy",
        priority: 45,
        content: this.render("policy.lark-identity", { botId: botConfig.id }),
      });
    }

    // 4.3 产品方案交付规则（priority 50，具备产品方案产物 skill 时注入）
    const managesDocs = managesProductDocuments(
      botConfig.skills,
      direct,
      documentRequested,
    );
    if (managesDocs && !hasUsableFragment("product-delivery-policy")) {
      fragments.push({
        id: "product-delivery-policy",
        priority: 50,
        content: this.render("policy.product-delivery", {
          defaultDeliveryMode: defaultProductDeliveryMode,
        }),
      });
    }

    // 4.4 /doc 显式文档请求规则（priority 55，用户 /doc 时注入）
    if (documentRequested && !hasUsableFragment("doc-request-policy")) {
      fragments.push({
        id: "doc-request-policy",
        priority: 55,
        content: this.render("policy.doc-request"),
      });
    }

    // 5. 当前任务片段（priority 100）
    if (!hasUsableFragment("current-task")) {
      fragments.push({
        id: "current-task",
        priority: 100,
        content: `当前任务：${prompt}`,
      });
    }

    return composePromptFragments(fragments);
  }

  /** 注册系统内置默认模板 */
  private registerBuiltinTemplates(): void {
    // 私聊直达角色
    this.define({
      id: "role.direct-chat",
      description: "私聊直达角色的固定描述",
      template: DIRECT_CHAT_ROLE,
    });

    // 飞书输出规则
    this.define({
      id: "policy.feishu-output",
      description: "飞书输出规范约束",
      template: (data: { direct?: boolean; documentRequested?: boolean }) =>
        buildFeishuOutputPolicy(Boolean(data.direct), Boolean(data.documentRequested)),
    });

    // 产品方案交付规则
    this.define({
      id: "policy.product-delivery",
      description: "产品方案交付方式与工具调用规则",
      template: (data: { defaultDeliveryMode?: string }) =>
        buildProductDeliveryPolicy(data.defaultDeliveryMode ?? "local"),
    });

    // lark-cli 身份规则
    this.define({
      id: "policy.lark-identity",
      description: "lark-cli 调用的 Profile 与身份要求",
      template: (data: { botId: string }) => buildLarkIdentityPolicy(data.botId),
    });

    // /doc 文档显式请求规则
    this.define({
      id: "policy.doc-request",
      description: "用户通过 /doc 显式请求文档时的要求",
      template: buildDocRequestPolicy(),
    });

    // QA 审查提示词
    this.define({
      id: "qa.review",
      description: "QA 质量审查提示词",
      template: [
        "请独立审查当前工作目录。审查期间不得修改工作树；如需建议测试改动，请放入 findings。",
        "固定审查 revision：{{revision}}",
        "原始任务：{{originalPrompt}}",
        "完成后只输出一个 QAResult JSON 对象，revision 必须原样填写上述值。",
        '{"verdict":"pass | changes_requested | blocked","revision":"固定 revision","tests":[{"command":"实际命令","status":"passed | failed | skipped","exitCode":0}],"findings":[{"id":"QA-001","severity":"P0 | P1 | P2 | P3","location":"文件与行号","reproduction":"复现步骤","expected":"预期","actual":"实际","recommendation":"建议"}],"nextAction":"close | return_to_developer | escalate"}',
      ].join("\n\n"),
    });

    // 编排任务拆解提示词
    this.define({
      id: "orchestration.decompose",
      description: "多话题并行任务拆解提示词",
      template: (data: { members: string[]; task: string; mode: string }) => {
        const assignmentRule =
          data.mode === "same-topic"
            ? "每个子任务的 bot 字段必须从上述成员中选择；每个成员最多承接一个子任务（同一 bot 不能被分配给多个子任务）；"
            : "每个子任务的 bot 字段必须从上述成员中选择；同一 bot 可以被分配给多个子任务，但每个子任务 id 必须互不相同；";
        return [
          "你是任务编排者。请把以下大任务拆解为可并行执行的子任务清单。",
          `可派发的成员：${data.members.join("、")}`,
          `${assignmentRule}子任务应互不依赖、可并行。`,
          "只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
          '{"tasks":[{"id":"t1","prompt":"子任务描述","bot":"成员id"}]}',
          `大任务：${data.task}`,
        ].join("\n\n");
      },
    });

    // 产品方案纠偏提示词
    this.define({
      id: "product.spec-correction",
      description: "产品方案未调用审批工具时的纠偏提示词",
      template: [
        "本轮产品方案没有留下有效的 request_spec_approval 工具调用，因此不能按普通任务完成。",
        "请检查刚刚生成或更新的唯一产品方案产物，立即调用 request_spec_approval 提交最终版本。",
        "调用必须包含最终采用的 deliveryMode，以及该模式要求的全部产物字段；不要只在文字回复中罗列路径或 URL。",
        "提交工具调用完成后停止本轮。",
      ].join("\n"),
    });

    // 云文档评论修改提示词
    this.define({
      id: "product.comment-followup",
      description: "云文档 @ 评论触发产品修改提示词",
      template: (data: { documentUrl: string; fileType: string; commentId: string; replyId?: string }) => [
        "用户在待确认的飞书产品方案中通过评论明确提及了你。",
        `文档 URL：${data.documentUrl}`,
        `文档类型：${data.fileType}`,
        `评论 ID：${data.commentId}`,
        data.replyId ? `触发回复 ID：${data.replyId}` : "",
        "使用 lark-drive 读取这一条评论、完整回复和正文位置，再使用 lark-doc 精确修改原文档。",
        "修改成功后，最终回答只写一段给评论者看的简短说明，讲清楚具体改了什么。Agent OS 会把最终回答写回原评论。",
        "不要调用评论回复或解决接口，评论是否解决由用户复查后决定。",
        "不要调用 request_spec_approval，不要生成新的确认卡；原待确认卡继续有效。",
      ].filter(Boolean).join("\n\n"),
    });
  }
}

export const name = "prompts";
export const inject = [];

export async function apply(ctx: Context, options: PromptsConfig = {}) {
  const service = new PromptsService(ctx, options);

  // 1. 加载全局默认提示词目录（Layer 2: global）
  if (service.options.promptsDir) {
    await service.loadFromDirectory(service.options.promptsDir, "global");
  }

  // 2. 加载 Agent OS 启动工作区模板覆盖（Layer 3: workspace，后加载覆盖先加载）
  if (service.options.workspaceOverrideDir) {
    await service.loadFromDirectory(service.options.workspaceOverrideDir, "workspace");
  }
}
