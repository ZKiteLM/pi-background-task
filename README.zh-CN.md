# pi-background-task

[English](README.md) · [简体中文](README.zh-CN.md)

为 [Pi coding agent](https://pi.dev/) 提供可靠、可交互的后台任务。

`pi-background-task` 让 Pi 启动耗时命令后立即继续推理。任务运行在真实的 tmux PTY 中，可以持续交互、完整记录日志，并在结束时主动唤醒 Agent，而不需要浪费模型轮次轮询状态。

> **发布状态：** `0.1.0` 已为首次公开发布做好准备。发布前请按[发布指南](docs/releasing.zh-CN.md)替换仓库与 Gallery 媒体占位符。

## 为什么选择它？

- **真正非阻塞**：构建、测试、服务、训练和数据处理可以脱离当前 Agent 轮次持续运行。
- **真实交互终端**：支持向 Shell、REPL、调试器和 TUI 发送文字、Enter、方向键、Escape 与控制键；需要人工接管时可直接 attach。
- **不让 LLM 轮询**：`task_wait` 在一次工具调用内等待；普通任务仅在完成时按需唤醒 Pi。
- **完整且持久的输出**：tmux `pipe-pane` 捕获完整 PTY 流；按字节 offset 分页，避免大日志灌入模型上下文。
- **理解 Pi session tree**：当前分支决定任务可见性；resume 能回到原分支记录，兄弟分支互不干扰。
- **明确的生命周期**：reload、resume、fork 与 new 不会杀死任务；只有真正退出 Pi 才取消当前 runtime 拥有的任务。
- **运行时轻量**：除 Pi peer packages 与系统 `tmux` 外，不引入第三方运行时依赖。
- **紧凑实时 TUI**：`/bg-tasks` 自动更新状态与运行时间，按需展开带语法高亮的命令与输出。

## Gallery 与截图

<!--
发布前补充：
1. docs/assets/screenshots/task-list.png       — 折叠状态的实时任务列表
2. docs/assets/screenshots/task-details.png    — 展开的命令与输出详情
3. docs/assets/gallery-preview.png             — Pi Gallery 图片回退
4. docs/assets/demo.mp4                         — Pi Gallery 演示视频（必须是 MP4）
然后取消图片行的注释，并同步 package.json 中的 pi.video / pi.image URL。
-->

| 实时任务面板 | 交互式任务详情 |
| --- | --- |
| _截图占位：`docs/assets/screenshots/task-list.png`_ | _截图占位：`docs/assets/screenshots/task-details.png`_ |
| <!-- ![实时任务面板](docs/assets/screenshots/task-list.png) --> | <!-- ![交互式任务详情](docs/assets/screenshots/task-details.png) --> |

npm 清单已预留 Pi package gallery 使用的 `pi.video` 与 `pi.image` 字段。两者同时存在时，Pi 优先展示 MP4 视频。

## 环境要求

- Pi `0.85.1` 或更高版本
- Node.js `20` 或更高版本
- macOS 或 Linux；Windows 请在 WSL 中运行 Pi
- `PATH` 中可以调用 `tmux`

## 安装

首次发布到 npm 后：

```bash
pi install npm:pi-background-task
```

本地开发或试用尚未发布的 checkout：

```bash
npm install
npm run build
pi -e .
```

## 第一个任务

直接对 Pi 说：

```text
把 `npm test` 作为后台任务启动，告诉我 task ID，然后继续其他工作，
等其他工作完成后再等待它。
```

也可以启动交互程序：

```text
在后台启动 Python REPL，发送 `print(sum(range(100)))`，然后显示新增输出。
```

扩展向 Pi 提供六个工具：

| 工具 | 用途 |
| --- | --- |
| `task_start` | 启动命令并立即返回 task ID |
| `task_status` | 查询状态、运行时间与退出码 |
| `task_logs` | 按字节 offset 读取有限日志，或截取当前屏幕 |
| `task_send` | 发送 literal text、Enter 或白名单控制键 |
| `task_wait` | 等待任一或全部任务，不轮询模型 |
| `task_kill` | 请求优雅取消或强制终止 |

`task_start` 参数示例：

```json
{
  "command": "python -u train.py",
  "name": "Training",
  "cwd": "./experiment",
  "timeoutSeconds": 3600,
  "notifyOnCompletion": true
}
```

下一次日志读取使用返回的 `nextOffset`。单次读取硬上限为 64 KiB，因此单个高噪声进程不会淹没模型上下文。

## 用户命令

- `/bg-tasks` 打开当前根节点到叶节点的 Pi session branch 所引用的任务；`/bg-tasks all` 包含项目历史。
- `/bg-attach <taskId>` 显示精确的 tmux attach 命令，不会自动替换 Pi 当前终端。
- `/bg-clear` 确认后删除当前 branch 可见的已结束记录，包括 resume 后恢复的历史。

面板中使用 `↑/↓` 选择、`Enter` 展开、`r` 强制刷新、`q` 或 `Esc` 关闭。正常更新由事件驱动；运行时间和展开的日志末尾每秒更新一次，不会调用模型。

## 实现原理

```text
Pi Extension（tools、commands、renderers）
                  │
                  ▼
TaskRegistry（状态、分支范围、等待、通知）
            │                         │
            ▼                         ▼
TaskStore（原子文件）          TmuxBackend（PTY 控制）
                                          │
                                          ▼
                                      独立 Runner
```

任务启动包含一个很小但重要的握手：Registry 创建私有元数据与空日志；tmux 启动 Runner；Runner 停在单向启动门前，Backend 先配置 `pipe-pane`；随后 Registry 打开门，Runner 从元数据读取命令并通过用户 Shell 执行。结束时 Runner 原子写入 `result.json`，文件 watcher 与低频一致性扫描让 Pi 收敛到最终状态。

这个启动门只为防止极快命令的开头输出在日志管道就绪前丢失，并不存在第二套 readiness 协议。用户命令不会被拼接到 tmux 控制命令中。

工具结果也刻意分为两层：精简的 `content.text` 只向模型提供下一步决策需要的内容；结构化 `details` 则保存渲染和 session branch 重建信息，不重复注入上下文。

完整状态机、持久化格式、session tree 可见性、退出行为和故障边界见[架构设计](docs/architecture.zh-CN.md)。仓库同时包含可编辑的 [draw.io 源文件](docs/assets/architecture.drawio)。

## 数据与安全

```text
.pi/background-tasks/instances/<runtimeId>/<taskId>/
├── meta.json
├── output.log
└── result.json
```

runtime ID、tmux socket 与内部 session name 用于所有权和隔离；日常使用只需要任务名与 `bg_...` task ID。请勿把 `.pi/background-tasks/` 提交到版本控制。

命令以 Pi 的操作系统权限运行。本扩展是执行协调器，不是沙箱。避免把密钥放在命令参数或日志中。

## 开发与发布

```bash
npm ci
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```

集成测试需要 tmux。仓库已包含 CI 与 npm Trusted Publishing 工作流。请按[发布指南](docs/releasing.zh-CN.md)替换占位符、创建 GitHub 仓库、首次发布 npm、连接 trusted publisher，并确认 Pi Gallery 已索引。

## License

[MIT](LICENSE)
