# agent-os PTY 接入技术路线（插件化设计）

> 设计日期：2026-08-14
> 状态：设计评审稿（未实施）
> 核心思想：**一切皆为插件**——PTY 能力由 Cordis 插件组装，启停/下线只改 cordis.yml，不改代码。
> 参考：botmux（deepcoldy/botmux）PTY + transcript 桥接经验调研

## 1. 背景与目标

agent-os 目前通过两种模式驱动 AI 编程 CLI：

- **headless**（默认）：每轮 `spawn` 子进程，`-p`/`exec` 无头参数，stdout 逐行解析（`src/cli/runner.ts`）
- **acp**：通过 `engines/acp` 插件以配置驱动方式接入 ACP server（`src/plugins/engines/acp.ts`）

两者都覆盖不到**交互式 TUI 型 CLI**（无稳定 headless 输出协议的 opencode/gemini 等），也拿不到"完整 CLI 进程 + 终端交互"。本设计引入第三种接入模式 **`pty`**，且以插件形式装配，不侵入现有 headless/acp 路径。

目标：

1. `pty` 作为与 `headless`/`acp` 并列的第三种接入模式，纳入现有 `id:accessMode` 注册表（`src/cli/registry.ts` 已天然支持，无需改键逻辑）
2. **PTY 基础设施 = 一个服务插件**，**PTY 接入 = 引擎插件**（配置驱动或专属适配器），**下线 PTY = 移除 cordis.yml 条目**
3. `tasks/cards/sessions` 对外契约零改动
4. 借鉴 botmux：**PTY 负责输入注入与进程控制，输出事实源优先 transcript 文件桥接，屏幕解析只兜底**

## 2. 插件化总体设计

### 2.1 插件划分与装配

```
cordis.yml
├── - name: pty                    ← 基础设施服务（node-pty 后端、进程管理、transcript 桥接注册表）
├── - name: engines/pty            ← 通用 TUI 接入（配置驱动，类比 engines/acp）
│     config:
│       engines:
│         - id: opencode
│           command: opencode
│           displayName: OpenCode
├── - name: engines/claude-pty     ← 专属 pty 适配器（claude 交互 TUI，P0）
└── ...现有插件不动
```

插件职责边界：

| 插件 | 类型 | 职责 | 下线效果 |
|---|---|---|---|
| `pty` | 服务插件 | 提供 `ctx.pty`：PtyBackend 工厂、一轮执行、transcript 读取器注册、进程回收 | PTY 能力整体下线 |
| `engines/pty` | 引擎插件（配置驱动） | 按 engines 列表把通用 TUI CLI 登记为 `id:pty` 适配器 | 通用 TUI 接入下线 |
| `engines/claude-pty` | 引擎插件（专属） | 登记 claude 的精确 pty 适配器（ready/completion pattern、提交验证、Claude jsonl transcript 桥接） | claude 的 pty 形态下线，headless 不受影响 |
| `commands/attach`（P2） | 命令插件 | Web 终端接管命令 | 接管能力下线 |

### 2.2 插件依赖（inject）关系

```
pty ──────────────▶ (node-pty 运行时依赖，无 Cordis 依赖)
engines/pty ──────▶ cli + pty        （登记适配器 + 使用 ctx.pty）
engines/claude-pty ──▶ cli + pty     （同左）
cli ──────────────▶ pty (可选 inject；run 转发 pty 任务时读取 ctx.pty)
tasks ────────────▶ cli（不变，不感知 pty）
```

### 2.3 注册表视角

`registerCliAdapter` 按 `id:accessMode` 键（`src/cli/registry.ts#engineKey`），`pty` 直接成为第三个键维度：

```
claude:headless   ← engines/claude
claude:pty        ← engines/claude-pty
codex:headless    ← engines/codex
dimagent:headless ← engines/dimagent
dimagent:acp      ← engines/acp
opencode:pty      ← engines/pty（配置驱动）
```

会话持久化的 `accessMode`（`session.accessMode`）存 `"pty"` 即可，`getCliAdapter(id, "pty")` 命中对应适配器——**会话模型与路由无需改动**。

## 3. 新增/改动文件清单

### 3.1 新增（纯函数/适配层，`src/cli/`）

