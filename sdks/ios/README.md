# SwalvoRTC for iOS and macOS

The native Swift client for Livqeno RTC: video and audio calls on iOS 15+
and macOS 12+. It speaks Livqeno's signaling protocol
([`docs/rtc/signaling.md`](../../docs/rtc/signaling.md)) directly, with one
PeerConnection to the SFU, and uses the same vocabulary as the web SDK:
`Room`, `LocalParticipant` / `RemoteParticipant`, `LocalTrack` /
`RemoteTrack`, and events named `participantJoined`, `trackSubscribed`,
`activeSpeakersChanged` and so on.

It holds only an RTC **token**, never your API key. Your backend mints the
token (TypeScript or Python server SDK) and your app passes on three fields
from the mint response: `token`, `endpoint` and `iceServers`.

## Install (Swift Package Manager)

The package lives in this monorepo at `sdks/ios`. SwiftPM can only depend on
a repository whose `Package.swift` is at the root, so until the package is
mirrored to its own repository, add it as a **local package**:

- **Xcode:** File → Add Package Dependencies… → Add Local… → choose `sdks/ios`,
  then add the `SwalvoRTC` library to your app target.
- **Package.swift:**

  ```swift
  dependencies: [
      .package(path: "../path/to/webrtrc/sdks/ios"),
  ],
  targets: [
      .target(name: "MyApp", dependencies: [.product(name: "SwalvoRTC", package: "SwalvoRTC")]),
  ]
  ```

