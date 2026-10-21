# @swalvo/react

React hooks and optional UI primitives for [`@swalvo/rtc`](https://www.npmjs.com/package/@swalvo/rtc)
and [`@swalvo/chat`](https://www.npmjs.com/package/@swalvo/chat).
Headless by default — no UI lock-in.

Part of [Livqeno](https://github.com/atulsinghhhh/swalvo-sdks), open-source real-time communication infrastructure.

## Install

```bash
npm install @swalvo/react @swalvo/rtc
```

`@swalvo/rtc`, `@swalvo/chat`, `@swalvo/live` and `react` are **peer dependencies**: your app chooses the versions, and
there must be exactly one copy of `@swalvo/rtc` in the tree.

## Use

```tsx
'use client';
import {
  SwalvoRoom,
  useConnectionState,
  useCamera,
  useLocalParticipant,
  ParticipantView,
} from '@swalvo/react';

export function CallPage({ token, endpoint, room }) {
  return (
    <SwalvoRoom token={token} endpoint={endpoint} room={room} fallback={<p>Connecting…</p>}>
      <Call />
    </SwalvoRoom>
  );
}

function Call() {
  const state = useConnectionState();
  const camera = useCamera();
  const local = useLocalParticipant();

  return (
    <>
      <p>Status: {state}</p>
      <button onClick={() => (camera.enabled ? camera.disable() : camera.enable())}>
        Toggle camera
      </button>
      {local && <ParticipantView participant={local} />}
    </>
  );
}
```

## Hooks

`useSwalvo`, `useSwalvoClient`, `useRoom`, `useConnectionState`,
`useCamera`, `useMicrophone`, `useLocalParticipant`,
`useRemoteParticipants`, `useParticipants`, `useSwalvoError`,
`useActiveSpeakers`, `useIsSpeaking`, `useConnectionQuality`,
`useTrackSubscriptionState`, `useE2EEState`.

`<SwalvoRoom>` takes every `createRTCClient` option, including
`e2ee={{ keyProvider: createSharedKeyProvider(passphrase) }}` (re-exported
here), `videoCodec` and `audioRed`.

The hooks are headless; the components are optional. Build your own UI if
you prefer — nothing forces you through `ParticipantView`.

## Prebuilt video UI

A whole call screen in one component, plus every piece on its own:

```tsx
import { SwalvoRoom, VideoConference } from '@swalvo/react';
import '@swalvo/react/video/styles.css'; // optional

<SwalvoRoom token={grant.token} endpoint={grant.endpoint} room={grant.roomName}>
  <VideoConference onLeave={() => router.back()} />
</SwalvoRoom>;
```

Components: `VideoConference`, `PreJoin`, `GridLayout`, `FocusLayout`,
`ParticipantTile`, `ControlBar`, `TrackToggle`, `MediaDeviceMenu`,
`DisconnectButton`, `ChatToggle`, `ConnectionQualityIndicator`,
`RoomAudioRenderer`, `StartAudio`, `Toast`, `ConnectionStateToast`.
Hooks: `useTracks`, `useTrackToggle`, `useScreenShare`, `useMediaDevices`,
`useMediaDeviceSelect`, `useRoomConnectionState`, `useDisconnectButton`,
`usePinnedTracks`, `useChatToggle`, `useAudioPlayback`, `useAudioLevel`.
Unstyled by default (`swalvo-*` classes, `data-*` state); the stylesheet is
themed with CSS variables. See `apps/docs/content/sdk/react-components.mdx`.

## Documentation

- [React SDK reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/react.md)
- Runnable example: [`examples/react-video-call`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/examples/react-video-call)

## License

MIT
