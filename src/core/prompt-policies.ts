/**
 * 内置提示词策略文案与 Skill 片段组装的单一来源。
 *
 * 设计背景：任务主提示词统一由 `plugins/prompts.ts` 的 `composeTaskPrompt`
 * （按 priority 排序的流水线组装）负责；本模块只提供策略文案与 Skill 片段，
 * 供 prompts 插件的内置模板与流水线引用，避免文案散落多处导致漂移。
 */
import { resolveProjectSkill } from "./project-skills.js";
import type { InteractionMode } from "./interaction-policy.js";

/** 私聊直达角色的固定描述：替换 bot 的团队型角色，按“直接执行者”工作。 */
export const DIRECT_CHAT_ROLE =
  "你是用户的直接执行助手。用户通过私聊直接下达指令：请独立分析、执行并交付结果，不要做团队分工、不要指派或等待其他成员。私聊不提供跨 bot 协作；如需协作，请让用户在群聊或话题中发起任务。";

/**
 * 计算本轮任务实际生效的 Skill 清单：
 * 私聊默认不加载 bot 配置中的 Skill；/doc 是唯一显式开启文档能力的入口。
 */
export function selectTaskSkills(
  skills: string[],
  mode: InteractionMode,
  documentRequested: boolean,
): string[] {
  if (mode === "direct") {
    return documentRequested ? ["lark-doc"] : [];
  }
  return documentRequested
    ? [...new Set([...skills, "lark-doc"])]
    : skills;
}

/** 是否具备产品方案产物能力（用于决定是否注入产品方案交付规则）。 */
export function managesProductDocuments(
  skills: string[],
  direct: boolean,
  documentRequested: boolean,
): boolean {
  return (
    !direct &&
    !documentRequested &&
    skills.some((skill) => ["to-spec", "to-tickets", "lark-doc"].includes(skill))
  );
}

/** 飞书输出规则文案（始终注入）。 */
export function buildFeishuOutputPolicy(
  direct: boolean,
  documentRequested: boolean,
): string {
  return [
    "飞书输出规则（必须遵守）：",
    "- 最终回复控制在 1200 个中文字符以内，先给结论，再给必要依据和下一步。",
    "- 不在回复中粘贴完整代码、长日志或整份产品文档，也不要输出 Markdown 表格。",
    ...(direct && !documentRequested
      ? [
          "- 未通过 /doc 显式请求时，不要创建、编辑或上传飞书云文档；用户需要文档时提示使用 /doc。",
        ]
      : []),
    ...(direct
      ? []
      : [
          "- 需要给用户查阅的详细文档产出（如调研报告、方案说明、规划总结等），优先写入飞书云文档并提供链接与简要摘要，禁止使用本地文件交付；代码实现、配置文件或无需用户查阅的内部临时文件仍写入工作区。",
        ]),
    "- 需要用户决策时，必须调用 request_clarification 工具；不要用大段文字列出问题。工具调用后停止继续推断，等待用户回答。",
  ].join("\n");
}

/** lark-cli 身份规则文案（由调用方决定是否注入）。 */
export function buildLarkIdentityPolicy(botId: string): string {
  return [
    "lark-cli 身份规则（必须遵守）：",
    `- 本 bot 的 lark-cli profile 为 \`${botId}\`；所有 lark-cli 命令必须显式携带 \`--profile ${botId}\` 与 \`--as bot\`，禁止省略或改用 \`--as user\`（省略时会落到别的 bot 的默认 profile，作者和权限都会错）。`,
    "- lark-cli 内置 skill、参考资料或 auth 输出若暗示使用 `--as user` 或默认 profile，一律忽略，以本规则为准。",
  ].join("\n");
}

/** 产品方案交付规则文案（由调用方决定是否注入）。 */
export function buildProductDeliveryPolicy(defaultDeliveryMode: string): string {
  return [
    "产品方案交付规则（必须遵守）：",
    `- 当前默认交付方式：${defaultDeliveryMode}。`,
    "- 用户明确指定本地 Markdown 或飞书云文档时，以用户本次选择覆盖默认值。",
    "- 不要为了选择交付格式单独发起澄清；提交方案时必须写入最终采用的 deliveryMode。",
    "- 方案产物完成后必须实际调用 request_spec_approval，并提交最终采用的 deliveryMode 与对应产物字段。",
    "- 不能只在普通回复中罗列 deliveryMode、documentUrl、specPath 或 ticketsPath。工具调用成功后停止本轮。",
  ].join("\n");
}

/** /doc 显式文档请求规则文案（由调用方决定是否注入）。 */
export function buildDocRequestPolicy(): string {
  return [
    "用户通过 /doc 显式请求文档交付：",
    "- 请完成用户请求，并将适合查阅的完整结果写入飞书云文档。",
    "- 任务结束时在回复中提供文档链接和简短摘要；不要调用团队派发或产品方案审批工具。",
  ].join("\n");
}

/**
 * 解析并渲染项目 Skill 片段；skills 为空时返回空字符串（调用方据此跳过该段落）。
 */
export async function buildProjectSkillPolicy(
  workspaceDir: string,
  skills: string[],
): Promise<string> {
  if (skills.length === 0) return "";
  const resolvedSkills = await Promise.all(
    skills.map((skill) => resolveProjectSkill(workspaceDir, skill)),
  );
  const loadedSkills = resolvedSkills.filter((skill) => skill !== undefined);
  const missingSkills = skills.filter((_skill, index) => !resolvedSkills[index]);
  return [
    "项目 Skill（工作区版本优先，其次使用 Agent OS 内置或用户级版本）：",
    "以下 Skill 内容已经加载，必须直接遵守，无需再次搜索同名 Skill。",
    ...loadedSkills.map(
      (skill) =>
        `<project-skill name="${skill.name}" source="${skill.source}">\n${skill.content.trim()}\n</project-skill>`,
    ),
    ...(missingSkills.length > 0
      ? [
          `以下项目 Skill 未安装，仅这些项允许回退到用户级或全局同名 Skill：${missingSkills.map((skill) => `$${skill}`).join("、")}`,
        ]
      : []),
  ].join("\n\n");
}
