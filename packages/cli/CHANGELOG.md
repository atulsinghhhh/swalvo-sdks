# @swalvo/cli

## Unreleased

### Major Changes

- Renamed from `@ravenkash/cli` to `@swalvo/cli` as part of the Raven/Livqeno → Swalvo rebrand. The command is now `swalvo`; the `raven` binary remains as a deprecated alias that prints a one-line notice to stderr.
- Environment variables are now `SWALVO_TOKEN`, `SWALVO_API_URL`, `SWALVO_DASHBOARD_URL` and `SWALVO_CONFIG_DIR`. The `RAVEN_*` names (and `LIVQENO_API_URL`) are still read, with a single deprecation warning per run.
- Files now live in `~/.swalvo`. When `~/.swalvo` has no config or credentials file, the CLI reads the one in `~/.raven` instead; new writes go to `~/.swalvo` and nothing is moved or deleted (except that `swalvo logout` also removes `~/.raven/credentials.json`, so signing out sticks).
- `swalvo init` writes `swalvo.json`; a directory with only a `raven.json` keeps working.

