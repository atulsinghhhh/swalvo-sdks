# Releasing the SDKs

Three registries are in scope: **npm** (`@swalvo/*`), **PyPI** (`swalvo`) and
**pub.dev** (`swalvo_rtc`, `swalvo_chat`, `swalvo_live`). Every workflow is
started by hand from the **Actions** tab, so nothing publishes by accident.

## Where things stand

| Registry | Package(s) | State |
|---|---|---|
| npm | `@swalvo/rtc`, `chat`, `live`, `react`, `react-native`, `server`, `cli` | Published; the repo versions match the registry. Next release is queued by the changeset in `.changeset/`. |
| PyPI | `swalvo` 0.2.0 | **Not published yet.** Only the older `livqeno-sdk` 0.1.0 exists. |
| pub.dev | `swalvo_rtc` 0.3.0, `swalvo_chat` 0.2.0, `swalvo_live` 0.2.1 | **Not published yet.** The older `raven_*` packages exist. |

Package names are permanent on every registry, so check them before the first publish.

## npm

One-time, per package, on npmjs.com: *Package, Settings, Trusted Publisher, GitHub Actions*
with owner `atulsinghhhh`, repository `swalvo-sdks`, workflow `release.yml`, no environment.

Release:

1. Merge a PR that includes a changeset (`pnpm changeset`).
2. Actions, **Release**, Run workflow. It opens a "Version Packages" PR.
3. Review and merge that PR, then run **Release** again. It publishes through OIDC (no token) and tags the release.

## Python (PyPI)

One-time, on pypi.org: *Your account, Publishing, Add a new pending publisher*
- PyPI project name: `swalvo`
- Owner: `atulsinghhhh`, repository: `swalvo-sdks`
- Workflow: `python-release.yml`, environment: `pypi`

Then create a GitHub environment named `pypi` in this repository's settings.

Release: Actions, **Release Python SDK**, Run workflow, type `PUBLISH`.

## Flutter (pub.dev)

Automated publishing only works once a package exists, so the **first** release of each package is manual.
Publish in this order, because `swalvo_live` depends on the other two being on pub.dev:

```bash
cd sdks/flutter/swalvo_rtc  && flutter pub publish
cd sdks/flutter/swalvo_chat && flutter pub publish
cd sdks/flutter/swalvo_live && flutter pub publish
```

Then, for each package on pub.dev: *Admin, Automated publishing, GitHub Actions*, repository
`atulsinghhhh/swalvo-sdks`, workflow `flutter-publish-package.yml`.

Later releases: bump the version in `pubspec.yaml`, then Actions, **Release Flutter SDK**,
pick the package, type `PUBLISH`.

## Before any release

- CI is green on `main` (`pnpm build`, `pnpm typecheck`, `pnpm test`, Python lint, mypy and pytest).
- `flutter analyze` and `flutter test` pass in each Flutter package.
- Versions and changelogs are bumped, and the registry name is the one you intend.
