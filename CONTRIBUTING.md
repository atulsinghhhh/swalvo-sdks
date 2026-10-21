# Contributing

Thanks for helping improve the Swalvo SDKs.

This repository holds the public SDKs and examples. The Swalvo platform is
proprietary and lives elsewhere, so changes to server behavior cannot be made
here. If an SDK problem looks like a platform issue, say so in the report.

## Getting set up

```bash
git clone https://github.com/atulsinghhhh/swalvo-sdks.git
cd swalvo-sdks
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

Python, Go, Flutter, Java, PHP, iOS and Android SDKs each have their own
toolchain; see the README in `sdks/<language>/`.

## Pull requests

1. Open an issue first for anything larger than a small fix.
2. Keep a PR to one change, with tests.
3. For a change to a published npm package, add a changeset: `pnpm changeset`.
   Choose patch, minor or major and describe the change for the changelog.
4. Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before pushing.

## Style

Prettier and ESLint settings are in the repo root; run `pnpm format` and
`pnpm lint:fix`.

## License

By contributing you agree your work is licensed under the MIT license in
[LICENSE](./LICENSE).
