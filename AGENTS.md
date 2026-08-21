# agent-os

把飞书变成 AI 编程 CLI（Claude Code / Codex / DimAgent）的指挥台。
一个话题对应一个任务；Agent 之间可以协作；定时任务可以主动触发工作。

## 最重要的行为准则：一切皆为插件

> 本项目所有设计与改动，必须把「一切皆为插件」作为最高优先级的准则，优先级高于其他任何工程约定。

**核心思想**：Agent OS 的能力不是写死的，而是由插件装配而成——`cordis.yml` 声明启用哪些插件及参数，`src/plugins/loader.ts` 按声明挂载。能力通过 `ctx.<service>` 与类型化事件协作，而不是互相 import 具体实现。

**落地要求**：

1. **新增能力 = 新增插件**。任何新能力（服务、命令、执行引擎、平台接入、定时任务等）都必须写成独立插件：在 `loader.ts` 的 `pluginRegistry` 登记插件名，在 `cordis.yml` 声明启用及其参数。
2. **协作靠服务与事件，不靠 import 实现**。插件之间通过 `ctx.<service>`（cli/sessions/tasks/cards/commands/collaboration…）和类型化事件（`bot/message`、`bot/card-action`、`task/result`…）解耦；共享契约统一在 `src/plugins/types.ts` 声明，禁止跨插件直接引用具体类实现。
3. **下线 / 替换 / 调整能力 = 改 cordis.yml**。移除条目、设置 `disabled: true`、或替换实现插件（如换平台 = 换掉 lark 插件、换引擎 = 增删 engines/* 插件），不改核心代码。
4. **禁止能力归属硬编码**。不要用 `if (xxx === "某引擎/某平台")` 之类的方式把一种能力写死给某个具体实现——如 ACP 接入是标准能力（`engines/acp` 插件 + 通用 `AcpAdapter`），任何引擎都能声明使用。
5. **验收自检（反例）**：若改动需要直接 import 另一个具体模块的实现（类型导入除外）、需要给特定引擎/平台开特判分支、或新功能没有在 `cordis.yml` 中出现，即为违反本准则，应重构为插件化方案。

**参考实现**：`src/plugins/loader.ts`（装配）、`src/plugins/types.ts`（契约）、`src/plugins/engines/*`（引擎插件）、`src/plugins/commands/*`（命令插件）、`src/cli/acp-adapter.ts` + `engines/acp`（标准 ACP 接入插件化范例）。

## 运行

- `pnpm dev`：监听源码和 `.env` 变化并自动重启
- `pnpm start`：同 `pnpm dev`
- `pnpm start:once`：不启用 watch，直接启动飞书机器人
- `pnpm build`：执行 TypeScript 编译检查并输出到 `dist/`
- `pnpm test`：运行 CLI、飞书消息、卡片与会话模型测试
- `pnpm probe:cli`：从标准输入读取 Codex/Claude/DimAgent JSONL 并输出时间线
- `pnpm probe:tool <claude|codex|dimagent|agy> [工作目录]`：不经飞书直接驱动 CLI 调用 `request_clarification`，验证 MCP 工具链与 Schema 校验

## CLI Headless 调试

Codex 为主路径：

```powershell
codex exec --json --sandbox workspace-write --skip-git-repo-check "1加1等于几？只回答数字本身" | pnpm probe:cli
codex exec resume --json --skip-git-repo-check <thread_id> "再加1呢？只回答数字本身" | pnpm probe:cli
```

Claude Code：

```powershell
claude -p "1加1等于几？只回答数字本身" --output-format stream-json --verbose | pnpm probe:cli
claude --resume <session_id> -p "再加1呢？只回答数字本身" --output-format stream-json --verbose | pnpm probe:cli
```

## 模块地图

### 引导与插件装配（Cordis「一切皆为插件」）

- `src/index.ts`：引导入口——创建根 Context 并挂载 loader 插件，然后由 cordis.yml 声明式装配全部能力
- `cordis.yml`：插件装配文件，声明启用哪些插件及其参数；移除条目或设置 `disabled: true` 即可下线对应能力
- `src/plugins/types.ts`：插件公共契约——集中声明 Cordis 服务（ctx.config/team/sessions/cli/applicationTools/lark/cards/commands/collaboration/tasks）与事件（bot/message、bot/card-action、task/message、task/prompt-context、task/tool-calls、task/result）以及路由/命令/任务/协作共享的输入类型
- `src/plugins/loader.ts`：装配插件——读取 cordis.yml，按插件名从注册表挂载；等待全部插件进入 ACTIVE（含深层 inject 级联）
- `src/plugins/config.ts`：config 服务——加载并校验 bot 注册表（config/bots.json + 环境变量凭证），只提供配置数据
- `src/plugins/team.ts`：team 服务——提供 TeamRegistry、团队上下文与 Skill 诊断，并通过 task/prompt-context 扩展任务提示词
- `src/plugins/sessions.ts`：sessions 服务——把 SessionManager 与 JsonSessionStore 挂到 ctx.sessions
- `src/plugins/application-tools.ts`：应用工具注册服务——插件声明 stdio MCP Server 及可选 ACP HTTP 入口，执行引擎只消费通用描述
- `src/plugins/clarification.ts`：澄清插件——启动 loopback HTTP MCP、认领结构化工具调用、展示逐题飞书表单、处理同话题补充并恢复 CLI 会话（流程仅存内存，重启后旧卡失效）
- `src/plugins/clarification-tool.ts`：澄清插件提供给 CLI 探针和 MCP 注入的 Server 描述
- `src/plugins/product-spec.ts`：产品文档插件——注册 `request_spec_approval`、校验 Spec/Tickets 真实落盘，并把任务终态替换为只读待确认卡
- `src/plugins/product-spec-tool.ts`：产品文档插件提供给 stdio/ACP MCP 注入的 Server 描述
- `src/plugins/lark.ts`：lark 平台服务——启动多台飞书 bot，把消息与卡片回调翻译成 bot/message、bot/card-action 事件
- `src/plugins/cards.ts`：cards 服务——任务/会话/协作卡片渲染与节流更新器的统一出口
- `src/plugins/commands.ts`：commands 服务——斜杠命令注册表
- `src/plugins/tasks.ts`：tasks 服务——一轮 CLI 执行的编排（active 状态、资源下载、任务卡片、进度、取消收尾），完成后广播 task/result
- `src/plugins/collaboration.ts`：collaboration 服务——交接单、轮次去重与审查派发；监听 task/result 自动交接
- `src/plugins/workspaces.ts`：workspaces 服务——创建/回收 QA 隔离快照并计算稳定工作树 revision
- `src/plugins/qa-gate.ts`：QA 质量闸门——解析 QAResult、校验实际快照 revision，并按 pass/changes_requested/blocked 闭环路由
- `src/plugins/router.ts`：router 路由插件——协作识别、会话解析、task/message 改写、命令派发与任务启动
- `src/plugins/orchestration.ts`：orchestration 服务——把大任务拆解成子任务并行派发（topic/same-topic）、维护有界运行表、监听 task/result|failed 更新子任务状态，并提供失败子任务一键重试（retrySubTask，鉴权/去重/次数上限）
- `src/plugins/orchestration/live-panel.ts`：实时面板子插件——订阅 orchestration/update 挂起并节流刷新面板卡片，终态定格、淘汰清理
- `src/plugins/orchestration/actions.ts`：面板动作子插件（可选）——启动时置位重试能力，认领 retry_subtask 卡片动作并映射 toast；移除即无重试按钮
- `src/plugins/engines/*.ts`：引擎插件（claude/codex/dimagent/agy/acp），通过 ctx.cli.register() 登记执行适配器；其中 `engines/acp` 是标准 ACP 接入——从 cordis.yml 的 engines 列表注册任意提供 ACP server 的 CLI
- `src/plugins/commands/*.ts`：斜杠命令插件（help/new/resume/compact/status/team/cd/close/schedule），通过 ctx.commands.register() 登记
- `src/plugins/loader.test.ts`：cordis.yml 装配、disabled 跳过与错误边界测试
- `src/plugins/commands/team.ts`：/team 命令插件——经 ctx.team、ctx.lark、ctx.cli 与 ctx.cards 展示成员和真实长连接状态
- `src/plugins/host.test.ts`：最小 Agent OS 集成测试——事件路由、命令派发、任务生命周期、停止与协作交接

### 核心与执行引擎（纯函数模块，供服务插件复用）

- `src/core/bot-registry.ts`：多 bot 注册表读取、校验、凭证解析与角色提示词
- `src/core/bot-registry.test.ts`：注册表字段、启用过滤、凭证和错误边界测试
- `src/core/project-skills.ts`：工作区覆盖与 Agent OS 内置 Skill 的查找、读取和提示词复用
- `src/core/project-skills.test.ts`：Skill 覆盖优先级、内置回退和真实缺失测试
- `src/core/team-registry.ts`：团队成员注册表、团队上下文与项目 Skill 检查
- `src/core/team-registry.test.ts`：团队成员查询、上下文和缺失 Skill 检查测试
- `src/core/collaboration.ts`：bot 间同话题交接单、目标领取鉴权和协作轮次键
- `src/core/collaboration.test.ts`：交接单一次性领取、目标鉴权和轮次键测试
- `src/core/orchestration.ts`：编排数据契约——run/子任务结构（ownerOpenId/retryCount）、拆解解析、taskId 编解码、一次性重试令牌与运行表裁剪
- `src/core/workspace.ts`：bot 与话题工作目录的相对路径解析和目录校验
- `src/core/workspace.test.ts`：工作目录解析、空路径和目录类型边界测试
- `src/core/workspace-revision.ts`：基于 HEAD、dirty diff 与未跟踪文件内容生成稳定工作树指纹
- `src/core/workspace-revision.test.ts`：HEAD、已跟踪改动与未跟踪内容指纹变化测试
- `src/core/workspace-snapshot.ts`：把 Developer 交付版本物化为 QA 专用隔离 worktree/目录快照
- `src/core/workspace-snapshot.test.ts`：dirty 快照物化、依赖复用与安全清理测试
- `src/core/qa-result.ts`：QAResult Schema、结论动作与测试/缺陷语义一致性校验
- `src/core/qa-result.test.ts`：三态结论、动作、测试状态与缺陷等级一致性测试
- `src/core/session-manager.ts`：按 bot 隔离的话题映射、状态机与持久化协调
- `src/core/session-manager.test.ts`：会话路由、恢复、回滚和状态流转测试
- `src/core/session-store.ts`：会话 JSON 校验、重启恢复与原子写盘
- `src/core/session-store.test.ts`：会话文件清理、恢复和并发保存测试
- `src/core/command-parser.ts`：会话控制命令（含 `/new`、`/resume`、`/compact`）与按注册表动态解析的引擎请求（`/claude`、`/codex`、`/dimagent`、`/agy` 等已登记引擎）
- `src/core/command-parser.test.ts`：会话命令、compact 参数、引擎选择和误识别边界测试
- `src/core/task-abort.ts`：任务发起人鉴权、运行实例隔离与停止信号
- `src/core/task-abort.test.ts`：停止结果、权限、重复点击和旧卡片隔离测试
- `src/core/task-progress.ts`：高频 CLI 事件的工具配对、上下文增量与稳定进度快照
- `src/core/task-progress.test.ts`：并发工具、上下文起点、耗时和记录上限测试
- `src/core/clarification.ts`：澄清请求数据结构——Zod Schema 约束 Agent 结构化提问，既是 MCP 工具参数也是飞书卡片输入
- `src/core/clarification.test.ts`：Schema 边界校验与工具调用历史提取测试
- `src/core/product-spec.ts`：产品文档提交契约——校验结构化参数、工作区路径边界与 Spec/Tickets 真实产物
- `src/core/product-spec.test.ts`：产品文档 Schema、路径安全与真实落盘检查测试
- `src/core/topic-task.ts`：按群 ID 与话题 ID 生成稳定任务编号
- `src/core/topic-task.test.ts`：同话题复用与跨话题隔离测试
- `src/cli/types.ts`：多引擎统一适配器、事件和运行结果契约
- `src/cli/acp-adapter.ts`：通用 ACP 适配器——把任意提供 ACP server 的 CLI（id/command/args/session 配置驱动）以标准接入方式登记，与具体供应商解耦
- `src/cli/acp-adapter.test.ts`：标准 ACP 接入参数、会话配置、展示名回退、compact 与失效会话识别测试
- `src/cli/registry.ts`：多引擎注册表（registerCliAdapter 供引擎插件登记）、查找与 CLI ID 校验
- `src/cli/registry.test.ts`：注册表、默认 Codex 和非法配置测试
- `src/cli/app-tools.ts`：应用工具公共契约——把插件注册的 MCP Server 转换为各 CLI/ACP 的启动参数并识别工具调用
- `src/cli/command-resolver.ts`：Windows 下安全定位 CLI 的真实可执行入口
- `src/cli/runner.ts`：通用无头 CLI 子进程、流式事件回调、超时、取消和退出处理
- `src/cli/acp-daemon.ts`：通用 ACP 常驻进程——绝对 cwd、会话权限/模式/模型配置、单进程多会话并发、空闲回收、崩溃重连与软取消
- `src/cli/acp-daemon.test.ts`：会话配置顺序、绝对 cwd、常驻复用、并发路由、空闲回收与崩溃重连测试
- `src/cli/acp-runner.ts`：在 AcpDaemon 上执行一轮 ACP 的入口；无注入时创建临时 daemon 跑完即回收
- `src/cli/acp-runner.test.ts`：ACP 握手、会话续接、工具通知与消息分片测试
- `src/cli/process-tree.ts`：headless/ACP Runner 共用的跨平台子进程树清理
- `src/cli/dimagent-adapter.ts`：DimAgent headless 参数、项目级 MCP 配置、JSONL 事件与工具调用翻译
- `src/cli/dim-mcp-config.ts`：DimAgent headless 用户/项目 MCP 配置增量合并
- `src/cli/dimagent-adapter.test.ts`：DimAgent 两种接入模式、事件翻译和能力边界测试
- `src/cli/agy-adapter.ts`：Antigravity CLI (agy) 适配器——headless 参数、工作区 MCP 配置准备、stream-json 事件翻译、应用工具识别与会话失效判定；无原生 compact 协议故 /compact 明确拒绝
- `src/cli/agy-mcp-config.ts`：agy 工作区及 DimAgent 项目 MCP 配置的插件 Server 合并与原子写入
- `src/cli/agy-adapter.test.ts`：agy 参数构造、MCP 工具事件、事件翻译、compact 拒绝与失效会话识别测试
- `src/cli/agy-mcp-config.test.ts`、`src/cli/dim-mcp-config.test.ts`：headless MCP 配置原子合并、幂等更新和格式边界测试
- `src/cli/native-sessions.ts`：原生会话入口——按 adapter 声明的 listNativeSessions 分发，未声明即不支持；具体协议实现归属各引擎适配器
- `src/cli/native-sessions.test.ts`：原生会话目录过滤、标题回退和排序测试
- `src/cli/native-compact.ts`：驱动 Claude/Codex 原生上下文整理协议
- `src/cli/native-compact.test.ts`：compact 完成、短会话和取消测试
- `src/cli/claude-adapter.ts`：Claude Code 多事件、工具、上下文、统计与项目 JSONL 原生会话适配器
- `src/cli/codex-adapter.ts`：Codex 四类工具、上下文、答案、统计与 app-server 原生会话适配器
- `src/cli/runner.test.ts`：子进程生命周期、事件分发、续聊和错误边界测试
- `src/cli/cli-adapters.test.ts`：双 CLI 参数、多事件和协议解析测试
- `src/cli-events.ts`：Codex/Claude/DimAgent 事件解析
- `src/probe-cli.ts`：JSONL 标准输入时间线探针
- `src/probe-app-tool.ts`：应用工具探针——不经飞书驱动 Claude/Codex/agy 调用澄清工具并校验结果
- `src/cli-events.test.ts`：事件解析器测试
- `src/mcp/clarification-server.ts`：本地 stdio MCP Server——向 Claude Code、Codex、DimAgent headless 与 agy 提供 `request_clarification` 工具
- `src/mcp/clarification-tools.ts`：stdio 与 HTTP MCP 复用的 `request_clarification` 注册定义
- `src/mcp/clarification-http-server.ts`：仅监听 loopback 的无状态 HTTP MCP Server，兼容不接受 ACP stdio MCP 的 DimAgent 版本
- `src/mcp/loopback-http-server.ts`：应用工具插件共用的无状态 loopback Streamable HTTP MCP 传输
- `src/mcp/product-spec-server.ts`：产品文档 stdio MCP Server——向 headless CLI 提供 `request_spec_approval`
- `src/mcp/product-spec-tools.ts`：stdio 与 HTTP MCP 复用的 `request_spec_approval` 注册定义
- `src/im/lark.ts`：飞书收发、卡片动作回调、卡片更新、消息资源下载与结果提醒（sendResultNotification）
- `src/im/lark.test.ts`：正文、卡片回调、响应头和扩展名测试
- `src/im/message-parser.ts`：提及还原与富媒体资源提取
- `src/im/message-parser.test.ts`：提及和资源解析测试
- `src/im/card.ts`：任务生命周期卡片、历史会话恢复卡片、长答案处理与一秒节流更新器
- `src/im/card.test.ts`：任务/会话卡片、长答案和节流并发测试
- `README.md`：飞书配置、会话、卡片、提及和下载验证步骤

## 工程约定

- **一切皆为插件是最高准则**（见文首章节）：新增能力做成插件并在 cordis.yml 声明，协作走 ctx 服务与事件，禁止能力归属硬编码。
- 仅使用 ESM、Node.js 22+ 和 pnpm。
- 源码放在 `src/`，运行数据放在 `data/`。
- 凭证只放在 `.env`；禁止硬编码或提交凭证。
- 修改应保持最小范围，并在完成后运行 `pnpm build` 和相关验证命令。
- 本机是 Windows 环境；命令示例优先使用 PowerShell 7。
- 读写文本文件统一使用 UTF-8 编码。

## 注释规范

- 每个源文件顶部都要用中文说明模块职责，以及它在 Agent OS 流程中的位置。
- 对状态机、并发/节流、取消与回滚、外部平台协议、双层 JSON、权限和安全边界等关键代码，必须补充解释“为什么这样做”的注释。
- 对语义不直观的导出类型、函数和类使用简洁的中文 JSDoc，说明输入、输出或重要约束。
- 注释必须与实现同步；修改行为时同时更新相关注释，禁止保留已经失效的说明。
- 不给显而易见的赋值、循环或语法逐行复述代码。测试优先用清晰的测试名称表达意图，只为不直观的测试准备过程补充注释。
- 新增模块时，除补充源码注释外，还要同步更新本文件的“模块地图”。

## 错题本

> 踩坑后按“现象 → 原因 → 正确做法”追加一条，供未来的 Agent 和人参考。

### 1. Cordis 插件 apply 里访问自己提供的服务抛 `cannot get property "x" without inject`

- **现象**：服务插件在 `apply` 内 `ctx.plugin(XService)` 后直接 `ctx.x.value = ...`，运行时报 `cannot get property "x" without inject`，插件挂载失败。
- **原因**：Cordis 的上下文代理要求插件必须先声明 `inject` 才能访问服务属性；提供方自己的 apply 没有也不应该 inject 自己。
- **正确做法**：在 apply 里直接 `new XService(ctx)` 注册服务（构造器 `super(ctx, 'name')` 即完成登记），再用服务实例方法做异步初始化（如 `await service.load(config)`）。服务实例内部可以自由通过 `this.ctx.<其他服务>` 访问别的服务。

### 2. `await ctx.plugin()` 不会等待 inject 依赖级联完成

- **现象**：`await Promise.all([...挂载 fiber])` 返回后，深层依赖（如 router 依赖 tasks/collaboration，tasks 依赖 sessions/cli…）的插件 apply 还没执行，事件监听器尚未注册，发事件时路由丢失。
- **原因**：`ctx.plugin()` 返回的 fiber 的 `then` 只调用 `fiber.await()`；对处于 PENDING（等待 inject 依赖）的 fiber，`await()` 因没有 inertia 会立即返回。
- **正确做法**：loader 挂载全部插件后轮询 `ctx.registry`，等所有 fiber 进入 ACTIVE（或 FAILED 则抛出），并排除 loader 自身 fiber（它执行期间始终 LOADING）。见 `src/plugins/loader.ts` 的 `waitForAllActive`。

### 3. ACP SDK 的 `connectWith` 每次建连、用完即关，无法常驻复用

- **现象**：把 DimAgent 的 acp 接入从“每任务一个进程”改为“单常驻进程”时，沿用 `client().connectWith(stream, op)`，每轮仍会重新发送 initialize 且 op 完成后连接即关闭，进程虽常驻但连接每次都重建。
- **原因**：SDK 的 `connectWith` 是 `connect` + `runUntil(op)` 的封装，`op` 结束后 `runUntil` 自动关闭连接；连接级 handler（requestPermission、session/update）也随连接销毁。
- **正确做法**：用 `app.connect(stream)` 持久持有 `ClientConnection`，在 `connection.agent`（ClientContext）上多次 `request()`。同一连接的并发请求由 JSON-RPC id 匹配，session/update 通知在连接级 handler 里按 `sessionId` 路由到各轮收集器；取消改为发 `session/cancel` 通知做软取消，不能杀共享进程。见 `src/cli/acp-daemon.ts`。
