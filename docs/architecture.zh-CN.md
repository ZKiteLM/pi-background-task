# Pi Background Task Extension 架构设计

[English](architecture.md) · [简体中文](architecture.zh-CN.md)

## 1. 目标与边界

本扩展把 tmux 的持久终端能力包装为一套面向 Pi Agent 的后台任务运行时。第一版保证同一 Pi 进程内的启动、观察、交互、等待、通知和终止，并持久化可查询的历史。

明确不做：跨 Pi 实例接管、Pi 异常退出后的自动重连、操作系统重启恢复、远程执行和进程沙箱。

![架构总览](assets/architecture.png)

可编辑源文件：[architecture.drawio](assets/architecture.drawio)。

## 2. 组件职责

| 组件 | 职责 |
| --- | --- |
| Extension | 注册 Pi 生命周期、Agent tools、用户 commands 和 TUI renderer |
| TaskRegistry | 任务状态机、所有权、等待者、超时、完成事件、通知抑制和恢复 |
| TaskStore | 原子 JSON、权限、历史发现和日志路径 |
| TmuxBackend | tmux socket/session、literal input、控制键、screen capture 和 attach 命令 |
| Runner | 在 pane 中读取 meta、执行 shell command、记录退出码和终态 |
| CompletionNotifier | 批量合并完成事件、持久化去重并触发 Pi follow-up |

依赖方向保持单向：Extension 依赖 Registry；Registry 组合 Store 与 Backend；Runner 仅通过任务目录与 Registry 通信，因此 tmux pane 不依赖 Pi 进程内对象。

## 3. 启动握手与数据流

直接启动命令后再配置 `pipe-pane` 会丢失最早输出，因此采用单向启动门：

1. Registry 原子创建任务目录、`meta.json` 和空日志。
2. Backend 在实例专属 socket 中创建 tmux session，pane 只启动 Runner。
3. Runner 等待 `start.signal`，此时尚未执行用户命令。
4. Backend 配置 `pipe-pane` 将完整 PTY 输出追加到 `output.log`。
5. Registry 写入 `start.signal`，Runner 才以 `$SHELL -lc` 启动命令。
6. Registry 把 meta 更新为 `running` 并立即向 Agent 返回。
7. Runner 退出时先写临时 result，再原子 rename 为 `result.json`。

所有 tmux 操作都通过参数数组执行。用户命令不会拼进 tmux 控制命令，而是由 Runner 从只读 meta 中获取；发送文本使用 `send-keys -l`，控制键使用固定枚举映射。

## 4. 状态模型

```text
starting ──启动成功──> running ──exit 0────────> completed
    │                    ├───────exit != 0─────> failed
    │                    ├───────task_kill─────> cancelled
    │                    ├───────deadline──────> timed_out
    └────启动失败────────> failed

running ──session 无 result 消失───────────────> interrupted
外部实例非终态记录 / 重启后无法确认────────────> unknown（只读投影）
```

`result.json` 是终态权威来源，已经存在时不覆盖。取消请求先写 `cancel.json` 再发送信号，因此任务即使捕获 Ctrl+C 并返回 0，仍记为 `cancelled` 或 `timed_out`。

## 5. 持久化格式

```text
.pi/background-tasks/
└── instances/
    └── <instanceId>/
        └── <taskId>/
            ├── meta.json
            ├── output.log
            ├── result.json       # 结束后出现
            ├── start.signal      # 日志管道就绪后的单向启动门
            └── cancel.json       # 取消/超时时出现
```

- 目录权限 `0700`，数据文件权限 `0600`。
- JSON 包含 `schemaVersion: 1`，写入使用同目录临时文件和原子 rename。
- task ID 为 `bg_` 加 32 位十六进制 UUID；路径使用前先校验固定格式，防止路径穿越。
- 日志 offset 是原始文件的字节位置，即使展示时去除 ANSI，也能稳定继续分页。

## 6. 实例隔离

每个 Pi 进程持有一个 process-global `instanceId`。Extension reload 或 session 替换会重建模块实例，但 instance ID 不变。ID 使用 `run_<UTC时间>_p<PID>_<随机后缀>` 的可读形式，tmux socket 直接使用 `pi-bg-<instanceId>`，方便从面板、文件目录和 tmux socket 之间定位；每个任务再使用独立 session。

任务的 `task_start` tool result details 持久化 `taskId`。Registry 扫描 `sessionManager.getBranch()`：只有创建结果位于当前根节点到活跃叶节点路径上的任务才进入默认列表。`/tree` 因此自然隐藏兄弟分支任务；fork/clone 复制分支时继承的是同一任务引用，不会复制后台进程。旧版本记录没有 branch scope 标记时，继续按原 Pi session ID 兼容显示。

