# @swalvo/cli

Swalvo from the terminal — manage projects, API keys, rooms and live
streams, and wire up a local app for RTC development.

Part of [Swalvo](https://github.com/atulsinghhhh/swalvo-sdks), open-source real-time communication infrastructure.

## Install

```bash
npm install -g @swalvo/cli
```

Or run it without installing:

```bash
npx @swalvo/cli --help
```

## Use

```bash
swalvo login                    # authenticate
swalvo whoami                   # who am I, against which deployment
swalvo projects create my-app   # create a project
swalvo keys create              # mint an API key for it
swalvo init                     # scaffold Swalvo into the app in this directory
swalvo dev                      # run against a local stack
```

Inspect a running deployment:

```bash
swalvo rooms list
swalvo connections list
swalvo rtc servers list         # the SFU fleet
swalvo diagnostics
swalvo errors list
swalvo logs
swalvo status
```

`swalvo <command> --help` documents each group. Also: `chat`, `streams`,
`sdk`, `config`, `version`, `logout`.

## Self-hosting

Point the CLI at your own deployment rather than the default:

```bash
swalvo config set apiUrl https://api.your-swalvo-deployment.example
swalvo config get apiUrl
swalvo config list
```

`swalvo config` stores local CLI preferences only — never secrets.

## Headless use and configuration

| Variable | Purpose |
| --- | --- |
| `SWALVO_TOKEN` | Session token for CI and machines without a browser (beats stored credentials) |
| `SWALVO_API_URL` | Overrides the configured API URL for one process |
| `SWALVO_DASHBOARD_URL` | Dashboard origin used by `swalvo login` |
| `SWALVO_CONFIG_DIR` | Where the CLI keeps its files (default `~/.swalvo`) |

`swalvo init` links a directory to a project through a `swalvo.json` file
(safe to commit).

## Upgrading from the `raven` CLI

The CLI was renamed from `raven` to `swalvo`. The `raven` command still
works for now and prints a deprecation notice; `RAVEN_*` environment
variables are still read (with a one-time warning), an existing
`~/.raven` directory is read when `~/.swalvo` has no file yet, and a
directory's `raven.json` is used when it has no `swalvo.json`. Nothing is
moved or deleted for you.

## Documentation

- [CLI reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/cli.md)
- [Walkthrough](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/examples/cli-workflow.md)

## License

MIT
