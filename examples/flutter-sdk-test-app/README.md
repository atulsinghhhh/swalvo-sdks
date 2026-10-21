# Livqeno Flutter SDK test app

An integration-test dashboard for the real `swalvo_rtc`, `swalvo_chat`, and
`swalvo_live` Flutter SDKs against a real Livqeno backend. This is a test
harness, not a demo — every button exercises an actual SDK call, and
anything the SDKs don't implement is labeled as a gap instead of faked.

If you want a polished reference call screen, see
[`examples/flutter-rtc-chat`](../flutter-rtc-chat) instead. This app is for
proving the SDKs work, not for showing them off.

## Security model — read this first

**This app never ships a Livqeno API key.** A key embedded in a distributed
app binary is extractable — decompile the APK/IPA and it's right there.
Production apps must mint tokens from their own backend using the secure
token-grant flow (`@swalvo/server`/`swalvo` Python, same pattern as this
example's `server.mjs`), never carry a privileged key on the device.

The Config screen *does* have an API key field, because this is a
developer tool and typing a key in is convenient. What actually happens:

1. You type the key into the Config screen.
2. It's sent once, over HTTP, directly from this device to `server.mjs` —
   the tiny dev-helper backend you run yourself, on your own machine or
   LAN.
3. `server.mjs` holds it in memory (never on disk, never logged, never
   echoed back) and uses it to mint short-lived RTC/chat/live-stream
   tokens on request.
4. The Flutter app clears the key field the moment the relay call
   succeeds. It never persists it to `shared_preferences`, a database, or
   disk.

If you'd rather not type a key into a mobile UI even under those
conditions, set `SWALVO_API_KEY` (and `SWALVO_API_URL`) as environment
variables before starting `server.mjs` instead — the Config screen's
"Livqeno API key configured" status will already read `true` and you can
skip that field entirely.

## Running it

There is no hosted Livqeno Cloud for this repo — `api.livqeno.com` appears in
`@swalvo/server`'s own docs purely as illustrative text ("or your
self-hosted deployment's URL"). What you actually have is `apps/api`
(NestJS), which you run yourself; its SDK default for local development is
`http://localhost:4100` (`apps/api`'s `API_PORT`). You need that running
(with its own dependencies — Postgres, Redis, etc. — see
`apps/api`'s own docs/docker-compose), plus a project and an API key
created through the locally-run dashboard app (`apps/dashboard`, normally
`http://localhost:3001`) before this app can mint any real tokens.

```bash
cd examples/flutter-sdk-test-app

# Terminal 1 — the dev-helper backend
npm install
node server.mjs
# Optionally skip the in-app key entry (point SWALVO_API_URL at your own
# running apps/api — http://localhost:4100 for local dev, omit it entirely
# to use that same default):
#   SWALVO_API_KEY=rvk_xxx.yyy node server.mjs

# Terminal 2
flutter pub get
flutter run --dart-define=SWALVO_BACKEND_URL=http://<your-lan-ip>:8792
```

On the Config screen, leave "Livqeno API base URL" as
`http://localhost:4100` unless `apps/api` is running somewhere else (a
different port, a deployed environment, etc.) — never a `livqeno.com`
domain, which isn't a real, reachable host for this project.

**On a physical device, `localhost` means the device.** Use your machine's
LAN IP for `SWALVO_BACKEND_URL`, and make sure the RTC `endpoint` your
backend returns is reachable from the device too.

Open the app, fill in the Config screen (backend URL, and either paste
your API key or rely on the `SWALVO_API_KEY` env var), tap **Save &
Connect**, then use the drawer to move between Connection / RTC / Chat /
Live Streaming / Diagnostics / Checklist.

Android needs `minSdkVersion 23`; iOS needs deployment target 13.0+ and
the camera/microphone usage strings in `Info.plist` (see
`flutter-rtc-chat`'s platform setup for the exact entries — this app has
the same native requirements). **Video does not work in simulators** —
they have no camera.

### Until the SDKs are published to pub.dev

As of this writing `swalvo_rtc`/`swalvo_chat`/`swalvo_live` aren't yet
published, so `flutter pub get` won't resolve the hosted versions in
`pubspec.yaml` (this is a repo-wide, pre-existing condition — the same is
true of `examples/flutter-rtc-chat`). For local development against this
repo's working tree, add an untracked `pubspec_overrides.yaml` next to
this file:

```yaml
dependency_overrides:
  swalvo_rtc:
    path: ../../sdks/flutter/swalvo_rtc
  swalvo_chat:
    path: ../../sdks/flutter/swalvo_chat
  swalvo_live:
    path: ../../sdks/flutter/swalvo_live
```

(Same shape as `flutter_check/live_host`'s `dependency_overrides`.) Once
the SDKs are published, delete it — the committed `pubspec.yaml` already
points at the right hosted versions.

## What's in the dashboard

- **Connection** — dev-helper backend health, re-checkable, surfaces
  configuration errors. Covers scenarios 1-4 (see below).
- **RTC** — join/leave a room, local preview, remote video, mute/camera
  toggles, camera switch, and the real connection/media/quality signals
  the SDK exposes. Covers scenarios 5-7, 10, 11, 13.
- **Chat** — connect, send/receive, message history, and a "retry last
  send with the same clientMessageId" button that proves the SDK's
  dedupe path instead of just asserting it. Covers scenarios 8-10.
- **Live Streaming** — host (joins the stream's RTC room) and viewer
  (RTC or HLS, depending on what the stream credential carries) flows,
  manual status/viewer-count refresh. Covers scenario 12.
- **Diagnostics** — a filterable, redacted event log with a Clear action.
- **Checklist** — the 14 scenarios below as a manual pass/fail/skip list.

## Test scenarios

1. SDK initialization succeeds with valid configuration
2. Invalid configuration produces a clear error
3. API authentication succeeds with a valid authorized credential
4. Invalid or unauthorized credentials fail safely
5. RTC room join and leave work
6. Local media publishing works on supported devices
7. Two clients can exchange real audio/video
8. Chat messages reach a second client
9. Chat retries do not create duplicate durable messages
10. Disconnect and reconnect work
11. Camera/microphone permissions are handled correctly
12. Live-stream host/viewer flows work where supported
13. Repeated joins and leaves do not leak resources or leave stale participants
14. Backend or network failure produces a recoverable error

See `MANUAL_TESTING.md` for how to run each one on physical devices, and
`TEST_RESULTS.md` for the latest run's results (automated vs. real-backend).

## Known SDK gaps (do not expect these to work)

- **No native RTMP/WHIP publish from Flutter.** "Hosting" a live stream
  means joining its RTC room like a normal call. Ingest/restream live in
  `swalvo_live`'s server-side/CLI surface, not here.
- **No raw WebRTC `getStats()` counters** (bitrate, packet loss, jitter).
  The RTC tab shows `connectionQuality` and `mediaState` — the real
  signals `swalvo_rtc` provides — and says so explicitly rather than
  fabricating a stats panel.
- **No SDK-level viewer count.** The Live tab's "Refresh status" button
  calls the dev-helper backend's `GET /api/live/:id/status`, which wraps
  `@swalvo/server`'s `liveStreams.get()`, because `swalvo_live` itself
  doesn't expose one.

## Commands

```bash
flutter analyze
flutter test                        # unit + widget tests, all mocked — no network
flutter test integration_test       # on a running device/emulator, no network required
```
