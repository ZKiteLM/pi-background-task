# pi-background-task

[English](README.md) · [简体中文](README.zh-CN.md)

Reliable, interactive background jobs for the [Pi coding agent](https://pi.dev/).

`pi-background-task` lets Pi start a long-running command and keep reasoning immediately. The job runs in a real tmux PTY, remains interactive, writes a complete durable log, and can wake the agent when it finishes—without spending model turns on polling.

> **Release status:** `0.1.0` is prepared for its first public release. Before publishing, replace the repository and gallery-media placeholders described in the [release guide](docs/releasing.md).

## Why use it?

- **Non-blocking by design** — builds, tests, servers, training runs, and data jobs continue outside the active agent turn.
- **A real interactive terminal** — send text, Enter, arrows, Escape, or control keys to shells, REPLs, debuggers, and TUIs; attach with tmux when a human should take over.
- **No LLM polling loop** — `task_wait` waits inside one tool call, while completion notifications wake Pi only when useful.
- **Complete, durable output** — tmux `pipe-pane` captures the full PTY stream; byte-offset pagination keeps large logs out of model context.
- **Session-tree-aware history** — the active Pi branch determines which jobs are visible. Resume returns to the same branch history; sibling branches stay out of the way.
- **Careful lifecycle semantics** — reload, resume, fork, and new-session transitions do not kill jobs. A real Pi quit cancels jobs owned by that runtime.
- **Small runtime footprint** — no third-party runtime dependencies beyond Pi's peer packages and the system `tmux` executable.
- **Compact live TUI** — `/bg-tasks` updates status and elapsed time automatically and shows highlighted command/output details on demand.

## Gallery and screenshots

<!--
Before release, add:
1. docs/assets/screenshots/task-list.png       — collapsed live task list
2. docs/assets/screenshots/task-details.png    — expanded command/output view
3. docs/assets/gallery-preview.png             — Pi gallery image fallback
4. docs/assets/demo.mp4                         — Pi gallery demo video (MP4)
Then uncomment the image row and keep package.json pi.video/pi.image URLs in sync.
-->

| Live task dashboard | Interactive task details |
| --- | --- |
| _Screenshot placeholder: `docs/assets/screenshots/task-list.png`_ | _Screenshot placeholder: `docs/assets/screenshots/task-details.png`_ |
| <!-- ![Live task dashboard](docs/assets/screenshots/task-list.png) --> | <!-- ![Interactive task details](docs/assets/screenshots/task-details.png) --> |

The npm manifest reserves `pi.video` and `pi.image`, the media fields used by the Pi package gallery. Pi prefers the MP4 video when both are present.

## Requirements

- Pi `0.85.1` or newer
- Node.js `20` or newer
- macOS or Linux; Windows users can run Pi inside WSL
- `tmux` available on `PATH`

```bash
# macOS
brew install tmux

# Debian / Ubuntu
sudo apt-get install tmux
```

## Install

After the first npm release:

```bash
pi install npm:pi-background-task
```

For local development or an unpublished checkout:

```bash
npm install
npm run build
pi -e .
```

## A first task

Ask Pi naturally:

```text
Start `npm test` as a background task. Tell me its task ID, keep working,
and wait for it only when the other work is finished.
```

Or ask for an interactive process:

```text
Start a Python REPL in the background, send `print(sum(range(100)))`,
then show me the new output.
```

Pi receives six tools:

| Tool | Purpose |
| --- | --- |
| `task_start` | Start a command and return immediately with a task ID |
| `task_status` | Inspect state, elapsed time, and exit code |
| `task_logs` | Read bounded log pages by byte offset or capture the current screen |
| `task_send` | Send literal text, Enter, or an allow-listed control key |
| `task_wait` | Wait for any or all tasks without model polling |
| `task_kill` | Request graceful cancellation or force termination |

Example `task_start` input:

```json
{
  "command": "python -u train.py",
  "name": "Training",
  "cwd": "./experiment",
  "timeoutSeconds": 3600,
  "notifyOnCompletion": true
}
```

Example incremental log read:

```json
{
  "taskId": "bg_...",
  "offset": 0,
  "limitBytes": 16384
}
```

Use the returned `nextOffset` for the next page. A single read is capped at 64 KiB, so one noisy process cannot flood model context.

## User commands

- `/bg-tasks` opens jobs referenced by the current root-to-leaf Pi session branch. `/bg-tasks all` includes project history.
- `/bg-attach <taskId>` prints the exact tmux attach command; it never replaces Pi's terminal automatically.
- `/bg-clear` confirms and deletes completed records visible on the current branch, including resumed history.

In the task panel, use `↑/↓` to select, `Enter` to expand, `r` to force a refresh, and `q` or `Esc` to close. Normal updates are event-driven; elapsed time and an expanded log tail update once per second without invoking the model.

## How it works

The implementation deliberately stays in three main layers:

```text
Pi extension (tools, commands, renderers)
                  │
                  ▼
TaskRegistry (state, branch scope, waits, notifications)
            │                         │
            ▼                         ▼
TaskStore (atomic files)       TmuxBackend (PTY control)
                                          │
                                          ▼
                                 isolated task runner
```

Starting a task follows a small but important handshake:

1. The registry creates private task metadata and an empty log.
2. tmux starts the runner in an isolated session.
3. The runner waits at a one-way start gate while `pipe-pane` is attached.
4. The registry opens the gate, and the runner reads the command from metadata and executes it through the user's shell.
5. The runner atomically writes `result.json`; a file watcher plus a low-frequency reconciliation pass updates Pi.

The gate exists solely to prevent the first bytes of fast commands from escaping before log capture is ready. There is no second readiness protocol. User commands are never interpolated into a tmux control command.

Tool results intentionally have two layers: compact `content.text` gives the model only what it needs for its next decision, while structured `details` preserves rendering and branch-reconstruction data without duplicating it into context.

Read [Architecture](docs/architecture.md) for the state machine, persistence format, session-tree visibility, shutdown behavior, and failure boundaries. An editable [draw.io source](docs/assets/architecture.drawio) is included.

## Data and security

Each project stores private task state under:

```text
.pi/background-tasks/instances/<runtimeId>/<taskId>/
├── meta.json
├── output.log
└── result.json
```

Runtime IDs, tmux sockets, and internal session names enforce ownership and isolation; ordinary use only needs the job name and `bg_...` task ID. Keep `.pi/background-tasks/` out of version control.

Commands run with the same operating-system permissions as Pi. This extension is an execution coordinator, not a sandbox. Avoid placing secrets in command arguments or logs.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```

The integration suite requires tmux. CI runs the supported checks on Linux; TypeScript sources and built ESM output are both included in the npm package.

## Publishing

The repository includes CI and an npm Trusted Publishing workflow. Follow the [release guide](docs/releasing.md) to replace publisher placeholders, create the GitHub repository, perform the first npm publication, connect the trusted publisher, and verify Pi gallery discovery.

## License

[MIT](LICENSE)
