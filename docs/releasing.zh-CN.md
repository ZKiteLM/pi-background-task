# 发布指南

[English](releasing.md) · [简体中文](releasing.zh-CN.md)

项目已经为 GitHub、npm 与 Pi package gallery 配置完毕，但发布者专属信息必须由维护者填写。

## 1. 替换占位符

把 `package.json` 中所有 `YOUR_GITHUB_USERNAME` 替换为准确的 GitHub owner。为了生成 npm provenance，`repository.url` 必须与公开 GitHub 仓库完全一致。

发布前确认：npm 包名 `pi-background-task`、GitHub 仓库 `<owner>/pi-background-task`、author `liming`、license MIT。准备仓库时 npm 包名尚未被占用；首次发布前请再次运行：

```bash
npm view pi-background-task
```

返回 `E404` 表示当前没有同名公开包。

## 2. 添加 Gallery 媒体

Pi 会发现 npm 上带 `pi-package` keyword 的包。本项目已经包含该 keyword 和 `pi.extensions` 编译入口。

`package.json` 还预留了 `pi.video` 与 `pi.image`：视频必须是 MP4，图片可以是 PNG、JPEG、GIF 或 WebP；两者同时存在时优先展示视频。请使用长期有效的公开 HTTPS URL。

添加 `docs/assets/demo.mp4`、`docs/assets/gallery-preview.png` 和 README 中列出的两张截图，然后替换媒体 URL 中的 owner 并取消 README 图片行注释。

官方资料：[Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)、[Pi package gallery](https://pi.dev/packages)。

## 3. 本地验收

```bash
npm ci
npm run release:check
npm run test:integration
npm run check:release-metadata
npm pack --dry-run
```

只要发布者或媒体占位符还存在，`check:release-metadata` 就会故意失败。正式发布前使用 `npm pack` 并检查 tarball 内容。

## 4. 推送 GitHub

创建一个不自动生成初始文件的空公开仓库，然后连接当前本地历史：

```bash
git remote add origin git@github.com:<owner>/pi-background-task.git
git push -u origin main
```

`CI` workflow 会检查类型、单元测试、tmux 集成测试、构建与 npm 包内容。

## 5. 首次发布 npm

使用将要拥有此包的 npm 账号登录，然后发布：

```bash
npm login
npm whoami
npm publish --access public
```

`prepublishOnly` 会阻止带占位符的发布，并重新运行发布检查。发布是外部且不可逆的 registry 操作，因此本次本地准备不会替你执行。

## 6. 配置 Trusted Publishing

首次 npm 发布后，在 npm package 设置中添加 Trusted Publisher：

- provider：GitHub Actions
- repository：`<owner>/pi-background-task`
- workflow filename：`publish.yml`
- allowed action：直接 `npm publish`

仓库内的 workflow 使用 GitHub 托管的 Node.js 24、npm 11.5.1+ 与 OIDC (`id-token: write`)，不需要长期 npm write token。发布 GitHub Release 时会检查并发布 `package.json` 中的版本，因此 tag 应与版本一致，例如 `v0.1.0`。

参考 npm [Trusted publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

## 7. 验证 Pi 索引

```bash
npm view pi-background-task version keywords pi
pi install npm:pi-background-task
```

在 [pi.dev/packages](https://pi.dev/packages) 搜索 `pi-background-task`。Gallery 由 Pi 维护，索引可能不会瞬间完成；它要求的可发现信号是已发布包中的 `pi-package` keyword。确认视频可以播放，图片可以作为回退预览。

最后，把 changelog 中 `0.1.0` 的 “Unreleased” 改成实际发布日期。
