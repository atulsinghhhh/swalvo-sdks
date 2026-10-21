# Changelog

All notable changes to SwalvoRTC (formerly LivqenoRTC) for iOS and macOS are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Data channels open only when the token grants `publishData`. Against a `data.v2` server the SDK opened both channels at join; opening one is an offer, which the API refuses for a participant without publish or publishData (every live-stream viewer), failing the connection with `PERMISSION_DENIED`. A data stream listener without the grant no longer opens a channel, `sendData()` rejects with a permission-denied error, and the channels open if the grant arrives mid-session.

### Changed

- Renamed to Swalvo: the Swift package, product and module `LivqenoRTC` are
  now `SwalvoRTC` (`import SwalvoRTC`). `RavenClient` is now `SwalvoClient`,
  `LivqenoVideoView` is now `SwalvoVideoView` and `LivqenoRTCVersion` is now
  `SwalvoRTCVersion`; the old type names remain as deprecated typealiases.
  The os_log subsystem is now `com.swalvo.rtc`. Wire identifiers (data
  channel labels `raven-data` / `raven-data-lossy`, protocol `raven.v2`) and
  the E2EE key-derivation labels (`LivqenoE2EE:`, `LivqenoRatchet`) are
  unchanged, so this release interoperates with every earlier client.

### Breaking

- New enum cases break exhaustive `switch` statements that have no
  `default`: `RoomEvent` gains `e2eeStateChanged`,
  `participantMetadataChanged`, `dataMessageReceived`, `dataThrottled`,
  `transcriptionSegment`, `transcriptionStateChanged` and
  `agentStateChanged`; `ParticipantEvent` gains `e2eeStateChanged`,
  `metadataChanged` and `agentStateChanged`;
  `TrackSource` and `TrackKind` gain `screenShareAudio`. End exhaustive
  switches over these enums with `@unknown default:`. A future case then
  produces a compiler warning instead of a build error. Swift Package
  Manager builds the SDK from source, without library evolution, so Swift
  cannot make new cases fully non-breaking on its own. The enums' doc
  comments and the README now say this.

### Added

- Initial native Swift SDK (Phase 5) for iOS 15+ and macOS 12+: `Room`,
  `LocalParticipant` / `RemoteParticipant`, `LocalTrack` / `RemoteTrack`,
  with event names matching the web SDK's `RoomEventMap`. Speaks
  `docs/rtc/signaling.md` directly over one PeerConnection to the SFU.
  - Camera and microphone with simulcast, adaptive stream and paused video
    (layer `off`), active speakers, connection quality, subscription state.
  - Session resume, token refresh, server mute, removal and permission
    changes; `DisconnectReason` adds `tokenRevoked` and `replaced`.
  - `CallKitManager` (iOS) and `AudioSessionConfigurator`.
  - In-app screen share (ReplayKit) and a Broadcast Upload Extension
    template for whole-device sharing.
- End-to-end encryption (Phase 5 §3) via LiveKit's WebRTC build
  (`LiveKitWebRTC`, pinned exactly), which ships `RTCFrameCryptor`.
  `RoomOptions.e2eeKeyProvider`, shared-passphrase and per-participant key
  modes, key ratcheting, and the `e2eeStateChanged` event. The key schedule
  (`LivqenoRatchet` salt, HKDF) and frame format match the web, Flutter and
  Android SDKs, checked against `docs/architecture/e2ee-vectors.json`.
- Data messages v2 (Phase 7 §1): `sendData(_:options:)` with
  `DataPublishOptions` (`topic`, `destinationIdentities`, `reliable`), the
  lossy `raven-data-lossy` channel (1,200 bytes), SFU-attested sender on
  `dataReceived`, the `dataMessageReceived` and `dataThrottled` events and
  `room.supportsDataV2`. Without options, against an older server, the bytes
  sent are unchanged. A broken size limit throws `.invalidArgument`, the
  same code as every other platform.
- Participant metadata and attributes (Phase 7 §2): `participant.metadata`,
  `participant.attributes`, `setMetadata` / `setAttributes` (needs
  `perms.updateOwnMetadata`) and the `participantMetadataChanged` /
  `metadataChanged` events.
- Screen-share audio (Phase 7 §3): the Broadcast Upload Extension publishes
  ReplayKit app audio as a `screenShareAudio` track. In-app screen share
  stays video only. Unpublishing the share also unpublishes its audio.
  Remote `screenShareAudio` tracks are never counted as active speakers.
- Live transcription and AI voice agents (Phase 6 §8): the
  `transcriptionSegment(TranscriptionSegment)`,
  `transcriptionStateChanged(TranscriptionState)` and
  `agentStateChanged(participant:state:)` room events, `participant.isAgent`
  (`agent-` identities), `participant.isTranscriber` (`transcriber-`) and
  `participant.agentState`. A final segment with empty `text` is delivered
  as is, so a caption UI clears the interim. An `agent.state` that arrives
  before its agent joins is emitted when it joins. `agentStateChanged` fires
  only when the state changes.
