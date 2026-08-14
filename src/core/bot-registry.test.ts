/**
 * Bot 注册表测试：验证字段、重复 ID、启用过滤、环境凭证解析、
 * 文件错误提示与角色提示词拼接。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildBotPrompt,
  loadBotConfigs,
  parseBotConfigs,
} from "./bot-registry.js";

function registry(overrides: Record<string, unknown> = {}) {
  return {
    bots: [
      {
        id: "developer",
        appIdEnv: "FEISHU_DEVELOPER_APP_ID",
        appSecretEnv: "FEISHU_DEVELOPER_APP_SECRET",
        defaultCli: "claude",
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

test("解析启用 bot 的凭证、默认引擎和角色", () => {
  assert.deepEqual(parseBotConfigs(registry(), credentials), [
    {
      id: "developer",
      appId: "cli_developer",
      appSecret: "developer-secret",
      defaultCliId: "claude",
      accessMode: "headless",
      systemPrompt: "主力开发助手",
      collaborationMaxRounds: 2,
      workspaceDir: process.cwd(),
    },
  ]);
});

test("可选字段使用默认值，停用 bot 不读取凭证", () => {
  const input = {
    bots: [
      {
        id: "disabled",
        appIdEnv: "MISSING_ID",
        appSecretEnv: "MISSING_SECRET",
        defaultCli: "codex",
        enabled: false,
      },
      {
        id: "reviewer",
        appIdEnv: "REVIEWER_ID",
        appSecretEnv: "REVIEWER_SECRET",
        defaultCli: "codex",
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
        systemPrompt: "",
        collaborationMaxRounds: 2,
        workspaceDir: process.cwd(),
      },
    ],
  );
});

test("DimAgent 可选择 ACP，未配置接入模式时默认 headless", () => {
  assert.equal(
    parseBotConfigs(registry({ defaultCli: "dimagent" }), credentials)[0]
      ?.accessMode,
    "headless",
  );
  assert.equal(
    parseBotConfigs(
      registry({ defaultCli: "dimagent", accessMode: "acp" }),
      credentials,
    )[0]?.accessMode,
    "acp",
  );
  assert.equal(
    parseBotConfigs(
      registry({ defaultCli: "dimagent", mode: "acp" }),
      credentials,
    )[0]?.accessMode,
    "acp",
  );
  assert.throws(
    () => parseBotConfigs(registry({ accessMode: "acp" }), credentials),
    /defaultCli=dimagent/,
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
    bots: [
      {
        id: "developer",
        appIdEnv: "DEV_ID",
        appSecretEnv: "DEV_SECRET",
        defaultCli: "claude",
        reviewBy: "reviewer",
      },
      {
        id: "reviewer",
        appIdEnv: "REVIEW_ID",
        appSecretEnv: "REVIEW_SECRET",
        defaultCli: "codex",
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
  assert.equal(configs[0]?.collaborationMaxRounds, 2);

  assert.throws(
    () =>
      parseBotConfigs(
        {
          bots: [
            {
              ...input.bots[0],
              reviewBy: "missing",
            },
            { ...input.bots[1], enabled: false },
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
        { bots: [{ ...input.bots[0], reviewBy: "developer" }] },
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
        { bots: [registry().bots[0], registry().bots[0]] },
        credentials,
      ),
    /bot id 不能重复: developer/,
  );
  assert.throws(
    () => parseBotConfigs(registry({ id: "Developer!" }), credentials),
    /bot id 只能使用小写字母/,
  );
});

test("协作轮次限制在 1 到 4 之间并支持显式配置", () => {
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
      parseBotConfigs(registry({ collaborationMaxRounds: 5 }), credentials),
    /expected number to be <=4/,
  );
});

test("拒绝启用 bot 缺少凭证和全部停用", () => {
  assert.throws(
    () => parseBotConfigs(registry(), {}),
    /bot developer 缺少环境变量 FEISHU_DEVELOPER_APP_ID/,
  );
  assert.throws(
    () =>
      parseBotConfigs(registry({ enabled: false }), {}),
    /至少需要启用一个 bot/,
  );
});

test("从文件加载配置并报告缺失文件和 JSON 错误", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-os-bots-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "bots.json");
  await writeFile(filePath, JSON.stringify(registry()), "utf8");

  assert.equal((await loadBotConfigs(filePath, credentials))[0]?.id, "developer");
  await assert.rejects(
    loadBotConfigs(join(directory, "missing.json"), credentials),
    /找不到 bot 配置文件/,
  );

  await writeFile(filePath, "{", "utf8");
  await assert.rejects(loadBotConfigs(filePath, credentials), /格式错误/);
});

test("角色提示词只在配置非空时前置", () => {
  assert.equal(
    buildBotPrompt(" 审查实现 ", "检查 package.json"),
    "角色：审查实现\n\n任务：检查 package.json",
  );
  assert.equal(buildBotPrompt("  ", "检查 package.json"), "检查 package.json");
});
