# @swalvo/live

## Unreleased

### Major Changes

- Renamed from `@ravenkash/client` to `@swalvo/live` as part of the Raven/Livqeno → Swalvo rebrand. The facade class is now `Swalvo` (`new Swalvo({...})` / `createSwalvo()`), with `SwalvoConfig`, `SwalvoClient` and the re-exported `isSwalvoChatError`. `Raven`, `RavenConfig`, `RavenClient`, `createRaven` and `isRavenChatError` remain exported as deprecated aliases of the same values. The `livqeno` key in live-stream stage-event metadata is a wire contract and is unchanged.

## 0.1.5

### Patch Changes

- Updated dependencies [[`63303dd`](https://github.com/atulsinghhhh/swalvo-sdks/commit/63303dd184adac3beae884ca527cc82fc6f03490), [`01ebb72`](https://github.com/atulsinghhhh/swalvo-sdks/commit/01ebb72c21f18ed79149bb357a2245853d81f9b7)]:
  - @swalvo/chat@0.1.1
  - @swalvo/rtc@0.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [[`501d552`](https://github.com/atulsinghhhh/swalvo-sdks/commit/501d5529f61b16d1eb461ecd8a59dc3095adf1b2)]:
  - @swalvo/rtc@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [[`ee0f646`](https://github.com/atulsinghhhh/swalvo-sdks/commit/ee0f646721f247b7647fbf06ccaccf2c974084d9)]:
  - @swalvo/rtc@0.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [[`1fca552`](https://github.com/atulsinghhhh/swalvo-sdks/commit/1fca5522e8a977e5b311b0d3cb2f4ef79f3e1298)]:
  - @swalvo/rtc@0.3.0

## 0.1.1

### Patch Changes

- [#40](https://github.com/atulsinghhhh/swalvo-sdks/pull/40) [`d7f48ea`](https://github.com/atulsinghhhh/swalvo-sdks/commit/d7f48ea4294a36c7fd6d60ebff0f5b32820101e9) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - `@swalvo/rtc` and `@swalvo/live` are installable again.

  Both shipped at 0.1.0 with the workspace protocol still in their published
  manifests — `"@swalvo/effects": "workspace:*"` for `rtc`, plus
  `"@swalvo/chat"` and `"@swalvo/rtc"` for `client`. The packages were
  public and downloadable the whole time; they just could not be installed by
  anyone outside this repo:

  ```
  npm  install @swalvo/rtc → EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"
  pnpm add     @swalvo/rtc → ERR_PNPM_WORKSPACE_PKG_NOT_FOUND @swalvo/effects@workspace:*
  ```

  That made step 2 of the documented quickstart — `npm install @swalvo/rtc`
  — impossible to follow, while `@swalvo/server` installed fine, so the
  break only showed up once a developer got as far as the browser half.

  No source change was needed: `workspace:*` is correct in the repo, and pnpm
  rewrites it to a concrete version when it packs. The 0.1.0 tarballs were
  published by hand with `npm publish`, which rewrites nothing and bypassed
  every gate in `.github/workflows/release.yml`. Three gates now cover that
  path — a `prepublishOnly` guard in each package that refuses an npm-driven
  publish, a packed-tarball inspection that reads the manifest npm would
  actually receive, and a metadata check that fails a package using the
  protocol without the guard wired up.

  0.1.0 stays on the registry as-is; npm unpublish is restricted to 72 hours
  and that window is long closed. Anyone stuck on it can use an npm
  `overrides` entry pinning `@swalvo/effects` to `0.1.0` until 0.1.1 lands.

- Updated dependencies [[`3dd03cc`](https://github.com/atulsinghhhh/swalvo-sdks/commit/3dd03cccaca678e507c9ab67b93bc21357232b52), [`d7f48ea`](https://github.com/atulsinghhhh/swalvo-sdks/commit/d7f48ea4294a36c7fd6d60ebff0f5b32820101e9), [`d7f48ea`](https://github.com/atulsinghhhh/swalvo-sdks/commit/d7f48ea4294a36c7fd6d60ebff0f5b32820101e9), [`0797ed2`](https://github.com/atulsinghhhh/swalvo-sdks/commit/0797ed2d9d07c1fc3defad08ac3cbab8ad00bfa4)]:
  - @swalvo/rtc@0.2.0
