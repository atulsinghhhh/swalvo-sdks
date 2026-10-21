# Livqeno SDKs

Public client and server SDKs for **Livqeno**, a managed real-time platform for
video, voice, chat and live streaming. Livqeno operates the control plane,
signaling and media; these packages are how you integrate with it.

- Platform: <https://livqeno.com>
- Docs: <https://docs.livqeno.com>

The platform itself is proprietary and is not in this repository. This repo
contains only the SDKs and examples.

## Packages

| Package | Path | What it is |
|---|---|---|
| `@swalvo/rtc` | `packages/sdk` | Browser RTC SDK |
| `@swalvo/chat` | `packages/chat-sdk` | Browser chat SDK |
| `@swalvo/live` | `packages/client` | RTC + chat behind one object |
| `@swalvo/react` | `packages/react-sdk` | React hooks and UI for `@swalvo/rtc` |
| `@swalvo/react-native` | `packages/react-native-sdk` | React Native SDK |
| `@swalvo/server` | `packages/server-sdk` | Server-side token, room and diagnostics SDK |
| `@swalvo/cli` | `packages/cli` | The `swalvo` command line tool |

Other languages live under `sdks/`: Python (`swalvo`), Flutter
(`swalvo_rtc`, `swalvo_chat`, `swalvo_live`), Go, Java, PHP, iOS, Android.
Runnable samples are in `examples/`.

## How it fits together

```
Your backend  --API key-->  Swalvo Control API  --> short-lived token
                                                         |
Your frontend <------------------------------------------+
      |
      +--token--> Swalvo signaling --> Swalvo SFU --> other participants
```

Your API key stays on your server and is never shipped to a browser or app.

## Develop

Requires Node >= 20 and pnpm (version pinned in `package.json`).

```bash
pnpm install
pnpm build        # build every package
pnpm typecheck
pnpm test
```

Per-language instructions are in each SDK's own README.

## Releases

npm packages are versioned independently with [changesets](https://github.com/changesets/changesets)
and published through npm trusted publishing. See [PUBLISHING.md](./PUBLISHING.md).

## License

MIT. See [LICENSE](./LICENSE).
