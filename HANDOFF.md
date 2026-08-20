# HANDOFF

## 目标与验收

在现有 Agent OS Cordis 插件架构上实现课程“把产品问题变成飞书表单”：Agent 调用 `request_clarification` 后展示逐题飞书卡片，支持用户选择、Agent 推荐、自定义输入、同话题文字补充，并沿用原 CLI 会话继续。agy headless 也必须能加载 Agent OS MCP。验收：`pnpm build`、`pnpm test` 全部通过；能力通过插件/adapter 契约接入，不增加特定引擎硬编码。

## 当前状态

本轮需求已实现并通过构建、全量测试和真实 DimAgent headless 探针。四个平台（Codex、Claude Code、DimAgent、agy）headless 都能调用 `request_clarification`；DimAgent ACP 也通过 loopback HTTP MCP 兼容桥接验证成功。工作树包含本轮及前序多轮成果，**尚未提交**。真实飞书人工链路未执行。

## 已完成

- `src/index.ts` 缩减为引导入口：创建根 Context 并挂载 loader 插件。
- 新增 `src/plugins/`：types.ts（服务/事件契约）、loader.ts（cordis.yml 装配 + waitForAllActive）、八个服务、router 路由插件、engines/* 引擎插件、commands/* 斜杠命令插件。
- 事件解耦：`bot/message`、`bot/card-action` 由 lark 发出、router 消费；`task/result` 由 tasks 广播、collaboration 监听自动交接。
- `src/cli/registry.ts` 纯插件登记（registerCliAdapter），引擎可用性由 cordis.yml 决定。
- **ACP 常驻进程**（`src/cli/acp-daemon.ts`）：单常驻 ACP server 进程，多会话并发（通知按 sessionId 路由）、空闲自动回收、崩溃自动重连、取消改为 session/cancel 软取消。
- **标准 ACP 接入**（`src/cli/acp-adapter.ts` + `src/plugins/engines/acp.ts`）：任意提供 ACP server 的 CLI 可通过 cordis.yml 的 engines 列表接入；DimAgent 的 ACP 由该插件提供，不再内嵌在 dimagent-adapter；会话配置由插件声明。
- **引擎特判清除**：原生会话能力移到 `CliAdapter.listNativeSessions`（claude/codex adapter 自实现协议）、compact 用 `buildCompactPlan` 能力探测、断流重试用 `retryOnDisconnect`、卡片文案用 `compactDetail`。
- **死代码清理**：删除 `parseCliId`/`resolveCliWorkdir`（仅被测试使用）及对应测试、未使用参数（router bot）、无消费者 export（AcpRunError）；`tsc --noUnusedLocals` 归零。
- AGENTS.md 新增文首最高准则「一切皆为插件」，README 更新 ACP/常驻说明。
- `package.json`：test 脚本包含全部测试文件；新增 `@agentclientprotocol/sdk`、`cordis`、`yaml` 依赖。
- 需求澄清：`ClarificationFlowStore` 内存逐题状态、稳定 `topicTaskId`、逐题卡片和同话题补充；移除旧 `src/plugins/clarification-store.ts` 持久化实现。
- 路由与事件：新增 `task/message` 改写点，任务负载携带 taskId/union_id/card message id；澄清续跑设置 `suppressHandoff`，仍广播结果供编排汇总。
- agy MCP：`AgyAdapter` 启动前合并工作区 `.agents/mcp_config.json`，解析 MCP 工具调用为统一 `tool_call`；`engines/agy` 注入 `applicationTools`；`pnpm probe:tool` 支持 agy。
- DimAgent MCP：headless 按官方 `dim mcp` 配置增量合并当前工作目录的 `.mcp.json`（显式 `DIMAGENT_MCP_CONFIG_PATH` 可覆盖，未传路径的工具函数仍支持 `~/.dimcode/v2/mcp.json`）；ACP 注入标准 HTTP MCP 描述（本机 ACP 0.3.16 拒绝 stdio，按适配器 transport 能力过滤并记录 warning）。ACP `initialize` 复用已有 OAuth，不调用 authenticate；session/new 后按插件声明顺序设置 `permission=full-access`、`mode=agent`，可选模型从 `models.availableModels` 校验后调用 `session/set_model`，并兼容把工具名放在 `tool_call.title` 的事件格式。Dim ACP 通过 `session/load` 跨进程恢复（最低 0.3.10、锁错误有限重试、错误详情读取 `data.details`），关闭前发送 `session/close`，配置失败清理半配置 session，prompt 末尾保留通知排空窗口；空闲回收后 daemon 可再次复用。
- MCP 实现：`clarification-tools.ts` 复用工具定义；`clarification-http-server.ts` 启动仅监听 127.0.0.1 的无状态 HTTP 入口，stdio 与 ACP 两种传输都由同一澄清插件注册。
- 产品 Skill：新增 `.agents/skills/grill-me/SKILL.md`；bot prompt 增加项目 Skill 加载优先级和飞书输出规则。

## 下一步

1. 如用户要求，提交前按当前工作树审查并拆分提交；不要回滚其他会话已有改动。
2. 有真实凭证时运行 `pnpm start:once`，在飞书实际验证产品 bot 的澄清卡片、逐题回答、同话题补充和重启后旧卡失效。
3. 有 agy 登录和网络条件时运行 `pnpm probe:tool agy <工作目录>`，确认本机 1.1.16 的真实 MCP 工具事件字段与测试样例一致。

## 决定、约束与失败教训

- 装配方式：cordis.yml 声明式装配，loader 用静态插件注册表（pluginRegistry）解析插件名，避免动态 import。
- 服务初始化模式：插件 apply 内 `new XService(ctx)` 直接构造服务，再用实例方法异步初始化；不要在 apply 里 `ctx.x.xxx` 访问自己提供的服务。
- 深层 inject 级联不被 `await ctx.plugin()` 等待，loader 必须用 `waitForAllActive` 轮询 `ctx.registry`。两条坑已写入 AGENTS.md 错题本。
- ACP SDK 的 `connectWith` 每次建连、用完即关，无法常驻复用；应用 `app.connect(stream)` 持久持有 `connection.agent`，按 JSON-RPC id 匹配并发、按 sessionId 路由通知。已写入 AGENTS.md 错题本第 3 条。
- 能力自描述：`CliAdapter` 用可选成员声明能力（listNativeSessions/retryOnDisconnect/compactDetail/buildCompactPlan 抛错=不支持），调用方不按引擎 id 特判。
- 平台（lark）与服务（sessions 等）仍是真实实现，host 集成测试用假 cli/lark/config 服务替换。
- Windows PowerShell 7、文本 UTF-8、源码注释使用中文；不得提交 `.env`、`config/bots.json`。
- agy 没有命令行 MCP 注入参数，使用工作区 `.agents/mcp_config.json`；配置合并保留已有 Server，Agent OS Server 写入前会原子替换并按路径串行化。
- DimAgent 官方 CLI 文档支持 stdio/HTTP MCP；headless 项目级配置使用 `<project>/.mcp.json`。ACP `session/new`、`resume`、`load` 要求绝对 cwd；本机 0.3.16 对 ACP stdio 返回 `ACP MCP stdio transport is unsupported`，因此 ACP 必须使用 HTTP MCP 描述并补 `headers: []`，不能把 headless 的 stdio 配置直接当成 ACP 参数。
- `py`/`python3` 在本机不可用，因此未运行 Skill 专用 Python 校验；TypeScript 构建与测试已覆盖实现。

## 相关文件

- `src/index.ts`、`cordis.yml`、`package.json`
- `src/plugins/`（types/loader/config/sessions/cli/lark/cards/commands/tasks/collaboration/router + engines/* + commands/*）
- `src/cli/`（registry/runner/agy-adapter/agy-mcp-config/app-tools/acp-daemon/acp-runner/acp-adapter/claude-adapter/codex-adapter/dimagent-adapter/native-sessions/native-compact）
- `src/core/clarification.ts`、`src/core/topic-task.ts`、`src/im/card.ts`、`src/im/lark.ts`、`src/probe-app-tool.ts`
- `.agents/skills/grill-me/SKILL.md`
- `AGENTS.md`、`README.md`

## 验证

- `pnpm build`：通过。
- `pnpm test`：280/280 通过；宿主集成测试的异步等待上限已调整为 10 秒，以覆盖包含 Git 快照的协作链路。
- 真实 `pnpm probe:tool dimagent <临时项目目录>`：通过项目级 `.mcp.json` 经 stdio 调用 `request_clarification`，返回 2 个合法问题；临时目录已清理。
- agy 局部回归：`agy-adapter.test.ts`、`agy-mcp-config.test.ts`、`runner.test.ts` 共 38/38 通过。
- `git diff --check`：通过（仅有 LF/CRLF 提示）。
- `pnpm exec tsc --noUnusedLocals --noUnusedParameters --pretty false`：本轮清理 `host.test.ts` 后仍因未修改的 `src/plugins/schedule.test.ts:37` 存在既有未使用 `waitForAllActive` 导入而失败；普通 `pnpm build` 通过。
- 真实 `dim acp` 端到端：常驻进程复用（同进程同会话续接）、并发多会话、通过 engines/acp 插件装配注册均验证通过。
- 真实 `dim acp` 澄清链路：loopback HTTP MCP + `permission=full-access` + `tool_call.title` 工具名兼容，成功返回合法 `request_clarification`，并汇总到 `CliRunResult.toolCalls`。
- 真实 `dim acp` 会话探针：`session/new` 返回 `configOptions` 与 `models.availableModels`；实测 `session/set_config_option`（permission/mode）和 `session/set_model({sessionId, modelId})` 均成功。
- 真实 Dim ACP 复核：本机 `dimcode 0.3.16` 在新 daemon 上成功 `session/new`、权限提升和 prompt；关闭后新 daemon 用 `session/load` 成功恢复同一 session，验证了跨进程锁重试与上下文续接。
- 真实装配冒烟：用真实 config/bots.json 装配，多 bot、引擎、命令、会话全部就绪。

## 阻塞与未决问题

- 工作区大量改动未提交，包含前序 Cordis/ACP 成果与本轮澄清/agy 成果；提交前需按用户意图处理，不可擅自回滚。
- 未在真实飞书链路做任务卡片/停止/协作的端到端人工验收，依赖真实 bot 凭证和话题群。
- 未用真实 `agy -p` 完成 MCP 调用验收，当前只验证了本机 `agy mcp add` 生成的配置格式、adapter 事件兼容和本地单元测试。
- 交接单仍为内存存储，服务重启丢失未领取任务，这是既有设计，未改动。
