/**
 * loader 装配测试：验证 cordis.yml 声明式装配、disabled 跳过、
 * 未注册插件与缺失/非法配置的错误边界。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Context } from "cordis";
import { parse } from "yaml";
import { apply as loaderApply, name as loaderName } from "./loader.js";

const loader = { name: loaderName, apply: loaderApply };

test("仓库默认 cordis.yml 可被 YAML 解析且插件条目格式合法", async () => {
  const content = await readFile(resolve(process.cwd(), "cordis.yml"), "utf8");
  const document = parse(content) as { plugins?: Array<{ name?: unknown }> };
  assert.ok(document.plugins?.length);
  assert.ok(document.plugins.every((entry) => typeof entry.name === "string"));
});

function yamlPath(path: string): string {
  // YAML 普通标量中反斜杠有歧义，统一转成正斜杠保证 Windows 可解析。
  return path.replaceAll("\\", "/");
}

/** 在临时目录里准备 bots.json 与 cordis.yml，运行后清理。 */
async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "threadpilot-loader-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeBotsConfig(dir: string): Promise<string> {
  const botsPath = join(dir, "bots.json");
  await writeFile(
    botsPath,
    JSON.stringify({
      teamLeader: "testbot",
      bots: [
        {
          id: "testbot",
          appIdEnv: "TEST_APP_ID",
          appSecretEnv: "TEST_APP_SECRET",
          defaultCli: "codex",
          role: "测试角色",
          workspace: ".",
        },
      ],
    }),
  );
  return botsPath;
}

test("loader 按 cordis.yml 挂载插件并注入服务", async () => {
  await withTempDir(async (dir) => {
    process.env.TEST_APP_ID = "cli_test";
    process.env.TEST_APP_SECRET = "test_secret";
    const botsPath = await writeBotsConfig(dir);
    const ymlPath = join(dir, "cordis.yml");
    await writeFile(
      ymlPath,
      [
        "plugins:",
        `  - name: config`,
        `    config:`,
        `      botsPath: ${yamlPath(botsPath)}`,
        `  - name: prompts`,
        `  - name: team`,
        `  - name: sessions`,
        `    config:`,
        `      storePath: ${yamlPath(join(dir, "sessions.json"))}`,
        `  - name: cli`,
        "  - name: application-tools",
        `  - name: engines/codex`,
        `  - name: engines/acp`,
        `  - name: cards`,
        `  - name: product-spec`,
        `  - name: commands`,
        `  - name: commands/status`,
        `  - name: tasks`,
        `  - name: task-retry`,
      ].join("\n"),
    );

    const root = new Context();
    await root.plugin(loader, { path: ymlPath });

    await root.inject(["config", "team", "sessions", "cli", "applicationTools", "commands", "tasks"], (ctx) => {
      assert.equal(ctx.config.bots.length, 1);
      assert.equal(ctx.team.leaderBotId, "testbot");
      assert.equal(ctx.config.bots[0].id, "testbot");
      assert.equal(ctx.sessions.manager.size, 0);
      assert.equal(ctx.cli.get("codex").id, "codex");
      // engines/acp 插件注册标准 ACP 接入（默认提供 dimagent 的 ACP 引擎）。
      assert.equal(ctx.cli.get("dimagent", "acp").accessMode, "acp");
      assert.equal(ctx.commands.has("status"), true);
      assert.ok(
        ctx.applicationTools.list().some((server) =>
          server.tools.includes("request_spec_approval"),
        ),
        "product-spec 插件应登记产品文档工具",
      );
      // 未在 cordis.yml 声明的命令不应被注册。
      assert.equal(ctx.commands.has("help"), false);
    });
  });
});

test("tasks 不依赖 team 插件也能独立装配", async () => {
  await withTempDir(async (dir) => {
    process.env.TEST_APP_ID = "cli_test";
    process.env.TEST_APP_SECRET = "test_secret";
    const botsPath = await writeBotsConfig(dir);
    const ymlPath = join(dir, "cordis.yml");
    await writeFile(
      ymlPath,
      [
        "plugins:",
        `  - name: config`,
        `    config:`,
        `      botsPath: ${yamlPath(botsPath)}`,
        `  - name: prompts`,
        `  - name: sessions`,
        `    config:`,
        `      storePath: ${yamlPath(join(dir, "sessions.json"))}`,
        `  - name: cli`,
        "  - name: application-tools",
        `  - name: engines/codex`,
        `  - name: cards`,
        `  - name: tasks`,
      ].join("\n"),
    );

    const root = new Context();
    await root.plugin(loader, { path: ymlPath });
    await root.inject(["tasks"], (ctx) => {
      assert.equal(ctx.tasks.activeRunCount, 0);
    });
  });
});
test("loader 跳过 disabled 插件", async () => {
  await withTempDir(async (dir) => {
    process.env.TEST_APP_ID = "cli_test";
    process.env.TEST_APP_SECRET = "test_secret";
    const botsPath = await writeBotsConfig(dir);
    const ymlPath = join(dir, "cordis.yml");
    await writeFile(
      ymlPath,
      [
        "plugins:",
        `  - name: config`,
        `    config:`,
        `      botsPath: ${yamlPath(botsPath)}`,
        `  - name: cli`,
        `  - name: cards`,
        `  - name: commands`,
        `  - name: commands/status`,
        `  - name: commands/help`,
        `    disabled: true`,
      ].join("\n"),
    );

    const root = new Context();
    await root.plugin(loader, { path: ymlPath });

    await root.inject(["commands"], (ctx) => {
      assert.equal(ctx.commands.has("status"), true);
      assert.equal(ctx.commands.has("help"), false);
    });
  });
});

test("loader 拒绝引用未注册的插件", async () => {
  await withTempDir(async (dir) => {
    const ymlPath = join(dir, "cordis.yml");
    await writeFile(ymlPath, "plugins:\n  - name: no-such-plugin\n");

    const root = new Context();
    await assert.rejects(
      async () => {
        await root.plugin(loader, { path: ymlPath });
      },
      /未注册的插件: no-such-plugin/,
    );
  });
});

test("loader 找不到装配文件时报错", async () => {
  const root = new Context();
  await assert.rejects(
    async () => {
      await root.plugin(loader, { path: join(tmpdir(), "missing-cordis.yml") });
    },
    /找不到插件装配文件/,
  );
});

test("loader 接受 config 为空的 YAML 块（解析为 null）", async () => {
  await withTempDir(async (dir) => {
    process.env.TEST_APP_ID = "cli_test";
    process.env.TEST_APP_SECRET = "test_secret";
    const botsPath = await writeBotsConfig(dir);
    const ymlPath = join(dir, "cordis.yml");
    await writeFile(
      ymlPath,
      [
        "plugins:",
        `  - name: config`,
        `    config:`,
        `      botsPath: ${yamlPath(botsPath)}`,
        `  - name: cli`,
        "  - name: cards",
        "    config:",
        "      # 空块只有注释，YAML 会解析为 null；必须与缺失一样放行。",
        "  - name: commands",
      ].join("\n"),
    );

    const root = new Context();
    await root.plugin(loader, { path: ymlPath });

    await root.inject(["cards", "commands"], (ctx) => {
      assert.equal(typeof ctx.cards.task, "function");
      assert.equal(ctx.commands.has("help"), false);
    });
  });
});

test("loader 拒绝空插件列表", async () => {
  await withTempDir(async (dir) => {
    const ymlPath = join(dir, "cordis.yml");
    await writeFile(ymlPath, "plugins: []\n");

    const root = new Context();
    await assert.rejects(async () => {
      await root.plugin(loader, { path: ymlPath });
    });
  });
});
