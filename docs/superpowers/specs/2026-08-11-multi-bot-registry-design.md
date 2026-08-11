# 多 bot 注册表与会话隔离设计

## 目标

按《多 bot 进群：用一份配置管理不同角色》实现：一个 Agent OS 进程从一份 JSON 注册表读取任意数量的飞书 bot，为每台 bot 使用独立凭证、默认 CLI 和角色说明建立长连接；同一群聊话题被不同 bot 处理时拥有独立的 Agent OS 会话与 CLI 恢复指针。

本次不实现 bot 之间自动派活、协作轮次/去重，也不实现下一节的 bot 工作目录配置。

## 现状约束

- 现有入口 `src/index.ts` 已包含完整的消息解析、会话状态机、CLI 运行、进度卡片和取消收尾链路。
- 现有会话键由 `chatId + threadId` 组成，`Session` 没有 `botId`。
- 当前 CLI 注册中心支持 `claude` 与 `codex`，生产入口已有单 bot 凭证和全局默认引擎读取逻辑。
- 所有文本文件继续使用 UTF-8，保持 ESM、Node.js 22+ 与现有测试风格。

## 方案

采用“注册表模块 + 配置驱动启动”的最小方案：

1. 新增 `src/core/bot-registry.ts`，负责读取 JSON、Zod 校验、重复 ID 检查、启用过滤、凭证解析和角色提示词拼接。
2. 新增 `config/bots.example.json`，把生产配置 `config/bots.json` 加入 `.gitignore`；`.env.example` 改为 `BOTS_CONFIG` 与每台 bot 的凭证变量。
3. `src/index.ts` 只保留一份既有消息处理函数，封装为 `startConfiguredBot(config)`，遍历 `BotConfig[]` 调用现有 `startBot`。每个连接闭包捕获自己的 `BotConfig`，共享会话管理器、运行表和上下文窗口。
4. `Session` 增加必填 `botId`；所有创建、恢复、状态更新和 CLI 会话 ID 更新都使用 `botId:chatId:threadId` 作为索引键。
5. `JsonSessionStore` 在校验前为没有 `botId` 的旧记录补入构造器提供的 `legacyBotId`，并在发生补齐或中断恢复时原子重写文件。入口把第一台已启用 bot 的 ID 作为旧记录归属。

## 配置与启动数据流

`BOTS_CONFIG`（默认 `config/bots.json`） → `loadBotConfigs()` → `BotConfig[]` → `new JsonSessionStore("data/sessions.json", botConfigs[0].id)` → `SessionManager.open()` → `Promise.all(botConfigs.map(startConfiguredBot))`。

配置项：

- `id`：`[a-z0-9][a-z0-9_-]{0,31}`，注册表内不可重复。
- `appIdEnv` / `appSecretEnv`：大写环境变量名；只为启用 bot 读取并校验非空凭证。
- `defaultCli`：`claude` 或 `codex`。
- `systemPrompt`：可选、默认空字符串；运行时以“角色：…\n\n任务：…”前置。
- `enabled`：可选、默认 `true`；为 `false` 的 bot 不读取凭证、不建立连接。

配置加载失败（文件不存在、JSON 格式错误、字段不合法、重复 ID、启用 bot 缺凭证、全部停用）直接抛错并阻止进程启动；错误信息包含 bot ID 或变量名，便于修复。

`package.json` 的 `start` 脚本增加 `--include 'config/*.json'`，配置变更触发 watch 重启并重新建立连接。

## 会话模型与兼容

`Session` 字段新增 `botId: string`。严格按原文采用 `SessionManager.resolve(message, cliId = "claude", botId = "default")`，并用 bot ID 查找/创建；生产入口始终传入当前配置的默认引擎与 `config.id`，显式 `/claude` 或 `/codex` 只覆盖新话题的默认引擎。

持久化 schema 要求 `botId` 非空。加载数组时：

- 没有 `botId` 的旧记录视为 legacy，补入 `legacyBotId` 后再校验；
- 无效记录继续按现有规则过滤；
- `creating`/`active` 继续恢复为 `idle`；
- 只要发生补齐、过滤或状态恢复，就通过现有写队列和临时文件原子重写。

这样升级前的会话仍归属注册表第一台 bot，升级后同一话题被其他 bot @ 时会创建新的独立会话。

## 入口行为

- 删除 `BOT_A_*`、`BOT_B_*` 和 `DEFAULT_CLI` 的启动读取；打印注册数量、恢复数量、各 CLI 和各 bot 默认引擎。
- `formatSessionStatus` 在“会话”前显示当前 bot ID。
- 新任务提示词使用 `buildBotPrompt(config.systemPrompt, cliRequest?.prompt ?? resolved)`。
- 任务标题、CLI 适配器、取消按钮、卡片更新、重试/恢复逻辑全部复用现有实现，不复制业务代码。
- 任意一个 `startBot` 连接失败时，`Promise.all` 使启动过程失败；所有连接成功时分别打印 `[Bot …] 已连接`。

## 测试与验收

新增 `src/core/bot-registry.test.ts` 覆盖：合法配置、默认字段、停用 bot 不取凭证、重复/非法 ID、缺凭证、全部停用、文件不存在/格式错误、角色提示词。

扩展会话测试覆盖：同群同话题不同 bot 创建两个会话；同 bot 仍复用；恢复索引使用 bot ID；旧记录补入 legacy bot ID 并重写；状态更新和 CLI 指针更新不丢失 bot ID。

回归验收：`pnpm build`、`pnpm test`、`git diff --check`；不启动真实飞书连接，不读取或写入 `.env` 中的真实凭证。

## 成功标准

1. 复制 `config/bots.example.json` 为 `config/bots.json` 并填写环境变量后，`pnpm build` 通过。
2. `pnpm start` 监听 `.env` 与 `config/*.json`，日志显示注册数量和每台 bot 的连接成功。
3. 同一话题分别 @ 两台 bot 时，各自显示独立 bot ID、执行引擎和 CLI 会话 ID。
4. 停用 bot 不会阻止其他 bot 启动；全部停用或配置错误时进程明确失败。
5. 旧 `data/sessions.json` 在首次启动后自动迁移到含 `botId` 的结构。
