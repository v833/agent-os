# agent-os

把飞书变成 AI 编程 CLI（Claude Code / Codex）的指挥台。
一个话题对应一个任务；Agent 之间可以协作；定时任务可以主动触发工作。

## 运行

- `pnpm dev`：监听源码和 `.env` 变化并自动重启
- `pnpm start`：同 `pnpm dev`
- `pnpm start:once`：不启用 watch，直接启动飞书机器人
- `pnpm build`：执行 TypeScript 编译检查并输出到 `dist/`
- `pnpm test`：运行 CLI、飞书消息、卡片与会话模型测试
- `pnpm probe:cli`：从标准输入读取 Codex/Claude JSONL 并输出时间线

## CLI Headless 调试

Codex 为主路径：

```powershell
codex exec --json "1加1等于几？只回答数字本身" | pnpm probe:cli
codex exec resume <thread_id> --json "再加1呢？只回答数字本身" | pnpm probe:cli
```

如果不在 Git 仓库中运行，在 `codex exec` 后增加 `--skip-git-repo-check`。

Claude Code：

```powershell
claude -p "1加1等于几？只回答数字本身" --output-format stream-json --verbose | pnpm probe:cli
claude -p --resume <session_id> "再加1呢？只回答数字本身" --output-format stream-json --verbose | pnpm probe:cli
```

## 模块地图

- `src/index.ts`：会话路由、命令、任务卡片和取消流程入口
- `src/core/session-manager.ts`：话题到会话的映射与状态机
- `src/core/session-manager.test.ts`：会话路由和状态流转测试
- `src/core/command-parser.ts`：`/status`、`/close`、`/help` 解析
- `src/core/command-parser.test.ts`：会话命令解析测试
- `src/cli-events.ts`：Codex/Claude 事件解析
- `src/probe-cli.ts`：JSONL 标准输入时间线探针
- `src/cli-events.test.ts`：事件解析器测试
- `src/im/lark.ts`：飞书收发、卡片回复/更新和消息资源下载
- `src/im/lark.test.ts`：正文解析、响应头和扩展名测试
- `src/im/message-parser.ts`：提及还原与富媒体资源提取
- `src/im/message-parser.test.ts`：提及和资源解析测试
- `src/im/card.ts`：任务卡片构建与两秒节流更新器
- `src/im/card.test.ts`：卡片渲染、边界和节流行为测试
- `README.md`：飞书配置、会话、卡片、提及和下载验证步骤

## 工程约定

- 仅使用 ESM、Node.js 22+ 和 pnpm。
- 源码放在 `src/`，运行数据放在 `data/`。
- 凭证只放在 `.env`；禁止硬编码或提交凭证。
- 修改应保持最小范围，并在完成后运行 `pnpm build` 和相关验证命令。
- 本机是 Windows 环境；命令示例优先使用 PowerShell 7。
- 读写文本文件统一使用 UTF-8 编码。

## 错题本

> 踩坑后按“现象 → 原因 → 正确做法”追加一条，供未来的 Agent 和人参考。
