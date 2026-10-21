# Live Streaming Demo

A real two-browser demo of Livqeno Live Streaming — one host tab publishing
camera/microphone, one viewer tab receiving real media, plus live chat and
reactions — built entirely on `@swalvo/live`'s `LiveStream` API
(`swalvo.live.join()` / `LiveStream.join()`). `app.js` never touches
SDP or `RTCPeerConnection` directly.

This is deliberately not a polished product UI — see
`docs/live-streaming/overview.md` for the architecture this exercises.

## Running it

**1. Get a real API key.** Sign up for a Livqeno Cloud project at the
[dashboard](https://app.livqeno.com) and create an API key from the
project's API Keys tab (or `swalvo keys create`).

**2. Get the three SDK bundles this demo vendors.** `@swalvo/rtc`,
`@swalvo/chat`, and `@swalvo/live` are all published to npm, so
install them and copy their bundles in (no bundler, no CDN — same
convention as `examples/media-demo` and `examples/video-call`):

```bash
cd examples/live-streaming-demo
npm install @swalvo/rtc @swalvo/chat @swalvo/live
cp node_modules/@swalvo/rtc/dist/index.js{,.map} .
mv index.js swalvo-rtc.js; mv index.js.map swalvo-rtc.js.map
cp node_modules/@swalvo/chat/dist/index.js{,.map} .
mv index.js swalvo-chat.js; mv index.js.map swalvo-chat.js.map
cp node_modules/@swalvo/live/dist/index.js{,.map} .
mv index.js swalvo-client.js; mv index.js.map swalvo-client.js.map
```

**3. Start the backend** (mints tokens with a real API key — never sent to the browser):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
SWALVO_API_KEY=rvk_xxxx.yyyy SWALVO_API_URL=https://api.livqeno.com uvicorn server:app --port 8790
```

**4. Serve the page**: `python3 -m http.server 8891`

**5. Host tab**: open `http://localhost:8891/?role=host`, enter a title
and identity, click **Create + Go Live**. Grant the camera/microphone
permission prompts. Copy the Stream ID shown.

**6. Viewer tab**: open `http://localhost:8891/?role=viewer&stream=<id>`
(or paste the id manually), enter an identity, click **Join Stream** —
the host's video should appear within a couple of seconds.

**7. Chat both ways, react from the viewer tab, then End Stream from the host tab.**

## What this proves

- A host publishing real camera/microphone through `LiveStream.join()` →
  `stream.room.enableCamera()`/`enableMicrophone()` — ordinary
  `@swalvo/rtc` `Room` methods, not anything live-streaming-specific.
- A viewer receiving that media over a real SFU connection, with
  publish permission denied server-side (the viewer's RTC token is
  always subscribe-only, regardless of anything the browser sends).
- Chat both ways over the stream's auto-attached conversation, using
  `@swalvo/chat` exactly as documented elsewhere — no second chat
  implementation.
- Reactions landing on the stream's `chatRootMessageId`, aggregated on
  the existing `Reaction` model.
- The full lifecycle: create → start → (media/chat/reactions flow) →
  end, with the backend enforcing every transition.
