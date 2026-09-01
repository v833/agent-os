# 定时任务

Agent OS 支持用自然语言创建定时任务：说一次“每天早上 9 点检查服务日志”，到点系统会自动唤醒目标成员的会话执行，把结果带回，全程不需要你守在电脑前。

---

## 创建定时任务

```text
@机器人 /schedule <需求>
```

例如，每 5 分钟检查一次服务健康：

```text
@机器人 /schedule 每 5 分钟检查现在最新的用户列表
```

CEO 助理会理解需求，并通过 `schedule_manage` 工具（action=add）把它转成结构化计划：选择 `targetBotId`（负责执行的成员）、保留完整 `prompt`、按需求生成 `rule`。创建完成后回执里直接给出任务 id、规则与下次执行时间。

## 查看定时任务

```text
@机器人 /schedules
```

返回当前聊天中由自己创建的定时任务，包含任务 id、执行成员、规则、状态与下次触发时间。命令和 `schedule_manage` 都按 `chatId + creatorOpenId` 隔离，不能查看或管理其他人、其他聊天的计划。

也可以直接查内部 API：

```bash
curl http://127.0.0.1:3101/api/schedules
```

## 管理定时任务

```text
@机器人 /schedule pause <id>     # 暂停
@机器人 /schedule resume <id>    # 恢复
@机器人 /schedule delete <id>    # 删除
@机器人 /schedule run <id>       # 立即执行一次
```

## 三种调度规则

| 规则 | 写法 | 含义 |
| :--- | :--- | :--- |
| 一次性 | `runAt` | 指定时刻执行一次 |
| 固定间隔 | `everyMs` | 每隔固定毫秒数执行（最低 1 分钟） |
| Cron | `expression` + `timezone` | 标准 5 段 cron，时区缺省 `Asia/Shanghai` |

规则由 `ScheduleRuleSchema` 统一校验，命令、`schedule_manage` 工具与 API 都走同一份约束，非法输入在入口就被挡下。

## 统一管理工具 schedule_manage

`schedule_manage` 把创建、查看、编辑、删除、批量操作全部收进一个工具，通过 `action` 区分：

- `list`：列出当前聊天中由当前创建人建立的计划。
- `add`：创建一个。
- `addMany`：批量创建。
- `update`：编辑一个（改 `targetBotId`、`prompt`、`rule`）。
- `remove`：删除一个。
- `removeMany`：按 `ids` 批量删除。
- `removeAll`：删除当前范围内的全部计划，必须 `confirm=true`。
- `run`：立即执行。
- `pause` / `resume`：暂停 / 恢复。
- `logs`：查看运行记录。

MCP 子进程通过内部 HTTP API（`POST /api/schedules/manage`）当场执行，模型拿到的回执是真实落盘后的结果（任务 id、规则、下次执行时间），参数不合法会立刻收到 400 校验错误。

## 数据与持久化

- **计划**（`data/schedules.json`）与**运行记录**（`data/schedule-runs.json`）分离存储，重启后自动恢复。
- 同一 `scheduleId + scheduledFor` 只允许一条运行记录，防止重复触发；周期任务按计划时间保持固定节拍，上一轮未跑完时本轮记 `skipped` 跳过。
- 每计划最多保留 100 条运行历史，超出自动裁剪。
- 直接编辑 `data/schedules.json` 也会热更新：watcher 监听文件变化，自动对内存做新增、更新、删除差异合并，无需重启进程。

## 到点执行

定时任务到点后，系统直接唤醒目标 bot 的 CLI 会话**静默执行**计划里的 `prompt`，不在群里推送派发消息。任务需要推送结果时，由任务内容自己完成（例如 Agent 在任务里调用飞书推送）。每轮默认最多执行 30 分钟；可用引擎专用的 `<ENGINE>_TIMEOUT_MS` 或全局 `CLI_TIMEOUT_MS` 覆盖。

查看某条计划的运行记录：

```bash
curl http://127.0.0.1:3101/api/schedules/<id>/runs
```

## 端口与环境变量

内部管理 API 只监听 loopback 地址 `127.0.0.1`，默认端口 `3101`，可用环境变量覆盖端口并设置可选 token：

```bash
SCHEDULE_API_PORT=3101
SCHEDULE_API_TOKEN=
```

如有本机其他进程接入，建议设置 `SCHEDULE_API_TOKEN`，请求时通过 `x-api-token` 传入。API 是系统级管理入口；飞书命令和 `schedule_manage` 才应用 `chatId + creatorOpenId` 的调用者隔离。

命令、`schedule_manage` 工具、API 与文件热更新只是入口不同，最终都调用同一个 `Scheduler`。

要整体下线定时能力，在 `cordis.yml` 中同时移除 `schedule`、`commands/schedule` 和 `commands/schedules` 三个插件条目。
