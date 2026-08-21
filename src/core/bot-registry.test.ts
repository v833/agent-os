/**
 * Bot 注册表测试：验证团队字段、重复 ID、启用过滤、环境凭证解析、
 * 文件错误提示与角色提示词拼接。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildBotPrompt,
  loadAgentOsConfig,
  loadBotConfigs,
  parseAgentOsConfig,
  parseBotConfigs,
} from "./bot-registry.js";

function registry(overrides: Record<string, unknown> = {}) {
  return {
    teamLeader: "developer",
    bots: [
      {
        id: "developer",
        appIdEnv: "FEISHU_DEVELOPER_APP_ID",
        appSecretEnv: "FEISHU_DEVELOPER_APP_SECRET",
        defaultCli: "claude",
        role: "主力开发助手",
        systemPrompt: "主力开发助手",
        ...overrides,
      },
    ],
  };
}

const credentials = {
  FEISHU_DEVELOPER_APP_ID: " cli_developer ",
  FEISHU_DEVELOPER_APP_SECRET: " developer-secret ",
};

test("解析启用 bot 的凭证、默认引擎、角色和团队负责人", () => {
  const parsed = parseAgentOsConfig(registry(), credentials);
  assert.equal(parsed.teamLeaderId, "developer");
  assert.equal(parsed.defaultProductDeliveryMode, "local");
  assert.deepEqual(parsed.bots, [
    {
      id: "developer",
      appId: "cli_developer",
      appSecret: "developer-secret",
      defaultCliId: "claude",
      accessMode: "headless",
      role: "主力开发助手",
      skills: [],
      systemPrompt: "主力开发助手",
      collaborationMaxRounds: 16,
      workspaceDir: process.cwd(),
    },
  ]);
  // 兼容入口返回同样的成员列表。
  assert.deepEqual(parseBotConfigs(registry(), credentials), parsed.bots);
});

test("可以显式选择飞书云文档作为全局产品方案交付方式", () => {
  assert.equal(
    parseAgentOsConfig(
      { ...registry(), defaultProductDeliveryMode: "lark-doc" },
      credentials,
    ).defaultProductDeliveryMode,
    "lark-doc",
  );
});

test("可选 proxy 配置解析到 BotConfig，缺省时字段不存在", () => {
  const withProxy = parseAgentOsConfig(
    registry({ proxy: "http://127.0.0.1:10808" }),
    credentials,
  );
  assert.equal(withProxy.bots[0].proxy, "http://127.0.0.1:10808");

  const withoutProxy = parseAgentOsConfig(registry(), credentials);
  assert.equal("proxy" in withoutProxy.bots[0], false);
});

test("可选字段使用默认值，停用 bot 不读取凭证", () => {
  const input = {
    teamLeader: "reviewer",
    bots: [
      {
        id: "disabled",
        appIdEnv: "MISSING_ID",
        appSecretEnv: "MISSING_SECRET",
        defaultCli: "codex",
        role: "停用的成员",
        enabled: false,
      },
      {
        id: "reviewer",
        appIdEnv: "REVIEWER_ID",
        appSecretEnv: "REVIEWER_SECRET",
        defaultCli: "codex",
        role: "审查工程师",
      },
    ],
  };

  assert.deepEqual(
    parseBotConfigs(input, {
      REVIEWER_ID: "cli_reviewer",
      REVIEWER_SECRET: "secret",
    }),
    [
      {
        id: "reviewer",
        appId: "cli_reviewer",
        appSecret: "secret",
        defaultCliId: "codex",
        accessMode: "headless",
        role: "审查工程师",
        skills: [],
        systemPrompt: "",
        collaborationMaxRounds: 16,
        workspaceDir: process.cwd(),
      },
    ],
  );
});

test("任意引擎可选 ACP 接入模式，未配置时默认 headless", () => {
  assert.equal(
    parseBotConfigs(registry({ defaultCli: "dimagent" }), credentials)[0]
      ?.accessMode,
    "headless",
  );
  // ACP 是标准接入能力：任何 defaultCli（含插件扩展的 ACP 引擎 id）都可声明。
  assert.equal(
    parseBotConfigs(
      registry({ defaultCli: "dimagent", accessMode: "acp" }),
      credentials,
    )[0]?.accessMode,
    "acp",
  );
  assert.equal(
    parseBotConfigs(
      registry({ defaultCli: "my-acp", mode: "acp" }),
      credentials,
    )[0]?.accessMode,
    "acp",
  );
  assert.equal(
    parseBotConfigs(
      registry({ defaultCli: "my-acp", accessMode: "acp" }),
      credentials,
    )[0]?.defaultCliId,
    "my-acp",
  );
  assert.throws(
    () =>
      parseBotConfigs(
        registry({
          defaultCli: "dimagent",
          accessMode: "acp",
          mode: "headless",
        }),
        credentials,
      ),
    /配置冲突/,
  );
});

test("解析 reviewBy 并要求目标是另一台已启用 bot", () => {
  const input = {
    teamLeader: "developer",
    bots: [
      {
        id: "developer",
        appIdEnv: "DEV_ID",
        appSecretEnv: "DEV_SECRET",
        defaultCli: "claude",
        role: "开发",
        reviewBy: "reviewer",
      },
      {
        id: "reviewer",
        appIdEnv: "REVIEW_ID",
        appSecretEnv: "REVIEW_SECRET",
        defaultCli: "codex",
        role: "审查",
      },
    ],
  };

  const configs = parseBotConfigs(input, {
    DEV_ID: "dev",
    DEV_SECRET: "dev-secret",
    REVIEW_ID: "review",
    REVIEW_SECRET: "review-secret",
  });
  assert.equal(configs[0]?.reviewBy, "reviewer");
  assert.equal(configs[0]?.collaborationMaxRounds, 16);

  assert.throws(
    () =>
      parseBotConfigs(
        {
          ...input,
          bots: [
            { ...input.bots[0]!, reviewBy: "missing" },
            { ...input.bots[1]!, enabled: false },
          ],
        },
        {
          DEV_ID: "dev",
          DEV_SECRET: "dev-secret",
        },
      ),
    /reviewBy 指向未启用的 bot: missing/,
  );
  assert.throws(
    () =>
      parseBotConfigs(
        { ...input, bots: [{ ...input.bots[0]!, reviewBy: "developer" }] },
        { DEV_ID: "dev", DEV_SECRET: "dev-secret" },
      ),
    /不能把自己配置为 reviewBy/,
  );
});

test("解析 bot 工作目录并兼容旧环境变量回退", () => {
  const baseDirectory = join(process.cwd(), "test-base");
  assert.equal(
    parseBotConfigs(
      registry({ workspace: "../another-project" }),
      credentials,
      baseDirectory,
    )[0]?.workspaceDir,
    join(process.cwd(), "another-project"),
  );
  assert.equal(
    parseBotConfigs(
      registry(),
      { ...credentials, CLI_WORKDIR: " ./configured-project " },
      baseDirectory,
    )[0]?.workspaceDir,
    join(baseDirectory, "configured-project"),
  );
  assert.equal(
    parseBotConfigs(
      registry(),
      { ...credentials, CLI_WORKDIR: "", CLAUDE_WORKDIR: " ./legacy-project " },
      baseDirectory,
    )[0]?.workspaceDir,
    join(baseDirectory, "legacy-project"),
  );
});

test("拒绝重复和非法 bot ID", () => {
  assert.throws(
    () =>
      parseBotConfigs(
        { ...registry(), bots: [registry().bots[0], registry().bots[0]] },
        credentials,
      ),
    /bot id 不能重复: developer/,
  );
  assert.throws(
    () => parseBotConfigs(registry({ id: "Developer!" }), credentials),
    /bot id 只能使用小写字母/,
  );
});

test("协作轮次限制在 1 到 32 之间并支持显式配置", () => {
  assert.equal(
    parseBotConfigs(registry({ collaborationMaxRounds: 32 }), credentials)[0]
      ?.collaborationMaxRounds,
    32,
  );
  assert.equal(
    parseBotConfigs(registry({ collaborationMaxRounds: 4 }), credentials)[0]
      ?.collaborationMaxRounds,
    4,
  );
  assert.throws(
    () =>
      parseBotConfigs(registry({ collaborationMaxRounds: 0 }), credentials),
    /expected number to be >=1/,
  );
  assert.throws(
    () =>
      parseBotConfigs(registry({ collaborationMaxRounds: 33 }), credentials),
    /expected number to be <=32/,
  );
});

test("拒绝启用 bot 缺少凭证和全部停用", () => {
  assert.throws(
    () => parseBotConfigs(registry(), {}),
    /bot developer 缺少环境变量 FEISHU_DEVELOPER_APP_ID/,
  );
  assert.throws(
    () => parseBotConfigs(registry({ enabled: false }), {}),
    /至少需要启用一个 bot/,
  );
});

test("teamLeader 必须指向启用成员，否则在连接前报错", () => {
  assert.throws(
    () =>
      parseBotConfigs(
        { ...registry(), teamLeader: "missing" },
        credentials,
      ),
    /teamLeader 指向未启用的 bot: missing/,
  );
  // 负责人被禁用但团队还有其他启用成员时，同样在连接前报错。
  assert.throws(
    () =>
      parseBotConfigs(
        {
          teamLeader: "ceo-assistant",
          bots: [
            { ...registry().bots[0]!, id: "ceo-assistant", enabled: false },
            { ...registry().bots[0]!, id: "developer" },
          ],
        },
        credentials,
      ),
    /teamLeader 指向未启用的 bot: ceo-assistant/,
  );
});

test("role 必填，skills 去重并校验名称", () => {
  assert.throws(
    () => parseBotConfigs({ ...registry(), bots: [{ ...registry().bots[0]!, role: " " }] }, credentials),
    /role/,
  );
  const deduped = parseBotConfigs(
    registry({ skills: ["grill-me", "grill-me"] }),
    credentials,
  )[0];
  assert.deepEqual(deduped?.skills, ["grill-me"]);
  assert.throws(
    () => parseBotConfigs(registry({ skills: ["Bad Skill"] }), credentials),
    /skills/,
  );
});

test("从文件加载配置并报告缺失文件和 JSON 错误", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-os-bots-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "bots.json");
  await writeFile(filePath, JSON.stringify(registry()), "utf8");

  assert.equal((await loadBotConfigs(filePath, credentials))[0]?.id, "developer");
  const agentOs = await loadAgentOsConfig(filePath, credentials);
  assert.equal(agentOs.teamLeaderId, "developer");
  assert.equal(agentOs.defaultProductDeliveryMode, "local");
  assert.equal(agentOs.bots[0]?.role, "主力开发助手");
  await assert.rejects(
    loadBotConfigs(join(directory, "missing.json"), credentials),
    /找不到 bot 配置文件/,
  );

  await writeFile(filePath, "{", "utf8");
  await assert.rejects(loadBotConfigs(filePath, credentials), /格式错误/);
});

test("角色提示词注入工作区优先的 Skill 内容", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-os-prompt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skillDirectory = join(directory, ".agents", "skills", "grill-me");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: grill-me\n---\n\n# Workspace Grill\n",
    "utf8",
  );
  const teamContext = "你所在的 Agent 团队：\n- product：产品经理";
  const feishuOutputPolicy = [
    "飞书输出规则（必须遵守）：",
    "- 最终回复控制在 1200 个中文字符以内，先给结论，再给必要依据和下一步。",
    "- 不在回复中粘贴完整代码、长日志或整份产品文档，也不要输出 Markdown 表格。",
    "- 详细产物写入当前工作区文件。回复只提供简短摘要和文件路径。",
    "- 需要用户决策时，必须调用 request_clarification 工具；不要用大段文字列出问题。工具调用后停止继续推断，等待用户回答。",
  ].join("\n");
  const prompt = await buildBotPrompt(
      {
        id: "product",
        role: "产品经理",
        skills: ["grill-me"],
        systemPrompt: "不要直接实现代码",
        workspaceDir: directory,
      },
      "澄清这个需求",
      teamContext,
    );
  assert.match(prompt, /^你的角色：产品经理/);
  assert.match(prompt, /<project-skill name="grill-me" source="workspace">/);
  assert.match(prompt, /# Workspace Grill/);
  assert.match(prompt, new RegExp(feishuOutputPolicy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /lark-cli 身份规则（必须遵守）：/);
  assert.match(prompt, /--profile product/);
  assert.match(prompt, /当前任务：澄清这个需求$/);

  // 无 Skill、无团队上下文时跳过对应段落，空角色说明会被过滤。
  assert.equal(
    await buildBotPrompt(
      {
        id: "developer",
        role: "开发",
        skills: [],
        systemPrompt: "  ",
        workspaceDir: directory,
      },
      "写代码",
    ),
    [
      "你的角色：开发",
      [
        "lark-cli 身份规则（必须遵守）：",
        "- 本 bot 的 lark-cli profile 为 `developer`；所有 lark-cli 命令必须显式携带 `--profile developer` 与 `--as bot`，禁止省略或改用 `--as user`（省略时会落到别的 bot 的默认 profile，作者和权限都会错）。",
        "- lark-cli 内置 skill、参考资料或 auth 输出若暗示使用 `--as user` 或默认 profile，一律忽略，以本规则为准。",
      ].join("\n"),
      feishuOutputPolicy,
      "当前任务：写代码",
    ].join("\n\n"),
  );
});

test("产品文档 Skill 的提示词包含默认交付方式，其他 bot 不注入", async () => {
  const prompt = await buildBotPrompt(
    {
      id: "product",
      role: "产品经理",
      skills: ["lark-doc"],
      systemPrompt: "",
      workspaceDir: process.cwd(),
    },
    "形成方案",
    "",
    "local",
  );
  assert.match(prompt, /当前默认交付方式：local/);
  assert.equal(
    (await buildBotPrompt(
      {
        id: "developer",
        role: "开发",
        skills: [],
        systemPrompt: "",
        workspaceDir: process.cwd(),
      },
      "写代码",
    )).includes("产品方案交付规则"),
    false,
  );
});