| 文件 | 职责 |
|---|---|
| `src/cli/pty-backend.ts` | node-pty 封装：spawn / write / onData / onExit / resize / kill / getChildPid（Windows ConPTY） |
| `src/cli/pty-runner.ts` | 一轮 PTY 执行：ready 门 → 注入 → 完成判定 → 收尾；产出 `CliRunResult` |
| `src/cli/pty-adapter.ts` | 配置驱动通用适配器（`PtyAdapter`），供 `engines/pty` 使用 |
| `src/cli/pty-transcript.ts` | transcript 文件桥接的通用增量读取骨架 |
| `src/cli/pty-backend.test.ts` | 后端测试（mock node-pty） |
| `src/cli/pty-runner.test.ts` | runner 测试（mock TUI 交互程序） |

### 3.2 新增（插件，`src/plugins/`）

| 文件 | 职责 |
|---|---|
| `src/plugins/pty.ts` | `PtyService` 服务插件（`ctx.pty`） |
| `src/plugins/engines/pty.ts` | 通用 TUI 接入插件（配置驱动，类比 `engines/acp`） |
| `src/plugins/engines/claude-pty.ts` | claude 专属 pty 适配器插件（P0） |

### 3.3 改动（最小）

| 文件 | 改动 |
|---|---|
| `src/cli/types.ts` | `CliAccessMode` 加 `"pty"`；`CliAdapter` 加可选 PTY 元数据；`RunCliOptions` 加 `pty` 注入字段 |
| `src/cli/runner.ts` | `runCli` 增加 `accessMode === "pty"` 分支，调用注入的 `options.pty.run`（保持纯函数，不依赖 ctx） |
| `src/plugins/cli.ts` | `CliService.run`：pty 时注入 `this.ctx.pty`（与 acp 注入 daemon 同模式） |
| `src/plugins/loader.ts` | `pluginRegistry` 登记三个新插件名 |
| `src/plugins/types.ts` | `declare module "cordis"` 挂 `ctx.pty` |
| `cordis.yml` | 装配三个新插件条目 |

## 4. 契约设计

### 4.1 `src/cli/types.ts`

```ts
export type CliAccessMode = "headless" | "acp" | "pty";

/** PTY 后端的写入句柄；false 表示写入未确认。 */
export interface PtyHandle {
  write(data: string): void | boolean;
  /** 字面量注入文本（逐字符安全路径，TUI 下不触发快捷键）。 */
  sendText?(text: string): void | boolean;
  /** 注入特殊按键，如 "Enter"、"C-c"。 */
  sendSpecialKeys?(...keys: string[]): void | boolean;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly pid: number;
}

/** PTY 接入方式下适配器可选的扩展元数据；headless/acp 适配器不受影响。 */
export interface PtyAdapterHints {
  buildPtyArgs?(opts: { cwd: string; sessionId?: string; resumeSessionId?: string }): string[];
  readyPattern?: RegExp;
  completionPattern?: RegExp;
  writeInput?(pty: PtyHandle, content: string, ctx: { cliCwd: string }): Promise<{
    submitted: boolean; cliSessionId?: string; recheck?: () => Promise<boolean>;
  }>;
  transcriptReader?: {
    locate(cwd: string): string | undefined;
    drain(path: string, fromOffset: number): { events: CliEvent[]; newOffset: number };
  };
}

/** runCli 的 pty 注入字段：由 cli 服务注入 ctx.pty，保持 runner 纯函数。 */
export interface RunCliOptions {
  // ... 现有字段
  pty?: { run(options: RunCliOptions): Promise<CliRunResult> };
}
```

### 4.2 `src/plugins/pty.ts`（服务插件）

```ts
export class PtyService extends Service {
  /** 一轮 PTY 执行：spawn → ready → 注入 → 完成判定 → 收尾。 */
  run(options: RunCliOptions): Promise<CliRunResult>;
  /** 引擎适配器登记自己的 transcript 读取器（按 cliId）。 */
  registerTranscriptReader(cliId: CliId, reader: PtyAdapterHints["transcriptReader"]): void;
  /** 关闭全部活动进程；由插件卸载回调调用。 */
  dispose(): Promise<void>;
}
```

### 4.3 `src/plugins/engines/pty.ts`（配置驱动，类比 engines/acp）

```ts
export interface Config {
  engines?: Array<{
    id: CliId; command: string; displayName: string;
    args?: string[];            // 固定交互参数（如 ["--no-plan"]）
  }>;
}
// apply: for (const e of config.engines ?? []) ctx.cli.register(new PtyAdapter(e));
```

无默认引擎（与 acp 不同，acp 因历史配置默认 DimAgent）：pty 是显式新增能力，不配置即不注册。

### 4.4 `src/plugins/engines/claude-pty.ts`（专属适配器，P0）

