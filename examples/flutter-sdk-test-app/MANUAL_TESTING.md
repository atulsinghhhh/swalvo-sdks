# Manual device testing guide

Run through these on physical Android and iOS devices — a simulator has
no camera, so scenarios 6, 7, and 11 are meaningless there, and video
rendering in general should be verified on hardware. Use the in-app
Checklist tab to record pass/fail/skip as you go.

## Setup

1. Start the dev-helper backend on your development machine:
   ```bash
   cd examples/flutter-sdk-test-app
   npm install
   node server.mjs
   ```
2. Find your machine's LAN IP (not `localhost` — on a phone, `localhost`
   means the phone).
3. Install the app on the device:
   ```bash
   flutter run --dart-define=SWALVO_BACKEND_URL=http://<lan-ip>:8792
   ```
4. On the Config screen, confirm the backend URL matches, paste your
   Swalvo API key (or confirm "Swalvo API key configured: true" if you
   set `SWALVO_API_KEY` on the backend instead), and tap **Save & Connect**.

### Android emulator only — real media needs four more overrides

A physical device on your LAN only needs the backend URL above. An
Android **emulator** additionally needs every client-facing "localhost"
in the stack replaced with `10.0.2.2` (its alias for the host machine),
or RTC signaling and TURN relay will silently fail to connect even
though the dev-helper backend itself is reachable. In the repo root
`.env`:

```
API_PUBLIC_URL=http://10.0.2.2:4100
TURN_HOST=10.0.2.2
TURN_HOSTS=10.0.2.2:3479
TURN_EXTERNAL_IP=10.0.2.2
SFU_PUBLIC_HOST=10.0.2.2
SFU_PUBLIC_IP=10.0.2.2
```

Then `docker compose up -d --no-deps api coturn sfu` to apply. **Revert
all six afterward** (delete the lines, or set them back to `localhost`/
`127.0.0.1`, then recreate the same three services) — these are global
values every client gets, including the dashboard's own browser session,
which can't resolve `10.0.2.2` at all.

Android: grant camera/microphone permissions when prompted (minSdkVersion
23+). iOS: the app needs `NSCameraUsageDescription` /
`NSMicrophoneUsageDescription` in `Info.plist` (copy the entries from
`examples/flutter-rtc-chat`'s iOS project if this app's scaffold doesn't
already have them), deployment target 13.0+.

## Scenarios needing a real device, camera/mic, or two clients

### 6 & 11 — Local media publishing, permission handling
RTC tab → Join. Confirm:
- The permission prompt appears before the room connects.
- Deny it once, confirm the app shows a clear error rather than hanging;
  re-launch and grant it, confirm the local preview then renders.
- The local preview mirrors correctly (front camera) and the remote tile
  does not.

### 7 — Two clients exchange real audio/video
Run this app on two devices (or one device + a desktop build), same
backend, same room name, different identities. Confirm:
- Each device's remote tile shows the other's live video within a few
  seconds of both joining.
- Mute/camera-off on one device is reflected as "camera off" / silence on
  the other.
- Connection quality in the RTC tab tracks real network conditions (try
  toggling Wi-Fi off briefly on one device and watch it degrade, then
  recover).

### 8 & 9 — Chat delivery and idempotent retry
Run two instances (two devices, or one device + `flutter run -d chrome`
if a web target is configured), same room, different identities.
- Send a message from device A; confirm it appears on device B within a
  couple of seconds with a stable server `id`.
- On device A, tap **Retry last send (same clientMessageId)**. Confirm
  device B does **not** receive a second, duplicate message — the
  Diagnostics log on device A should show the same message `id` returned
  both times.

### 10 — Disconnect and reconnect
With an active RTC or chat session, toggle Airplane Mode on for ~10
seconds, then off. Confirm:
- The Diagnostics tab logs a connection-state transition out of
  `connected` and back into it (not a permanent `failed`).
- Chat messages sent while offline are not silently dropped (check
  history after reconnecting, or that a `queued` send goes out on its
  own).

### 12 — Live host/viewer flows
Two devices: one as Host (Live tab, leave Stream id blank, fill Title),
one as Viewer (paste the streamId the host screen shows once joined).
- Confirm the viewer's tile shows the host's video for an RTC-delivery
  stream.
- If testing a BROADCAST/HLS stream, enable "Accept HLS playback" on the
  viewer and confirm `SwalvoLivePlayer` eventually plays once the host has
  started publishing (the manifest may 404 for a few seconds after join —
  the player retries on its own).
- Tap **Refresh status** on either device and confirm the viewer count
  reflects both participants once both have joined.

### 13 — Repeated join/leave, no resource leaks
RTC tab: Join, Leave, Join, Leave, five times in a row on one device while
a second device stays in the room throughout. Confirm the second device's
participant list in Diagnostics never accumulates stale entries for the
first device after each Leave.

### 14 — Backend/network failure
With the app connected, kill the `node server.mjs` process. Try to Join a
new RTC room or send a chat message. Confirm the app surfaces a readable
error (via `BackendException`) rather than spinning indefinitely.

## Recording results

Use the in-app Checklist tab during the run, then transcribe into
`TEST_RESULTS.md` under "Real-backend results" with the date, device
models/OS versions, and backend/Swalvo environment used.
