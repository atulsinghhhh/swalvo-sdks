# Livqeno React Native example — video call with chat

A real Livqeno call on a phone: WebRTC media through Livqeno's SFU, messages
through Livqeno Chat into Postgres. No mock participants, no fake message
array.

## Running it

You need a Livqeno Cloud project and API key: sign up at the
[dashboard](https://app.livqeno.com), create a project, then create
an API key from the project's API Keys tab.

```bash
cd examples/mobile-rtc-chat
npm install
cd ios && pod install && cd ..     # iOS only

# Terminal 1 — backend that holds SWALVO_API_KEY and mints both tokens
SWALVO_API_KEY=rvk_xxx.yyy SWALVO_API_URL=https://api.livqeno.com npm run server

# Terminal 2
npm run ios      # or: npm run android
```

**On a real device, `localhost` means the phone.** Point `BACKEND_URL` in
`src/App.tsx` at your machine's LAN IP so the device can reach this
example's backend; the backend itself talks to Livqeno Cloud over the
internet (`SWALVO_API_URL=https://api.livqeno.com`), so there is no
LAN-reachability requirement on that hop.

## What it demonstrates

Remote video, a local preview, camera and microphone toggles, a chat
panel with history and typing indicators, and leaving cleanly.

Two devices in the same room see and hear each other, and messages sent
from one appear on the other.

## What the app never does

No `new WebSocket(...)`. No `registerGlobals()`. No audio session
management, reconnect loop, heartbeat, message ordering, or dedupe.
That's all inside the SDK — which is the point.

## Testing it properly

The interesting cases are the mobile ones:

- **Background and return.** Video capture stops and resumes; the call
  survives.
- **Wi-Fi → cellular.** Install `@react-native-community/netinfo` and the
  reconnect is fast rather than waiting out an ICE timeout.
- **Deny the camera.** The app still joins — you can watch and listen.
- **Kill the app mid-call.** The other device sees you leave once
  presence expires.

See [docs/sdk/react-native.md](../../docs/sdk/react-native.md).
