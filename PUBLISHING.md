# Publishing @swalvo/* packages to npm

All eight packages under the `@swalvo` scope are published and versioned
independently. `raven` was the original scope choice, but that npm
username/org was already taken, so package names, docs, examples, and
source imports all use `@swalvo` instead — the npm account actually
verified for this project.

| Package | Path | What it is |
|---|---|---|
| `@swalvo/rtc` | `packages/sdk` | Browser RTC SDK |
| `@swalvo/chat` | `packages/chat-sdk` | Browser chat SDK |
| `@swalvo/live` | `packages/client` | RTC + chat behind one object |
| `@swalvo/react` | `packages/react-sdk` | React hooks/UI for `@swalvo/rtc` |
| `@swalvo/react-native` | `packages/react-native-sdk` | React Native SDK |
| `@swalvo/server` | `packages/server-sdk` | Server-side token/room/diagnostics SDK |
| `@swalvo/cli` | `packages/cli` | `swalvo` CLI binary |

## How a release actually happens

Releases are automated through [changesets](https://github.com/changesets/changesets)
and npm trusted publishing (OIDC — no long-lived `NPM_TOKEN` in CI):

1. A PR that changes a package includes a changeset (`pnpm changeset`)
   describing what changed and at what bump (patch/minor/major).
2. Merging to `main` triggers the **Release** workflow. If unreleased
   changesets exist, it opens/updates a `changeset-release/main` PR that
   bumps the affected `package.json` versions and consumes the changesets
   into that package's changelog.
3. Merging *that* PR runs `changeset publish`, which publishes every
   package whose version moved to npm via trusted publishing, and tags the
   release (e.g. `@swalvo/rtc@0.4.0`).

Packages version **independently** — a patch to the CLI does not bump
`@swalvo/rtc`. See `docs/RELEASE_READINESS_AUDIT.md` for the history of
getting this pipeline working (rotating `NPM_TOKEN` to an Automation
token, then replacing it with trusted publishing entirely) and
`docs/releases.md` for the day-to-day contributor workflow.

## Verifying what's live

```bash
npm view @swalvo/rtc dist-tags.latest
npx @swalvo/cli --help
```

Flutter (`swalvo_rtc`/`swalvo_chat`/`swalvo_live`) is not yet on pub.dev
under these names; the pre-rename `raven_*` packages are the live ones (see
`docs/releases.md`). A `workflow_dispatch`-gated CI workflow
(`.github/workflows/flutter-release.yml`) can publish a chosen package, and
pushes to `main` that bump a package's `pubspec.yaml` version publish it
automatically. Python (`swalvo`) is not yet on PyPI either (only the old
`livqeno-sdk` 0.1.0 is); see `docs/releases.md` and
`docs/sdk-publication-audit.md`.
