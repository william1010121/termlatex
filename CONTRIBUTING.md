# Contributing

## Development

Use Node.js 22+ and npm. The repository is an npm workspace:

- Root: `view-latex-md`, the interactive CLI.
- `packages/terminal-math`: `view-latex-md-math`, the rendering/layout/graphics API.

```sh
npm ci
npm test
node cli.js native-demo.md
npm run bench:native
```

No browser or TeX installation is required. Precompiled resvg addons supply native rasterization.

## Verification

Run `npm test` for package changes. For input, reload, editor, export or resize changes, also run `python3 native-terminal.test.py`. For transport/crop changes, run `python3 native-zellij.test.py` with Zellij 0.45.1 installed; this creates an isolated session and does not touch existing sessions.

Use meaningful pixel, geometry, protocol or behavior checks. Do not claim GUI smoothness or FPS from the in-memory benchmark. Document benchmark conditions and remaining costs.

## Issues and pull requests

Include a minimal Markdown sample, Node version, terminal/version, multiplexer/version, and the difference between rendered/source modes. Keep native text selectable, formula state isolated, output serialized, and image IDs scoped to the component. Avoid adding remote rendering or browser dependencies to the default path.

## Release

The math API must be published before the CLI that depends on it. Update both versions, update the CLI's math dependency range and lockfile, document changes in `CHANGELOG.md`, then run tests and packed-install smoke checks.

```sh
npm pack --workspace view-latex-md-math --pack-destination dist
npm pack --pack-destination dist
npm publish --workspace view-latex-md-math --access public
npm publish --access public
```

After verifying the registry versions, create a Git tag and GitHub release named `v<version>` with both package tarballs. Publish with an authenticated npm account and its required 2FA/browser approval. Never commit registry tokens or credentials.
