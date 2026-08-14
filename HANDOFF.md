# HANDOFF

## 目标与验收

把 agent-os 参考 deepseek-harness 全面接入 Cordis，实现「一切皆为插件」：index.ts 的巨型编排拆成服务与插件，cordis.yml 声明式装配，执行引擎与斜杠命令都做成可插拔插件。验收标准：`pnpm build` 通过、全量测试通过、真实启动能连上飞书、移除插件即可下线对应能力。

后续追加：ACP 接入做成标准能力并插件化（engines/acp），执行引擎能力全部由 adapter 自描述（消除引擎 id 特判）。

## 当前状态

Cordis 化改造 + ACP 常驻进程 + 标准 ACP 接入插件化 + 引擎特判清除 + 死代码清理均已完成并全量验证通过（`pnpm test` 142/142）。工作树包含全部改动（含 `src/plugins/`、`cordis.yml`、ACP 相关新模块），**尚未提交**。

## 已完成

- `src/index.ts` 缩减为引导入口：创建根 Context 并挂载 loader 插件。
- 新增 `src/plugins/`：types.ts（服务/事件契约）、loader.ts（cordis.yml 装配 + waitForAllActive）、八个服务、router 路由插件、engines/* 引擎插件、commands/* 斜杠命令插件。
- 事件解耦：`bot/message`、`bot/card-action` 由 lark 发出、router 消费；`task/result` 由 tasks 广播、collaboration 监听自动交接。
- `src/cli/registry.ts` 纯插件登记（registerCliAdapter），引擎可用性由 cordis.yml 决定。
- **ACP 常驻进程**（`src/cli/acp-daemon.ts`）：单常驻 ACP server 进程，多会话并发（通知按 sessionId 路由）、空闲自动回收、崩溃自动重连、取消改为 session/cancel 软取消。
- **标准 ACP 接入**（`src/cli/acp-adapter.ts` + `src/plugins/engines/acp.ts`）：任意提供 ACP server 的 CLI 可通过 cordis.yml 的 engines 列表接入；DimAgent 的 ACP 由该插件提供，不再内嵌在 dimagent-adapter。
- **引擎特判清除**：原生会话能力移到 `CliAdapter.listNativeSessions`（claude/codex adapter 自实现协议）、compact 用 `buildCompactPlan` 能力探测、断流重试用 `retryOnDisconnect`、卡片文案用 `compactDetail`。
- **死代码清理**：删除 `parseCliId`/`resolveCliWorkdir`（仅被测试使用）及对应测试、未使用参数（router bot）、无消费者 export（AcpRunError）；`tsc --noUnusedLocals` 归零。
- AGENTS.md 新增文首最高准则「一切皆为插件」，README 更新 ACP/常驻说明。
- `package.json`：test 脚本包含全部测试文件；新增 `@agentclientprotocol/sdk`、`cordis`、`yaml` 依赖。

## 下一步

1. 提交并推送全部改动（涉及多个未提交会话的成果，提交前先与用户确认分组与排除项）。
2. 确认 `docs/superpowers/specs/*` 4 个旧架构设计文档的删除是否有意（文件已删、git 未提交）；`docs/pty-roadmap.md`（PTY 接入路线图，规划中）与 `botmux-ref/`（参考实现）为未跟踪资产，确认是否纳入版本管理。
3. 端到端验收：启动服务，在飞书新话题完成开发任务，确认卡片、停止、reviewBy 协作交接与改造前一致。
4. 可尝试「插件可插拔」验证：在 cordis.yml 中 `disabled: true` 某个命令或引擎插件，确认对应能力下线且启动正常。

## 决定、约束与失败教训

- 装配方式：cordis.yml 声明式装配，loader 用静态插件注册表（pluginRegistry）解析插件名，避免动态 import。
- 服务初始化模式：插件 apply 内 `new XService(ctx)` 直接构造服务，再用实例方法异步初始化；不要在 apply 里 `ctx.x.xxx` 访问自己提供的服务。
- 深层 inject 级联不被 `await ctx.plugin()` 等待，loader 必须用 `waitForAllActive` 轮询 `ctx.registry`。两条坑已写入 AGENTS.md 错题本。
- ACP SDK 的 `connectWith` 每次建连、用完即关，无法常驻复用；应用 `app.connect(stream)` 持久持有 `connection.agent`，按 JSON-RPC id 匹配并发、按 sessionId 路由通知。已写入 AGENTS.md 错题本第 3 条。
- 能力自描述：`CliAdapter` 用可选成员声明能力（listNativeSessions/retryOnDisconnect/compactDetail/buildCompactPlan 抛错=不支持），调用方不按引擎 id 特判。
- 平台（lark）与服务（sessions 等）仍是真实实现，host 集成测试用假 cli/lark/config 服务替换。
- Windows PowerShell 7、文本 UTF-8、源码注释使用中文；不得提交 `.env`、`config/bots.json`。

## 相关文件

- `src/index.ts`、`cordis.yml`、`package.json`
- `src/plugins/`（types/loader/config/sessions/cli/lark/cards/commands/tasks/collaboration/router + engines/* + commands/*）
- `src/cli/`（registry/runner/acp-daemon/acp-runner/acp-adapter/claude-adapter/codex-adapter/dimagent-adapter/native-sessions/native-compact）
- `AGENTS.md`、`README.md`

## 验证

- `pnpm build`：通过。
- `pnpm test`：142/142 通过。
- `tsc --noUnusedLocals --noUnusedParameters`：0 报错。
- 真实 `dim acp` 端到端：常驻进程复用（同进程同会话续接）、并发多会话、通过 engines/acp 插件装配注册均验证通过。
- 真实装配冒烟：用真实 config/bots.json 装配，多 bot、引擎、命令、会话全部就绪。
- `git diff --check`：通过（仅有 LF/CRLF 提示）。

## 阻塞与未决问题

- **工作区大量改动未提交**（含多轮会话成果：Cordis 化 + ACP 常驻 + 标准 ACP 插件化 + 死代码清理）。
- `docs/superpowers/specs/*` 4 个旧架构设计文档已删除但未提交、未确认是否有意；`docs/pty-roadmap.md`、`botmux-ref/` 为未跟踪资产。
- 未在真实飞书链路做任务卡片/停止/协作的端到端人工验收（依赖真实 bot 凭证与话题群）。
- 交接单仍为内存存储，服务重启丢失未领取任务，这是既有设计，未改动。
