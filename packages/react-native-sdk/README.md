# @swalvo/react-native

Swalvo for React Native — real-time video, voice and messaging on iOS and
Android, with the same API as [`@swalvo/live`](https://www.npmjs.com/package/@swalvo/live),
the browser SDK you use in Next.js and other web apps.

Part of [Swalvo](https://github.com/atulsinghhhh/swalvo-sdks), open-source real-time communication infrastructure.

Reuses [`@swalvo/rtc`](https://www.npmjs.com/package/@swalvo/rtc)
unmodified: the protocol, reconnection and track handling are the same
code that runs in the browser, not a parallel implementation that drifts.

## Install

```bash
npm install @swalvo/react-native @swalvo/rtc @swalvo/chat
npm install react-native-webrtc react-native-incall-manager
```

Peer dependencies — your app chooses the versions:
`react >= 18`, `react-native >= 0.73`, `react-native-webrtc >= 124`,
`react-native-incall-manager >= 4.2`.

Camera and microphone permissions must be declared in `Info.plist` and
`AndroidManifest.xml`; see the reference below.

## Use

```tsx
import { Swalvo, SwalvoVideoView } from '@swalvo/react-native';

const swalvo = new Swalvo({ token, endpoint, iceServers });

const room = await swalvo.join(roomId);
await room.enableCamera();
await room.enableMicrophone();
```

```tsx
<SwalvoVideoView participant={participant} style={{ flex: 1 }} />
```

`audioRed` (Opus RED, default on) and `videoCodec` (`'vp8' | 'h264'`) pass
through to the RTC client. End-to-end encrypted rooms are **not supported**
yet — react-native-webrtc has no frame cryptor — and `swalvo.join()` fails
with `E2EE_NOT_SUPPORTED` rather than joining a room it could not send to.

### Data messages and metadata

The `Room` is the web SDK's, so data messages v2 and participant metadata
work the same way:

```tsx
await room.sendData(JSON.stringify(msg), { topic: 'chat', destinationIdentities: ['bob'] });
await room.sendData(cursor, { reliable: false }); // lossy, ≤1,200 bytes

useDataReceived(room, (payload, participant, topic) => …, { topic: 'chat' });
const { metadata, attributes } = useParticipantMetadata(participant);
await room.localParticipant.setAttributes({ hand: 'up' }); // needs perms.updateOwnMetadata
```

`participant` is `undefined` for a server-sent message. Data messages are
not end-to-end encrypted.

**Screen-share audio is not supported on React Native.**
react-native-webrtc's `getDisplayMedia` returns a video track only, so
`room.enableScreenShare({ audio: true })` shares video alone. Remote
`screenShareAudio` tracks from web publishers play like any other audio.

### Live streaming

```tsx
import { joinLiveStream } from '@swalvo/react-native';

const stream = await joinLiveStream(credentials);
```

## Exports

`Swalvo`, `SwalvoVideoView` (with `visible` for pausing off-screen video),
`SwalvoLiveStream`, `joinLiveStream`, `runConnectionTest`, the hooks
(`useActiveSpeakers`, `useIsSpeaking`, `useConnectionQuality`,
`useTrackSubscriptionState`, `useDataReceived`, `useParticipantMetadata`
among them), and the
`SwalvoConfig`, `SwalvoChatHandle`, `SwalvoAppState`, `LiveStreamCredentials`,
`LiveStreamRole` types.

## Documentation

- [React Native SDK reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/react-native.md)
- Runnable example: [`examples/mobile-rtc-chat`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/examples/mobile-rtc-chat)

Flutter? See [`swalvo_rtc`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/sdks/flutter/swalvo_rtc).

## License

MIT
