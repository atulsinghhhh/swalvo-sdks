# Changesets

This directory is how the `@swalvo/*` packages get versioned and
published. Each file in here is one pending, human-written note describing
a change and how much it should move a package's version.

Nothing publishes without one.

## Adding a changeset

After making a change that affects any published package:

```bash
pnpm changeset
```

It asks which packages changed, whether each is a `patch`, `minor` or
`major`, and for a one-line summary. That writes a markdown file here;
**commit it with your PR**.

A change that touches no published package — CI, docs, `apps/api`, the
dashboard, the SFU — needs no changeset. Those four apps are listed in
`ignore` in `config.json`, so they are never versioned by this system.

Write the summary for someone reading a release note, not for someone
reading your diff:

> Bad: "fix bug in adapter"
> Good: "Fix a stalled subscribe when the SFU renegotiates during ICE restart"

## What happens next

```
your PR (with a changeset)
   ↓  merged to main
release workflow opens/updates a "Version Packages" PR
   ↓  you review and merge that PR
versions bumped, CHANGELOGs written, changeset files consumed
   ↓  release workflow runs again
npm publish  →  git tags  →  GitHub Releases
```

You never bump a `version` field by hand, and you never run `npm publish`
by hand. See [docs/releases.md](../docs/releases.md).

## How this repo is configured

- **`access: "public"`** — required. Scoped packages (`@swalvo/...`)
  publish as private by default, which fails outright on a free npm
  account.
- **`fixed: []` and `linked: []`** — the packages version *independently*.
  A patch to `@swalvo/cli` should not drag `@swalvo/rtc` to a new
  version that contains no changes. Consumers install these separately, so
  a shared version number would be a claim the repo cannot back up.
- **`updateInternalDependencies: "patch"`** — `@swalvo/live` depends
  on both `rtc` and `chat` via `workspace:*`. pnpm rewrites those to the exact published
  version at pack time, so when a dependency is released its dependents get
  a patch bump and a matching constraint.
- **`ignore`** — `@swalvo/api`, `@swalvo/dashboard`, `@swalvo/docs` and
  `@swalvo/www` are `private: true` applications. They are deployed, not
  published, and have no version anyone consumes.

Note that `@swalvo/react` and `@swalvo/react-native` take their Swalvo
siblings as `peerDependencies: "*"` on purpose — the application chooses
the version, and there must be exactly one copy of `@swalvo/rtc` in the
tree. Changesets does not rewrite peer ranges, which is the behaviour we
want here.
