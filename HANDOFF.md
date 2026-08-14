# HANDOFF

## 目标与验收

完成 Obsidian 笔记“协作轮次控制：让审查意见自动回到开发”的全部实现要求，并修复 Codex 流式断开后的自动恢复和当前 app-server 参数兼容：审查结果自动作为来源 bot 的下一项任务，交接单携带 `taskId`、`round`、`maxRounds`，轮次默认 2 且限制 1～4，达到上限后停止自动派活；Codex 的 `stream disconnected before completion: Upstream request failed` 最多自动重试 5 次。

## 当前状态

代码实现和自动化验证已完成。此前轮次协作提交为 `8755a77` 并已推送；当前新增自动重试修改尚未提交。工作树包含本轮修改和未跟踪的本地 `HANDOFF.md`。本地 `config/bots.json` 已补入 `reviewBy: reviewer` 与 `collaborationMaxRounds: 2`，该文件被 Git 忽略，不提交。

## 已完成

- `BotConfig` 增加 `collaborationMaxRounds`，Zod 默认 2、整数范围 1～4，并输出到运行配置。
- `CollaborationMessage` 增加 `round`、`maxRounds`；`collaborationTurnKey()` 使用 `taskId:round:toBotId`，区分同一任务不同交接。
- 初次开发完成时创建第 1 轮审查交接；审查完成且未达上限时，使用最终回答、同一 `taskId` 和递增轮次自动回传来源 bot。
- 达到最大轮次时只向来源 bot 发送“本轮协作已完成”通知，避免开发 bot 与审查 bot 无限循环。
- 协作卡片区分“代码审查已发起”和“审查意见已返回”，显示当前环节及最后一轮提示；真实 `@` 通知文案同步区分方向。
- 更新 `config/bots.example.json`、README、注册表/交接/卡片测试；Codex 仍使用已有的 `danger-full-access` 配置。
- `runCliWithTransientRetry()` 仅对 Codex 匹配明确的流式断开错误，最多重试五次并依次等待 1 秒、1.5 秒、2 秒、2.5 秒、3 秒；已有会话优先调用 resume，Claude、普通错误、会话失效和取消不重试。
- Codex 0.118.0 的 `app-server` 默认使用 stdio，移除旧的 `--stdio` 参数；续聊移除不受支持的 `--sandbox`，改用 `--dangerously-bypass-approvals-and-sandbox` 保持完全访问；同步修正原生会话列表、compact 计划和适配器测试。
- 新增 Runner 测试覆盖断流续聊和普通错误不重试。

## 下一步

1. 提交并推送当前自动重试与 Codex app-server 参数兼容修改。
2. 如需真实验收，启动服务并在飞书新话题执行一项开发任务，观察第 1 轮审查和第 2 轮反馈是否按同一工作目录完成；人为制造流式断开，确认日志出现自动重试。
3. 验证轮次上限为 1 时只派发审查、不再回传；验证重复、非目标和缺少任务编号的通知不会启动 CLI。

## 决定、约束与失败教训

- 复用既有内存 `CollaborationInbox` 和 `reviewBy` 关系，不新增持久化交接存储或团队调度抽象。
- `round` 统计 bot 之间真实交接次数，用户最初发起的任务不计入；默认上限 2 代表开发→审查、审查→开发。
- 工作目录沿用当前来源会话的 `session.workspaceDir`，审查意见直接使用 CLI 最终回答。
- 自动重试只针对明确的瞬时断流，避免认证、权限或任务本身错误被静默重复执行；重试期间 `/close` 通过同一个 `AbortSignal` 立即终止等待。
- Windows PowerShell 7、文本 UTF-8、源码注释使用中文；不得提交 `.env`、`config/bots.json` 或 `HANDOFF.md`。

## 相关文件

- `src/core/bot-registry.ts`、`src/core/bot-registry.test.ts`
- `src/core/collaboration.ts`、`src/core/collaboration.test.ts`
- `src/index.ts`
- `src/im/card.ts`、`src/im/card.test.ts`
- `config/bots.example.json`
- `README.md`
- `src/cli/runner.ts`、`src/cli/runner.test.ts`
- `src/cli/codex-adapter.ts`、`src/cli/native-sessions.ts`、`src/cli/cli-adapters.test.ts`

## 验证

- `pnpm build`：通过。
- `pnpm test`：118/118 通过。
- `codex --version`：`codex-cli 0.118.0`；`codex app-server --help` 确认默认 `stdio://`；真实 `codex app-server` 握手未再报 `--stdio` 参数错误。
- `git diff --check`：通过（仅有 Git 的 LF/CRLF 提示）。
- `config/bots.json`：PowerShell `ConvertFrom-Json` 校验通过。

## 阻塞与未决问题

代码无阻塞。尚未进行真实飞书链路和供应商 CLI 的端到端验收；交接单仍为内存存储，服务重启会丢失尚未领取的任务，这是既有设计。
