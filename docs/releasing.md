# Release guide

[English](releasing.md) · [简体中文](releasing.zh-CN.md)

This project is prepared for GitHub, npm, and the Pi package gallery, but publisher-specific values must be filled in by the maintainer.

## 1. Replace placeholders

Replace every `YOUR_GITHUB_USERNAME` in `package.json` with the exact GitHub owner. The `repository.url` must exactly match the public repository for npm provenance.

Confirm these identity choices before publishing:

- npm package: `pi-background-task`
- GitHub repository: `<owner>/pi-background-task`
- author: `liming`
- license: MIT

The npm name was unclaimed when this repository was prepared. Check again immediately before the first publication:

```bash
npm view pi-background-task
```

An `E404` means no public package currently occupies that name.

## 2. Add gallery media

Pi discovers npm packages tagged with the `pi-package` keyword. This manifest includes that keyword and a compiled entry in `pi.extensions`.

The Pi gallery also reads optional media under `pi`:

```json
{
  "pi": {
    "video": "https://.../demo.mp4",
    "image": "https://.../gallery-preview.png"
  }
}
```

- `video` must be MP4.
- `image` may be PNG, JPEG, GIF, or WebP.
- Video takes precedence when both fields exist.
- Use durable public HTTPS URLs. Raw files in the public GitHub repository are suitable.

Add `docs/assets/demo.mp4` and `docs/assets/gallery-preview.png`, then replace the placeholder owner in both URLs. Add the two README screenshots and uncomment their Markdown rows as well.

Official references: [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) and [Pi package gallery](https://pi.dev/packages).

## 3. Verify locally

```bash
npm ci
npm run release:check
npm run test:integration
npm run check:release-metadata
npm pack --dry-run
```

`check:release-metadata` intentionally fails while publisher/media placeholders remain. Inspect the generated tarball before publishing:

```bash
npm pack
tar -tf pi-background-task-0.1.0.tgz
```

## 4. Publish GitHub

Create an empty public repository without generating starter files, then connect and push this local history:

```bash
git remote add origin git@github.com:<owner>/pi-background-task.git
git push -u origin main
```

The `CI` workflow checks types, unit tests, tmux integration tests, the build, and the package contents.

## 5. First npm publication

Sign in with the npm account that should own the package, confirm the packed files, then publish:

```bash
npm login
npm whoami
npm publish --access public
```

The `prepublishOnly` hook blocks placeholder metadata and reruns the safe release checks. Publishing is an external, irreversible registry action and is deliberately not performed by this repository setup.

## 6. Enable trusted publishing

After the package exists on npm, configure an npm Trusted Publisher for:

- provider: GitHub Actions
- repository: `<owner>/pi-background-task`
- workflow filename: `publish.yml`
- allowed action: direct `npm publish`

The included workflow uses GitHub-hosted Node.js 24, npm 11.5.1+, and OIDC (`id-token: write`). It needs no long-lived npm write token. Publishing a GitHub Release runs the checks and publishes the version already declared in `package.json`; the git tag should therefore match, for example `v0.1.0`.

See npm's [Trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## 7. Verify discovery

After npm propagation:

```bash
npm view pi-background-task version keywords pi
pi install npm:pi-background-task
```

Open [pi.dev/packages](https://pi.dev/packages) and search for `pi-background-task`. Gallery indexing is controlled by Pi and may not be instantaneous; the required discoverability signal is the published `pi-package` keyword. Confirm that the video plays and that the image is a valid fallback.

Finally, move the `0.1.0` changelog entry from “Unreleased” to the release date.