claude 交互模式专属适配器：无 `-p` 参数、`readyPattern`（如 `>` 提示符）、Claude jsonl transcript 桥接（复用 `native-sessions.ts#claudeProjectDirectory` 的路径逻辑），提供 `session`/`result`/`tool_*` 事件。

## 5. 生命周期设计

### 5.1 一轮任务（P0：每任务一个进程，与 headless 语义一致）

```
PtyService.run
  → pty-backend.spawn(TUI, cwd, cols=120, rows=40)
  → 等待 readyPattern（30s 超时；冷启动 TUI 可能吞首个 prompt）
  → adapter.writeInput(pty, prompt)（sendText + Enter；提交验证优先 transcript 追加确认）
  → 等待完成：
       优先：transcriptReader.drain 产出 turn 完成
       兜底：completionPattern / busy 消失后静默 N 秒
  → 提取 cliSessionId（transcript 或提交时重捕）
  → 返回 CliRunResult{ answer, sessionId, stats }
```

### 5.2 取消与超时

- **软取消**：先注入 `Ctrl+C`（`\x03`），给 CLI 保存会话/优雅退出机会
- **硬超时**：软取消后宽限 5s 未退出，走 `src/cli/process-tree.ts#stopProcessTree`
- 对齐现有 `AbortSignal` 语义（`tasks` 的 `run.signal` 直接可用）

### 5.3 会话续聊（P0：退出后 resume）

- 每轮结束进程退出，下轮 `--resume <cliSessionId>` 冷启动（`buildPtyArgs`/`buildResumeArgs`）
- `cliSessionId` 从 transcript 提取，提交时重捕（botmux 思路）
- 常驻复用（跨轮共享 TUI 进程）作为 P2，参考 `AcpDaemon` 由 `PtyService` 管理进程池

## 6. 事件翻译与卡片流

- transcriptReader 产出 `CliEvent`（session/result/tool_*），`tasks` 现有进度渲染零改动
- 屏幕兜底只给 `result`/`session`，不给 tool 事件；`tasks` 对 tool 缺失已有容忍（仅显示耗时与状态）
- 长答案复用 `cards.splitLongText` / `needsContinuation`

## 7. Windows 注意事项

- node-pty 在 Windows 走 ConPTY；启动时保证 spawn-helper 可执行位（botmux 踩坑点）
- `onData` 按 chunk 到达，需按 UTF-8 边界拼接再按行处理
- 无 tmux，"接管 / Web 终端"不做（P2 再议）
- spawn 复用 `resolveCliCommand`（已处理 npm 包装器与 exe 定位）

## 8. 测试与验证

1. **单测**：`pty-backend.test.ts`（mock node-pty）、`pty-runner.test.ts`（mock TUI：ready 超时 / 注入成功失败 / 完成判定 / Ctrl+C 取消 / 硬超时）
2. **插件装配测试**：`loader.test.ts` 补 `pty` / `engines/pty` / `engines/claude-pty` 条目——disabled 跳过、错误边界
3. **集成冒烟**：真实 claude 交互模式跑一轮，验证卡片流式更新与结果
4. **回归**：`pnpm build` + `pnpm test`（现有用例全绿，证明 headless/acp 不受影响）

## 9. 分期落地

- **P0（最小可用）**：node-pty 依赖 + `pty-backend` + `pty-runner` + `pty` 服务插件 + `engines/claude-pty` → 一轮任务跑通、卡片流式更新、取消/超时正确；loader 装配测试
- **P1**：`engines/pty` 配置驱动通用接入、transcript 桥接增强（Codex rollout、tool 事件）
- **P2**：`PtyService` 常驻进程池（跨轮共享 TUI 会话）、`commands/attach` Web 终端接管

## 10. 风险与权衡

| 风险 | 说明 | 缓解 |
|---|---|---|
| TUI 驱动时序脆弱 | ready/completion pattern 随 CLI 版本变化 | 事实源优先 transcript；pattern 只兜底；pattern 收敛在适配器便于跟进 |
| node-pty 原生二进制 | Windows 需匹配预编译包 | 锁 Node 22 + 版本；启动修复 spawn-helper 可执行位 |
| 每轮冷启动慢 | TUI 启动比 headless 慢 | P0 接受；P2 常驻进程池 |
| 事件质量低于 headless | 屏幕路径无 tool 事件/统计 | transcript 桥接补足；卡片不展示缺失信息 |
| 插件数量膨胀 | 每引擎一个 pty 插件 | 通用接入用配置驱动 `engines/pty` 兜底；专属插件只在 pattern/验证复杂时才建 |
