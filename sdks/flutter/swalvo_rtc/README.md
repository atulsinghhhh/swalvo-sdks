# swalvo_rtc

Swalvo's Flutter SDK — join a room, publish camera and microphone, render
participants. Hides WebRTC, SDP, ICE, STUN, TURN and the media server
behind a small typed API.

Part of [Swalvo](https://swalvo.com), managed real-time communication infrastructure.

## Requirements

- Dart SDK **>= 3.6.0**
- Flutter **>= 3.27.0**

## Install

```yaml
dependencies:
  swalvo_rtc: ^0.3.0
```

Camera and microphone permissions must be declared in `Info.plist` and
`AndroidManifest.xml` — see the reference below.

### Migrating from `raven_rtc`

This package was previously published as `raven_rtc`. Replace the
dependency with `swalvo_rtc` and the import with
`package:swalvo_rtc/swalvo_rtc.dart`. The `Raven*` type names (`RavenRoom`,
…) still compile as deprecated aliases of the `Swalvo*` ones until 1.0;
error code strings (`RAVEN_*`) and the wire protocol are unchanged.

## Use

The token comes from your own backend, never from the app. See the
[TypeScript](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/server/typescript.md) or
[Python](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/server/python.md) server SDK.

```dart
import 'package:swalvo_rtc/swalvo_rtc.dart';

final swalvo = Swalvo(
  token: grant.token,
  endpoint: grant.endpoint,
  iceServers: grant.iceServers,
);

final room = await swalvo.join(roomId);

await room.enableCamera();
await room.enableMicrophone();
```

Render a participant:

```dart
SwalvoVideoView(participant: participant)
```

`SwalvoRoom` is a `ChangeNotifier`, so `ListenableBuilder` and
`AnimatedBuilder` work as you would expect.

### Speakers, quality and paused video

What the media server measures is on each participant snapshot:

```dart
participant.isSpeaking;          // the SFU counts them as an active speaker
participant.audioLevel;          // 0..1
participant.connectionQuality;   // excellent / good / poor / lost / unknown

room.activeSpeakers;             // loudest first, you included
room.activeSpeakerChanges;       // Stream<List<SwalvoParticipant>>
room.connectionQualityChanges;   // Stream<SwalvoConnectionQualityUpdate>
room.subscriptionStateChanges;   // Stream<SwalvoSubscriptionStateUpdate>
```

A remote video can be paused at the server without unsubscribing, either by
hand or by saying a view is not on screen:

```dart
room.setVideoEnabled(participant, SwalvoTrackKind.camera, false);
SwalvoVideoView(participant: participant, room: room, visible: onScreen);
```

With `adaptiveStream` on (the default), a video whose every view has been
hidden or zero-sized for half a second is paused, and resumes as soon as one
is shown. `participant.videoTrackFor(kind)?.subscriptionState` says whether
the server is forwarding it (`active`, `pausedBandwidth`, `pausedClient`).
`Swalvo(autoSubscribe: false)` joins with every remote video paused until a
view or `setVideoEnabled(…, true)` asks for it. `dynacast` (default on)
lets the server switch off the camera layers nobody is receiving.

Against a server that predates these, nothing changes: speakers stay empty,
quality reads `unknown`, and every layer keeps flowing.

End-to-end encryption, for rooms created with `e2ee: true` (iOS, Android and
desktop; not Flutter Web). It interoperates with the web SDK:

```dart
final swalvo = Swalvo(
  token: token,
  endpoint: endpoint,
  e2ee: SwalvoE2EEOptions(SwalvoKeyProvider.sharedPassphrase(passphrase)),
  videoCodec: SwalvoVideoCodec.vp9, // SVC; VP8 simulcast where unsupported
);
room.e2eeStateChanges.listen((update) => print('${update.participant.identity}: ${update.state}'));
```

Opus RED is on by default (`audioRed: false` to turn it off; it is off
while E2EE is configured).

### Data messages

```dart
await room.sendData(utf8.encode('hi'));                              // everyone, reliable
await room.sendData(bytes, topic: 'chat', destinationIdentities: ['bob']);
await room.sendData(cursor, reliable: false);                        // lossy, <= 1,200 bytes

room.dataMessages.listen((message) {
  message.participant; // the sender as the SFU attests it; null = the server
  message.topic;       // null when none
  message.payload;
});
room.dataThrottled.listen((event) => print('slow down: ${event.channel}'));
```

`room.data` (payload only) still works. Reliable payloads are limited to
64 KiB, topics to 255 bytes, destinations to 64; a broken limit throws
`SwalvoErrorCode.invalidArgument`. Topics, targeting, sender attribution and
the lossy channel need a server advertising `data.v2`
(`room.supportsDataV2`); without it `reliable: false` falls back to the
reliable channel. Against a `data.v2` server both channels open at join,
with the data channel protocol `raven.v2`, so the server sends this device
attributed messages. On Flutter Web the lossy channel is unordered but still
retransmitted (flutter_webrtc's web layer drops `maxRetransmits: 0`). Data
messages are **not** end-to-end encrypted, even in an E2EE room.

### Metadata and attributes

```dart
participant.metadata;    // String?, from the token's `md`, then live
participant.attributes;  // Map<String, String>, from the token's `attrs`
room.participantMetadataChanges.listen((change) =>
    print('${change.participant.identity}: ${change.previousMetadata} -> ${change.participant.metadata}'));

await room.setMetadata('{"seat":3}');       // needs perms.updateOwnMetadata
await room.setAttributes({'hand': 'up'});   // merges keys
```

Without the grant both throw `SwalvoErrorCode.permissionDenied`. Limits:
metadata 4 KiB, 32 attributes, 64-character keys, 1 KiB values. Values
change when the server confirms them, never optimistically.

### Screen-share audio

`room.enableScreenShare(audio: true)` publishes the shared audio as
`SwalvoTrackKind.screenShareAudio` where the platform returns any: Flutter Web
on Chromium (a tab, or the whole screen on Windows/ChromeOS).
flutter_webrtc's native iOS and Android screen capturers return no audio
track, so on mobile the share is video only
(`participant.isScreenShareAudioEnabled` reads false). `disableScreenShare()`
stops both.

## Documentation

- [Flutter SDK reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/flutter.md)
- [RTC architecture](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/rtc/architecture.md)
- Runnable example: [`examples/flutter-rtc-chat`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/examples/flutter-rtc-chat)

Messaging is a separate package —
[`swalvo_chat`](https://pub.dev/packages/swalvo_chat) — so a video app never
carries a message store.

## License

MIT
