# Swalvo video-call example

A minimal two-participant video call built entirely on `@swalvo/rtc`'s public
API — `app.js` never touches SDP, ICE candidates, or `RTCPeerConnection`.

```js
import { createRTCClient } from '@swalvo/rtc';

const client = createRTCClient({ token, endpoint, iceServers });
const room = await client.join(roomName);

await room.enableCamera();
await room.enableMicrophone();

room.on('trackSubscribed', (track, participant) => {
  document.body.appendChild(track.attach());
});
```

## Running it

1. Sign up for a Swalvo Cloud project at the
   [dashboard](https://app.swalvo.com) and create an API key.
2. Install `@swalvo/rtc` from npm and copy its bundle into this folder
   (this example loads it via a browser import map, not a bundler — see
   below for why):
   ```bash
   npm install @swalvo/rtc
   cp node_modules/@swalvo/rtc/dist/index.js ./swalvo-rtc.js
   cp node_modules/@swalvo/rtc/dist/index.js.map ./swalvo-rtc.js.map
   ```
   One file is all it takes now: `@swalvo/rtc` has no runtime
   dependency to vendor alongside it. WebRTC comes from the browser.
3. Serve this folder statically, e.g.:
   ```bash
   python3 -m http.server 8900
   ```
4. Mint two RTC tokens for the same room (different `participantIdentity`
   values) against `https://api.swalvo.com` — via `curl` with your
   API key, or `swalvo rooms create` + `swalvo` CLI — see
   docs/sdk.md#authentication for the exact fields you need.
5. Open `http://localhost:8900` in two browser tabs, paste one token's JSON
   response into each, and click **Join Room** in both.

## Why an import map instead of a bundler

Every other example in this repo (`examples/media-demo`,
`examples/signaling-demo`) is plain static HTML/JS with a vendored
dependency — no build step. This example follows the same convention:
`swalvo-rtc.js` (the SDK's own ESM build) is vendored here, and an
[import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap)
in `index.html` resolves the bare `@swalvo/rtc` specifier
`app.js` imports — so `app.js` is exactly what a real app's code would look
like after a bundler (Vite, webpack, esbuild) resolves those same imports;
only the resolution mechanism differs. Import maps are supported in all
current Chrome, Firefox, Safari, and Edge versions (Phase 6 spec §4's
target browsers).

In a real project, you would simply `npm install @swalvo/rtc` and let your
own bundler handle resolution — you would not vendor or copy any files.
