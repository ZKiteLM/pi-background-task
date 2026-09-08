# Contributing

[English](CONTRIBUTING.md) · [简体中文](#简体中文)

## English

Requirements: Node.js 20+, npm, tmux, and macOS or Linux (WSL is supported).

```bash
npm ci
npm run typecheck
npm test
npm run test:integration
```

Keep the extension lightweight: Pi imports belong in peer dependencies, and a new runtime dependency should solve a problem that cannot reasonably be handled by the Node.js standard library. Preserve the separation between extension registration, TaskRegistry, persistence, tmux control, Runner, and TUI rendering.

Please include tests for state or lifecycle changes. TUI changes must keep every rendered line within the supplied terminal width and should be checked at narrow widths.

## 简体中文

开发需要 Node.js 20+、npm、tmux，以及 macOS 或 Linux（支持 WSL）。运行上面的四项检查后再提交变更。

请保持扩展轻量：Pi 相关包应放在 peer dependencies；只有 Node.js 标准库无法合理解决问题时才增加运行时依赖。保持 Extension 注册、TaskRegistry、持久化、tmux 控制、Runner 与 TUI 渲染之间的职责边界。

状态或生命周期变更需要配套测试。TUI 的每一行都必须小于等于调用方提供的终端宽度，并应在窄终端下验证。