It depends on LiveKit's libwebrtc build,
[livekit/webrtc-xcframework](https://github.com/livekit/webrtc-xcframework)
(product and module `LiveKitWebRTC`), pinned exactly to `150.7871.02`
(Chromium M150). Unlike upstream libwebrtc it ships `RTCFrameCryptor`, which
end-to-end encryption needs. It has iOS, iOS Simulator, Mac Catalyst and
macOS slices; SwiftPM downloads it (about 66 MB) on first resolve.

Its Objective-C classes are prefixed `LK` (`LKRTCVideoTrack`,
`LKRTCMTLVideoView`), so it can coexist with another WebRTC in one app.
`SwalvoRTC` re-declares the few types in its public API under their usual
names (`RTCMediaStreamTrack`, `RTCVideoTrack`, `RTCAudioTrack`,
`RTCVideoCapturer`); to use anything else from WebRTC directly,
`import LiveKitWebRTC` and use the `LK` names.

## Quickstart

```swift
import SwalvoRTC

@MainActor
func joinCall(grant: Grant) async throws -> Room {     // Grant = your backend's mint response
    var options = RoomOptions()
    options.iceServers = grant.iceServers               // [ICEServer]; always pass these (TURN)
    options.refreshToken = { try await myBackend.mintRtcToken() }

    let room = Room(options: options)

    // Subscribe before connecting to see every event, the roster included.
    Task {
        for await event in room.events() {
            switch event {
            case let .participantJoined(p):            addTile(for: p)
            case let .trackSubscribed(track, p):       attach(track, to: p)   // show video here, not on trackPublished
            case let .trackMuted(kind, p):             showMuted(kind, p)
            case let .activeSpeakersChanged(speakers): highlight(speakers.first)
            case let .disconnected(reason):            showEnded(reason)       // never auto-rejoin after .removed / .roomClosed
            default: break
            }
        }
    }

    try AudioSessionConfigurator.configureForCall(mode: .videoChat)   // iOS
    try await room.connect(token: grant.token, endpoint: grant.endpoint)
    try await room.enableMicrophone()
    try await room.enableCamera()
    return room
}
```

Render a video with `SwalvoVideoView` (a `UIView` on iOS, `NSView` on macOS):

```swift
let view = SwalvoVideoView()
view.track = remoteTrack          // also reports visibility/size to adaptive stream
```

Or attach any `RTCVideoRenderer` yourself: `track.videoTrack?.add(renderer)`.

`SwalvoClient(options:).connect(token:endpoint:)` is the one-line form that
returns a connected `Room` (phase 5 §4 naming); use `Room(options:)` +
`connect` when you need the roster's events.

Leave with `await room.leave()`. A `Room` is single-use: create a new one to
join again.

## Permissions (Info.plist)

| Key | Needed for |
|---|---|
| `NSCameraUsageDescription` | `enableCamera()` |
| `NSMicrophoneUsageDescription` | `enableMicrophone()` |
| `UIBackgroundModes` → `audio` | keeping a call's audio alive in the background |
| `UIBackgroundModes` → `voip` | CallKit with VoIP pushes (PushKit) |

On macOS add the **Camera** and **Audio Input** entitlements under App
Sandbox (`com.apple.security.device.camera`,
`com.apple.security.device.audio-input`) and **Outgoing Connections
(Client)** (`com.apple.security.network.client`).

## Events

`room.events()` returns an `AsyncStream<RoomEvent>`; call it as many times as
you like (each stream is independent). Or set `room.delegate`. The cases
mirror the web SDK's `RoomEventMap`
([events reference](https://docs.livqeno.com)):

| Group | Events |
|---|---|
| Connection | `connectionStateChanged`, `connected`, `disconnected(reason:)`, `reconnecting`, `reconnected`, `warning`, `error` |
| Participants | `participantJoined`, `participantLeft`, `participantMetadataChanged` |
| Remote tracks | `trackPublished`, `trackUnpublished`, `trackSubscribed`, `trackUnsubscribed`, `trackMuted`, `trackUnmuted` |
| Media quality | `activeSpeakersChanged`, `connectionQualityChanged`, `trackSubscriptionStateChanged` |
| Your tracks | `localTrackPublished`, `localTrackUnpublished`, `localTrackMutedByServer`, `permissionsChanged` |
| Data | `dataReceived`, `dataMessageReceived`, `dataThrottled` |
| E2EE | `e2eeStateChanged` |

New cases are added to `RoomEvent`, `ParticipantEvent` and `TrackSource`
in minor releases. An exhaustive `switch` should end with
`@unknown default:`, which turns a new case into a compiler warning rather
than a build error (Swift Package Manager builds the SDK from source, so the
compiler cannot make additions fully non-breaking on its own). A
`default: break` like the quickstart's also keeps compiling.

Each participant also has `events()` (`isSpeakingChanged`,
`connectionQualityChanged`) and current values: `isSpeaking`, `audioLevel`,
`connectionQuality` (`.unknown` until the server scores them).

`DisconnectReason` is the web SDK's set (`clientInitiated`, `removed`,
`roomClosed`, `tokenExpired`, `connectionFailed`) plus `tokenRevoked` and
`replaced` (close 4002: another device took over this identity).

## Reconnection, resume and tokens

All of this is automatic; listed so you know what you will see.

- **Drops** reconnect with full-jitter exponential backoff (300 ms base,
  10 s cap, 12 attempts) and send the latest resume token. `room.joined
  { resumed: true }` keeps the PeerConnection (media never stopped);
  `resumed: false` rebuilds it and republishes your tracks. Either way you
  get `reconnecting` then `reconnected`.
- **Close 1012** (API restarting): reconnect after a random 0–2 s, with resume.
- **Close 4003** (removed / room closed): never reconnects; `disconnected(.removed | .roomClosed)`.
- **Close 4002** (replaced): never reconnects; `disconnected(.replaced)`.
- **Close 4004** (SFU node lost): reconnects without resume.
- **Close 4001 / `TOKEN_EXPIRED` / `TOKEN_REVOKED`**: calls
  `RoomOptions.refreshToken`, then reconnects with the new token. Without
  `refreshToken` the room disconnects with `.tokenExpired`.
- **`token.expiring`**: calls `refreshToken` and swaps the token in place
  (`token.refresh`), no reconnect. A refusal is a `TOKEN_REFRESH_FAILED`
  warning, not an error.
- **Network change**: call `room.handleNetworkChange()` from your
  `NWPathMonitor` handler to retry immediately and restart ICE.

## Simulcast, adaptive stream and paused video

- The camera publishes three layers (`low`/`medium`/`high`, ¼, ½ and full
  resolution — the web SDK's ladder). `room.simulcastConfirmed()` reports
  whether all three survived negotiation. Screen shares are one layer.
- `publisher.layers` (dynacast) is applied automatically: layers nobody
  watches stop being encoded and sent.
- For each remote video: `track.setEnabled(false)` pauses it (layer `off`:
  the SFU stops forwarding, nothing is renegotiated), `setLayer(.low)` pins a
  layer, and with `adaptiveStream` on (default) `SwalvoVideoView` pauses
  off-screen tiles after 500 ms and picks the layer from the view's size.
- `track.subscriptionState` (`.active`, `.pausedBandwidth`, `.pausedClient`)
  and `track.layer` are what the SFU is actually doing — show a "paused for
  bandwidth" badge from `trackSubscriptionStateChanged`.
- `RoomOptions.autoSubscribe = false` starts every video paused until you
  ask for it (large rooms, galleries). Audio always flows.

## Permissions, moderation and server mute

`room.permissions` is what the server says you may do. On
`permissionsChanged`, rights that were withdrawn have already stopped those
tracks (`localTrackUnpublished`, no error); rights granted take effect at
once (`enableCamera()` works without reconnecting). When your backend mutes
you, the track is already muted locally and `localTrackMutedByServer`
fires; unmuting is left to the user (`track.unmute()`).

## CallKit (iOS)

`CallKitManager` wraps `CXProvider`/`CXCallController` and hands audio-session
activation to WebRTC correctly (`useManualAudio` until CallKit activates the
session):

```swift
let callKit = CallKitManager(configuration: .init(localizedName: "Acme"))
callKit.onAnswer = { _ in try await room.connect(token: grant.token, endpoint: grant.endpoint) }
callKit.onEnd = { _ in await room.leave() }
callKit.onMute = { _, muted in
    await room.localParticipant.tracks.first { $0.source == .microphone }?.setMuted(muted)
}
try await callKit.reportIncomingCall(uuid: callId, handle: "Alice", hasVideo: true)
```

Ringing is your app's business (a VoIP push from your backend): Livqeno has
no notion of an unanswered call. With PushKit you must report the call to
CallKit inside the push handler or iOS terminates the app. When the room
ends on its own, call `callKit.reportEnded(uuid:reason:)`.

Without CallKit, use `AudioSessionConfigurator.configureForCall(mode:)` and
`setSpeakerOutput(_:)`.

## Screen share

- **This app only:** `try await room.enableScreenShare()` (ReplayKit in-app
  capture; foreground only).
- **Whole device:** a Broadcast Upload Extension. Copy
  [`Templates/BroadcastUploadExtension`](Templates/BroadcastUploadExtension)
  — it joins as a second, publish-only participant and publishes a
  `screenShare` track. See its README for the App Group token handoff.
- **macOS:** not built in yet. Feed ScreenCaptureKit frames into
  `LocalMedia.createBufferTrack(source: .screenShare)` and `room.publish(_:)`.

**Screen-share audio** (source `screenShareAudio`) is published by the
Broadcast Upload Extension template from ReplayKit's `.audioApp` buffers
(`LocalMedia.createBroadcastAudioTrack()`; the extension's token needs
`publishAudio`). In-app `enableScreenShare()` is **video only**: libwebrtc
feeds audio tracks from the process's one audio device, which in the app is
the microphone, so in-app capture cannot publish app audio as a second
track. Unpublishing a `screenShare` also unpublishes the `screenShareAudio`
published from the same `Room`. Remote `screenShareAudio` tracks arrive as
ordinary audio tracks (`track.kind == .screenShareAudio`) and never count
as active speakers.

## Data

`try room.sendData(Data(...))` sends over the `raven-data` data channel;
`dataReceived` delivers incoming bytes. The first send opens the channel (one
renegotiation), so it may throw `.notConnected` until it is open.

Data messages v2 (phase 7) add topics, targeting, a lossy channel and sender
attribution:

```swift
try room.sendData(Data(json), options: DataPublishOptions(topic: "chat"))
try room.sendData(cursor, options: DataPublishOptions(topic: "cursor", reliable: false))
try room.sendData("psst", options: DataPublishOptions(destinationIdentities: ["bob"]))

for await event in room.events() {
    if case let .dataMessageReceived(message) = event {
        // message.participant: the sender (stamped by the SFU, not the sender);
        // nil for a server message (senderIdentity == "") or a legacy one.
        handle(message.payload, from: message.participant, topic: message.topic)
    }
}
```

- `reliable: false` goes over `raven-data-lossy` (unordered, no
  retransmits, at most 1,200 bytes). Reliable messages are at most 64 KiB.
  Topics are at most 255 bytes of UTF-8; at most 64 destinations.
  Breaking a limit throws `.invalidArgument`.
- Both channels carry the data channel protocol `raven.v2`, which tells
  the SFU this client reads its sender/topic framing. In a `data.v2` room
  both open right after join; otherwise the reliable one opens on first use,
  as before.
- Every message emits both `dataReceived(_, participant:)` (now attributed)
  and `dataMessageReceived(DataMessage)` (with the topic). Handle one.
- Against a server without `data.v2` (`room.supportsDataV2 == false`),
  `sendData` with no options sends exactly the legacy bytes; options still
  send a v2 envelope, and `reliable: false` falls back to the reliable
  channel with a one-time warning.
- Over the SFU's rate limit (100 msg/s and 1 MiB/s reliable, 300 msg/s
  lossy) messages are dropped and `dataThrottled(channel:)` fires.
- **Data messages are not end-to-end encrypted**, even in an E2EE room.

## Participant metadata and attributes

Every participant has `metadata` (an opaque string, at most 4 KiB) and
`attributes` (`[String: String]`, at most 32 keys). Initial values come from
the token (`metadata` / `attributes` at mint); changes arrive as
`participantMetadataChanged(participant:previousMetadata:previousAttributes:)`
(and `.metadataChanged` on the participant's own `events()`).

```swift
try await room.localParticipant.setMetadata(#"{"role":"presenter"}"#)
try await room.localParticipant.setAttributes(["hand": "raised"]) // merged server-side
```

Both need a token minted with `perms.updateOwnMetadata` (otherwise
`.permissionDenied`) and change the value only when the server confirms.
Servers can change anyone's with `PATCH /v1/rooms/:roomId/participants/:identity`.

## End-to-end encryption

E2EE rooms (`POST /v1/rooms { e2ee: true }`) are flagged by the token's
`e2ee` claim and by `room.joined`; `room.isE2EE` reports it.

```swift
var options = RoomOptions()
options.e2eeKeyProvider = E2EEKeyProvider()        // shared-passphrase mode
let room = Room(options: options)
try await room.connect(token: grant.token, endpoint: grant.endpoint)
try room.setE2EEPassphrase(sharedSecret)            // salted with the token's rid
try await room.enableCamera()                       // encrypted from the first frame
```

- **Media is encrypted** with libwebrtc's frame cryptor from LiveKit's
  WebRTC build (`E2EE/FrameEncryption.swift`). In an E2EE room with keys
  configured, every sender gets an AES-GCM `RTCFrameCryptor` before its
  offer, and every subscribed receiver one keyed for its publisher. The
  native key provider is created exactly as phase 5 §3.1 (as built) says and
  as the Flutter and Android SDKs do: `ratchetSalt = "LivqenoRatchet"`, HKDF
  key derivation, `ratchetWindowSize = 8`, no uncrypted magic bytes,
  `failureTolerance = -1`, `keyRingSize = 16`,
  `discardFrameWhenCryptorNotReady = true`. It is handed key *material*
  (PBKDF2 output in passphrase mode, your raw 32 bytes per participant) and
  derives the AES key itself; every `setSharedKey`/`setKey`/`ratchetKey` on
  the room's `E2EEKeyProvider` is mirrored into it in order. Cryptor state
  callbacks become `e2eeStateChanged` (`ok`, `missingKey`, `encryptFailed`,
  `decryptFailed`; a followed ratchet is `ok`). `room.isE2EEActive` says
  encryption is on; `E2EESupport.isFrameEncryptionAvailable` is `true`.
- **Key modes:** the native provider has one mode for its life. Pass
  `E2EEKeyProvider(sharedKeyMode: false)` for per-participant keys
  (`room.setKey(participantId:key:keyIndex:)`; your own identity's key is
  what you send with). Left nil, the mode is per-participant if a
  participant key is set before encryption starts, shared otherwise.
- **Never plaintext into an E2EE room:** with no key provider configured
  (neither `RoomOptions.e2eeKeyProvider` nor a key set on the room),
  publishing throws `RTCError(.e2eeRequired)` (the web SDK's
  `E2EE_REQUIRED`). If a cryptor cannot be created for a sender, that track
  is not published (`.e2eeNotSupported`). A key provider configured for an
  ordinary room does nothing; media is sent as usual, like the web SDK.
- **Key schedule and frame format in Swift** (`E2EEKeyDerivation`,
  `E2EEKeyProvider`, `E2EEFrameCodec`), kept for the vectors and tooling:
  PBKDF2 passphrase → 32-byte material, HKDF → AES-128 key, HKDF ratchet with
  a forward ratchet window on receive, AES-GCM frames with the codec-specific
  clear header, `ts − sendCount mod 0xFFFF` IVs and RBSP-escaped H.264. The
  tests reproduce every case in
  [`docs/architecture/e2ee-vectors.json`](../../docs/architecture/e2ee-vectors.json)
  byte for byte, and the passphrase salt is the token's `rid` claim — the
  same as the web and Android SDKs. Keys: `room.setE2EEPassphrase(_:)`,
  `room.setKey(participantId:key:keyIndex:)`, `room.ratchetKey(participantId:)`.
- **Still needs device verification** (nothing headless can push frames
  through the cryptor): an encrypted call between two iOS devices, iOS ↔
  macOS, and iOS ↔ web / Android / Flutter in one room, with camera (VP8
  and H.264) and microphone; a wrong passphrase showing `decryptFailed` on
  the receiver; a late `setE2EEPassphrase` going from `missingKey` to `ok`;
  `ratchetKey` on one side being followed by the other within the window;
  per-participant keys; a fresh rejoin (`resumed: false`) re-attaching
  cryptors; and that no plaintext reaches the SFU (e.g. a non-E2EE
  subscriber sees undecodable video).

## Testing

```sh
cd sdks/ios
swift build                   # library, macOS
./scripts/test-macos.sh       # the test suite (swift-testing)
```

The suite uses **swift-testing**, not XCTest: XCTest is not part of the
Command Line Tools, and swift-testing is (Xcode 16+ runs the same suite).
With full Xcode selected, `swift test` works directly; with only the
Command Line Tools, `scripts/test-macos.sh` adds the framework search paths
SwiftPM leaves out.

What runs headless on macOS:

- every client and server message from the protocol doc, decoded and
  re-encoded against JSON fixtures (`Tests/.../Fixtures`);
- the signaling state machine against a scripted fake WebSocket: join,
  resume (`resumed: true/false`), 1012 jitter + resume, 4001 refresh +
  reconnect, 4002/4003 no reconnect, 4004 no resume, backoff growth, live
  `token.expiring` → `token.refresh`, refused refresh as a warning;
- server messages → `Room` events with a fake media engine (roster,
  `track.published`/`ontrack` in both orders, speakers, quality,
  `subscription.state` before and after its track, `publisher.layers`,
  `setEnabled` → layer `off`, permissions revoked, server mute, removal,
  resumed vs fresh rejoin, E2EE publish refusal);
- the phase 7 data envelope against `docs/architecture/data-envelope-vectors.json`
  (encode, encode errors, decode), data v2 send/receive, `data.throttled`,
  participant metadata and `participant.update`, screen-share audio
  plumbing and its PCM conversion;
- E2EE against the shared vectors; E2EE wiring with a fake cryptor backend
  (native key-provider options, key mode, key mirroring order, sender and
  receiver cryptors, sender key index, state → `e2eeStateChanged`,
  `E2EE_REQUIRED` / `E2EE_NOT_SUPPORTED`, no encryption in ordinary rooms);
  and against the real LiveKit libwebrtc: its key provider, configured as
  the SDK configures it, ratchets exactly as the vectors say, and real
  cryptors attach to real senders/receivers (including through
  `PeerConnectionEngine` publish, rejoin and unpublish);
- the real `PeerConnectionEngine` against a second `RTCPeerConnection`
  playing the SFU over loopback: answering the SFU's offer (`a=setup:active`),
  attributing the remote track by msid, publishing (`track.publish` before
  the offer), the simulcast offer carrying three RIDs, an ICE-restart offer.

What needs Xcode and a device or simulator: camera/microphone capture,
`AudioSessionConfigurator`, `CallKitManager`, ReplayKit screen share, the
Broadcast Upload Extension, `SwalvoVideoView` rendering, and an end-to-end
call against a running SFU. The iOS-only sources do compile: they are
type-checked through a Mac Catalyst build (against the xcframework's
Catalyst slice), but no iOS Simulator SDK ships with the Command Line Tools:

```sh
SDK=$(xcrun --show-sdk-path); IOS=$SDK/System/iOSSupport
swift build --triple arm64-apple-ios15.0-macabi --scratch-path .build-catalyst --target SwalvoRTC \
  -Xswiftc -sdk -Xswiftc "$SDK" \
  -Xswiftc -Fsystem -Xswiftc "$IOS/System/Library/Frameworks" \
  -Xswiftc -I -Xswiftc "$IOS/usr/include" -Xswiftc -L -Xswiftc "$IOS/usr/lib" \
  -Xcc -isystem -Xcc "$IOS/usr/include" -Xcc -iframework -Xcc "$IOS/System/Library/Frameworks"
```

## Package layout

```
sdks/ios/
├── Package.swift                      SwalvoRTC, iOS 15 / macOS 12, LiveKitWebRTC 150.7871.02
├── Sources/SwalvoRTC/
│   ├── Protocol/SignalingProtocol.swift   every client/server message, Codable, tolerant decoding
│   ├── Signaling/
│   │   ├── WebSocket.swift                transport protocol + URLSessionWebSocketTask implementation
│   │   └── SignalingClient.swift          join, resume, backoff/jitter, close codes, token refresh (actor)
│   ├── Engine/
│   │   ├── MediaEngine.swift              engine protocol (faked in tests), ICEServer
│   │   ├── PeerConnectionEngine.swift     one PeerConnection to the SFU, glare, trickle ICE, simulcast, dynacast
│   │   └── SDPUtilities.swift             msid-by-mid, simulcast checks, RID aliases
│   ├── Room/                              Room, RoomEvent, RoomOptions, SwalvoClient
│   ├── Model/                             Participant, Track (adaptive layer policy), event fan-out
│   ├── Media/LocalMedia.swift             camera, microphone, ReplayKit, buffer capturer
│   ├── E2EE/E2EE.swift                    key schedule, key provider, frame codec
│   ├── E2EE/FrameEncryption.swift         libwebrtc frame cryptors: native key provider, per-sender/receiver cryptors
│   ├── Platform/                          AudioSessionConfigurator, CallKitManager (iOS), SwalvoVideoView
│   └── Core/                              errors, logger, token claims, WebRTCShim (LK-prefixed type aliases)
├── Templates/BroadcastUploadExtension/    SampleHandler.swift + setup README
├── Tests/SwalvoRTCTests/                  swift-testing suites + JSON fixtures + E2EE vectors
└── scripts/test-macos.sh
```