可见性、存活和控制权彼此独立：session tree 决定默认可见性；切换分支或会话不会停止进程；process-global owner ID 只决定当前运行时能否 attach、输入或终止任务。owner、socket 和 tmux session 都是内部诊断字段，正常面板不展示。

当前实例可以启动、输入、等待和终止自己的任务。其他实例的记录允许通过显式 task ID、当前 branch 上继承的任务引用或 `/bg-tasks all` 只读查看；非终态显示为 `unknown`，不访问其实时 screen，不允许 attach、输入、等待或终止。删除终态历史不属于进程控制，因此 `/bg-clear` 可以删除当前 branch 可见的旧实例记录，并顺带移除已经为空的 instance 目录。

`session_start` 只创建公共存储根目录，不创建当前 instance 目录；只有第一次真正启动任务时才建立 instance。这样单纯 `/resume`、`/new` 或启动 `pi -r` 不会留下空 instance。

## 7. 等待与完成通知

Registry 使用 `fs.watch` 监听 result 文件，并以每秒一次的一致性扫描兜底。这个扫描完全发生在扩展进程内，不调用 LLM。

`task_wait` 注册内存等待者并等待 completion EventEmitter：

- `all`：全部 task 成为终态后返回。
- `any`：任一 task 成为终态后返回，同时列出 pending IDs。
- 等待超时：仅返回 `timedOut: true`，不终止任务。
- AbortSignal：只取消工具等待，不改变任务。

如果任务正被 `task_wait` 覆盖，完成信息由当前工具结果返回，Notifier 不重复唤醒。其他完成事件在 150ms 窗口内合并，通过 Pi custom message 的 `followUp + triggerTurn` 交付，并在 meta 写入 `notifiedAt` 防止 reload 重复通知。

工具结果严格区分两层：`details` 保存完整结构化状态，供自定义渲染和 session branch 重建；`content.text` 只向 LLM 提供继续决策所需的 task ID、状态、退出码和分页日志，不复制 cwd、owner、socket、内部 session、日志路径等实现字段。

## 8. Pi 生命周期

| `session_shutdown.reason` | 行为 |
| --- | --- |
| `reload/new/resume/fork` | 关闭 watcher/timer/TUI 引用，不终止 tmux；下一次 `session_start` 用同一 instance ID 恢复，并按目标 branch 重建可见任务 |
| `/tree` | 不重启 Registry、不终止任务；重新计算 branch 可见任务和待交付完成通知 |
| `quit` | 对本实例运行任务写取消标记、发送 Ctrl+C、等待 1.5 秒，然后关闭仍存在的 session |

如果 Pi 异常崩溃，tmux 可能继续运行并由 Runner 写出最终 result，但下一次 Pi 使用新的 instance ID，不自动取得控制权。这是第一版有意的安全边界。

## 9. TUI 原则

任务面板采用扁平、高密度布局，复用 Pi theme semantic colors，不写死终端颜色。状态同时使用符号和文字，避免只靠颜色表达。Command 与 Latest output 使用带边框的代码区；命令通过 Pi `highlightCode(..., "bash")` 使用当前主题做语法高亮，Cwd、Log 等结构化值使用 `mdCode`，字段标题使用加粗的 `toolTitle`。owner、socket、tmux session 等后端字段不进入正常界面。所有详情按实际终端宽度进行 ANSI-aware 换行和截断保护，任何渲染行都不得超过给定宽度。

面板订阅 Registry `changed` 事件，任务启动、完成和 branch 变化会立即刷新状态。运行时长使用本地时间每秒重绘；只有展开详情时才每秒读取当前日志末尾最多 4 KiB，不轮询 tmux、不调用 LLM。`r` 保留为异常情况下的手动刷新。面板关闭后移除事件订阅和 timer。RPC/JSON/print 模式不创建终端组件，降级为持久化文本摘要。

## 10. 故障与安全语义

- tmux 不存在或 Windows 原生运行：session 初始化时给出明确错误。
- Runner 在 10 秒内未收到 `start.signal`：退出并由 Registry 的一致性检查收敛状态。
- tmux session 无 result 消失：当前实例写 `interrupted`。
- 日志读取默认 16 KiB、最大 64 KiB；screen capture 最大 500 行。
- Extension 与 Pi 具有同等系统权限，命令是任意代码执行能力；扩展不声称提供沙箱。
- 不执行 `tmux kill-server`，关闭和清理始终定位到当前 instance/task。
