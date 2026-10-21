# @swalvo/rtc

Swalvo's browser RTC SDK — join a room, publish camera and microphone,
subscribe to remote media. Hides SDP, ICE, STUN, TURN and the media server
behind a small typed API.

Part of [Swalvo](https://github.com/atulsinghhhh/swalvo-sdks), open-source real-time communication infrastructure.

## Install

```bash
npm install @swalvo/rtc
```

## Use

The token and endpoint come from your own backend — never mint them in a
browser. See [`@swalvo/server`](https://www.npmjs.com/package/@swalvo/server)
or [Swalvo's Python SDK](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/sdks/python) for Python (not on PyPI yet — will
publish as `swalvo-sdk`).

```ts
import { createRTCClient } from '@swalvo/rtc';

// `grant` is your backend's RTC token-mint response, forwarded verbatim.
// It already carries the endpoint, the ICE servers and the room, so there
// is nothing here to configure and no URL to hand-build.
const client = createRTCClient(grant);
const room = await client.join();

// Spelling out the same thing, if you prefer to be explicit:
//   const client = createRTCClient({
//     token: grant.token,
//     endpoint: grant.endpoint,       // Swalvo's signaling WebSocket
//     iceServers: grant.iceServers,   // never hand-build STUN/TURN config
//   });
//   const room = await client.join(grant.roomName);

await room.enableCamera();
await room.enableMicrophone();

room.on('trackSubscribed', (track) => {
  document.body.appendChild(track.attach());
});
```

`join()` resolves once the **control plane** admits you. You can publish
immediately, but ICE and DTLS finish a moment later — render from the
`connected` event rather than assuming:

```ts
room.on('connected', () => setStatus('live'));
// or, if you must block: await room.waitUntilConnected();
```

Reconnection is automatic. A short drop resumes the session without
touching media; a longer one, or a media connection that fails on its own,
is rebuilt and your tracks republished. When the SDK stops for good,
`disconnected` says why — never rejoin automatically after `REMOVED` or
`ROOM_CLOSED`. Pass `refreshToken` to keep calls alive past the token's
expiry:

```ts
const client = createRTCClient({ ...grant, refreshToken: () => fetchFreshRtcToken() });
room.on('disconnected', (reason) => console.log('left the room:', reason));
room.on('permissionsChanged', (permissions) => setCanPublish(permissions.publish));
```

Call quality comes from the media server and is pushed, never polled:

```ts
room.on('activeSpeakersChanged', (speakers) => spotlight(speakers[0]));
room.on('connectionQualityChanged', (participant, quality) => setBadge(participant, quality));
room.on('trackSubscriptionStateChanged', (track) => showPaused(track, track.subscriptionState === 'paused_bandwidth'));

remoteTrack.setEnabled(false); // pause a video at the server; adaptiveStream already pauses hidden ones
```

Before a call, `runConnectionTest({ token, endpoint, iceServers })` checks
camera, microphone, signaling, media, TURN over UDP/TCP/TLS, and measures
RTT, jitter, loss and upload. It is tree-shaken out when unused.

End-to-end encryption, for rooms created with `e2ee: true` (the encryption
worker is only bundled when you call a key provider factory):

```ts
import { createRTCClient, createSharedKeyProvider } from '@swalvo/rtc';

const client = createRTCClient({ ...grant, e2ee: { keyProvider: createSharedKeyProvider(passphrase) } });
room.on('e2eeStateChanged', (participant, state) => state !== 'ok' && warnCannotDecrypt(participant));
```

Data messages carry the sender (as the media server saw it) and an
optional topic, can target people, and have a lossy mode for
latest-value-wins state. Without options `sendData()` sends exactly what it
always has:

```ts
await room.sendData('hello');                                         // everyone, reliable
await room.sendData(JSON.stringify(msg), { topic: 'chat', destinationIdentities: ['bob'] });
await room.sendData(cursorBytes, { reliable: false, topic: 'cursor' }); // ≤1,200 bytes, may drop

room.on('dataReceived', (payload, participant, topic) => {
  // participant is undefined for a server message (POST /v1/rooms/:roomId/data)
});
room.on('dataThrottled', (channel) => console.warn('sending too fast on', channel));
```

Topics are at most 255 bytes and destinations at most 64 (`INVALID_ARGUMENT`
otherwise); reliable payloads at most 64 KiB. `reliable: false` needs a
server that announces `data.v2`, and falls back to reliable (with one
warning) against an older one. **Data messages are not end-to-end
encrypted**, even in an E2EE room.

Participants carry `metadata` (a string, ≤4 KiB) and `attributes`
(`Record<string, string>`, ≤32 keys), seeded from the token and updated
live:

```ts
room.on('participantMetadataChanged', (participant, prev) => render(participant.attributes));
await room.localParticipant.setAttributes({ hand: 'up' }); // needs perms.updateOwnMetadata in the token
await room.localParticipant.setMetadata(JSON.stringify({ status: 'away' }));
```

Without the `updateOwnMetadata` grant these throw `PERMISSION_DENIED`. The
new values arrive with `participantMetadataChanged`, not optimistically.

Screen share with audio, where the browser offers it (Chrome: a tab, or the
screen on Windows/ChromeOS). The audio is a second track with source
`screenShareAudio`; disabling the share stops both:

```ts
await room.enableScreenShare({ audio: true });
```

Codecs: `videoCodec: 'vp8' | 'h264' | 'vp9' | 'av1'` (VP9/AV1 publish SVC,
falling back to VP8 simulcast); Opus RED is on by default (`audioRed: false`
to turn it off).

## Exports

`createRTCClient`, `RTCClient`, `Room`, `Participant`,
`LocalParticipant`, `RemoteParticipant`, `Track`, `LocalTrack`,
`RemoteTrack`, `RTCError`, `isRTCError`, `runConnectionTest`,
`createSharedKeyProvider`, `createKeyProvider`, `KeyProvider`,
`isE2EESupported`.

## Documentation

- [Browser SDK reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk.md)
- [RTC architecture](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/rtc/architecture.md)
- [Signaling protocol](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/rtc/signaling.md)
- [What is and is not tested](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/rtc/test-matrix.md)
- Runnable examples: [`video-call`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/examples/video-call)

## React?

Use [`@swalvo/react`](https://www.npmjs.com/package/@swalvo/react) —
headless hooks over this package, with optional components.

## License

MIT
