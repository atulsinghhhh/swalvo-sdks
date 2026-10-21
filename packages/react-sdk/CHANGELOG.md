# @swalvo/react

## Unreleased

### Major Changes

- Renamed from `@ravenkash/react` to `@swalvo/react` as part of the Raven/Livqeno → Swalvo rebrand. Components and hooks are now `SwalvoRoom`, `SwalvoChat`, `SwalvoLiveStream`, `SwalvoVideo`, `SwalvoAudio`, `useSwalvo`, `useSwalvoClient`, `useSwalvoError` (and `SwalvoRoomProps`, `SwalvoChatProps`, `SwalvoLiveStreamProps`, `SwalvoVideoProps`, `SwalvoAudioProps`, `SwalvoSnapshot`, `SwalvoConnectionState`, `SwalvoChatSnapshot`, `SwalvoLiveStreamContextValue`, `SwalvoLiveStreamStatus`, `UseSwalvoResult`). Every `Raven*` / `useRaven*` name remains exported as a deprecated alias of the same value, from both `@swalvo/react` and `@swalvo/react/chat`.
- **Breaking (styling):** the UI kits now use `swalvo-*` class names, `--swalvo-*` CSS custom properties, `data-swalvo-*` attributes and the `swalvo-spin` keyframes instead of `raven-*`, `--raven-*`, `data-raven-*` and `raven-spin`. Custom CSS that targets the old names must be updated (a find-and-replace of `raven-` → `swalvo-` in your stylesheet). The PreJoin `localStorage` key stays `raven-user-choices`, so saved choices carry over.

## 0.1.1

### Patch Changes

- [`e2ee5c3`](https://github.com/atulsinghhhh/swalvo-sdks/commit/e2ee5c31cd9409b1ad399fb688789f19c65eb34e) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - Fix RavenLiveStream losing a participant under React Strict Mode's dev-only double-invoke

  Reported as: two browsers, one host live-streaming, one viewer joining —
  the viewer's browser never showed the host's video. Reproduced against a
  real external-developer app built on the published `@swalvo/*`
  packages, running its normal `next dev` server.

  Root cause: React Strict Mode (on by default in Next.js dev builds)
  mounts `RavenLiveStream`'s join effect, runs its cleanup, then mounts it
  again, before the first `joinLiveStream()` call resolves. The effect
  called `joinLiveStream()` unconditionally in both invocations, so the
  server briefly saw two live sessions claiming the same identity. Confirmed
  at the raw WebRTC level: two `RTCPeerConnection`s were created per client,
  one stuck at `connecting` forever. The surviving connection's own
  `RTCPeerConnection` completed ICE and genuinely received the host's media
  (`ontrack` fired for both audio and video), but the Room's participant
  state never reflected them — media flowed, but no participant ever
  appeared.

  Each effect invocation's join now chains onto a ref-held promise that only
  resolves once the _previous_ invocation has fully settled (its join
  result attached, or left if it was already cancelled). A ref survives
  Strict Mode's mount → cleanup → mount because it's the same component
  instance both times, so this guarantees at most one live join per
  `<RavenLiveStream>` instance — in the common case (cleanup runs
  synchronously, before any microtask), the abandoned invocation's
  `joinLiveStream()` call is skipped entirely rather than merely torn down
  after the fact.

  This only ever affected local development (Strict Mode's double-invoke is
  dev-only) — production builds were never affected.
