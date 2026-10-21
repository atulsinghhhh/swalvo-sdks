# Swalvo Flutter example — video call with chat

A real Swalvo call in Flutter: WebRTC media through Swalvo's SFU, messages
through Swalvo Chat into Postgres. No mocks anywhere.

## Running it

You need a Swalvo Cloud project and API key: sign up at the
[dashboard](https://app.swalvo.com), create a project, then create
an API key from the project's API Keys tab.

```bash
cd examples/flutter-rtc-chat

# Terminal 1 — backend that holds SWALVO_API_KEY and mints both tokens
npm install
SWALVO_API_KEY=rvk_xxx.yyy SWALVO_API_URL=https://api.swalvo.com npm run server

# Terminal 2
flutter pub get
flutter run --dart-define=RAVEN_BACKEND_URL=http://<your-lan-ip>:8791
```

`RAVEN_BACKEND_URL` above points the Flutter app at *this example's own*
token-minting backend (on your LAN), not at Swalvo Cloud directly — the
backend is the only thing that talks to `SWALVO_API_URL`.

**On a real device, `localhost` means the phone.** Pass your machine's
LAN IP via `--dart-define`, and make sure the returned `endpoint` is
reachable from the device too.

Android needs `minSdkVersion 23`; iOS needs deployment target 13.0+ and
the camera/microphone usage strings in `Info.plist`. Video does not work
in simulators — they have no camera.

## What it demonstrates

Remote video, a local preview, camera/mic toggles, front-rear camera
switch, a chat panel with history and typing indicators, and leaving
cleanly.

## Worth noticing in the code

`ListenableBuilder(listenable: room, …)` — `SwalvoRoom` is a
`ChangeNotifier`, so the widget tree rebuilds from it directly. That's
the idiomatic-Dart divergence from the TypeScript SDK: identical
concepts, platform-appropriate subscription. Typed streams
(`room.participantChanges`, `chat.messages`) are there for logic outside
the widget tree.

See [docs/sdk/flutter.md](../../docs/sdk/flutter.md).
