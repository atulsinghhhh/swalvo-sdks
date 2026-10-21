# Changelog

All notable changes to Swalvo RTC for Android (`:swalvo-rtc`, formerly
Livqeno RTC / `:livqeno-rtc`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Data channels open only when the token grants `publishData`. Against a `data.v2` server the SDK opened both channels at join; opening one is an offer, which the API refuses for a participant without publish or publishData (every live-stream viewer), failing the connection with `PERMISSION_DENIED`. A data stream listener without the grant no longer opens a channel, `sendData()` rejects with a permission-denied error, and the channels open if the grant arrives mid-session.

### Changed

- Renamed to Swalvo: Gradle module `:livqeno-rtc` is now `:swalvo-rtc`
  (coordinates `io.swalvo:swalvo-rtc`), package/namespace `io.livqeno.rtc`
  is now `io.swalvo.rtc`. `RavenClient` / `RavenClientOptions` are now
  `SwalvoClient` / `SwalvoClientOptions`, and `LivqenoCallService`,
  `LivqenoConnectionService`, `LivqenoConnection` and `LivqenoCallManager`
  are now `Swalvo*`; the old names remain as deprecated typealiases.
  Manifest entries must name the new service classes. Intent extras are now
  `io.swalvo.rtc.*` and the log tag is `SwalvoRTC`. The notification channel
  id (`livqeno_calls`), data channel labels (`raven-data`,
  `raven-data-lossy`, protocol `raven.v2`) and E2EE key-derivation labels
  (`LivqenoE2EE:`, `LivqenoRatchet`) are unchanged.

### Added

- Live transcription and AI voice agents (phase6-contracts §8):
  `RoomEvent.TranscriptionSegment(segment)`,
  `RoomEvent.TranscriptionStateChanged(state)` and
  `RoomEvent.AgentStateChanged(participant, state)`, with the
  `TranscriptionSegment`, `TranscriptionState` / `TranscriptionStatus` and
  `AgentState` types. `Participant.isAgent` and `Participant.isTranscriber`
  read the `agent-` / `transcriber-` identity prefixes, and
  `Participant.agentState` / `agentStateFlow` hold an agent's last state.
  An empty final segment is delivered as is so caption UIs clear the interim.
- Initial native Kotlin SDK (Phase 5), `minSdk 24`. It speaks
  `docs/rtc/signaling.md` with the same event names as the web, React
  Native and Flutter SDKs. Events arrive as a `Flow`.
  - Camera (Camera2) with simulcast, microphone, and MediaProjection screen
    share.
  - Session resume, token refresh, server mute, removal and permission
    changes.
  - Active speakers, connection quality, subscription state, dynacast
    (`publisher.layers`), and layer `off` for hidden videos.
  - Helpers: `AudioRouter`, the `LivqenoCallService` foreground service and
    a self-managed Telecom `LivqenoConnectionService` / `LivqenoCallManager`.
- End-to-end encryption (Phase 5 §3) via libwebrtc's `FrameCryptor`:
  `RavenClientOptions(e2ee = E2eeOptions(...))` with shared-passphrase or
  per-participant keys, and `RoomEvent.E2eeStateChanged`. The SDK refuses to
  publish into an E2EE room without E2EE configured (`E2EE_ERROR`). The key
  schedule (PBKDF2, then HKDF with the `LivqenoRatchet` salt) and frame
  format match the web SDK byte for byte, checked against
  `docs/architecture/e2ee-vectors.json`.
- Data messages v2 (Phase 7 §1): `sendData(payload, DataPublishOptions(...))`
  with `topic`, `destinationIdentities` and `reliable = false` (the lossy
  `raven-data-lossy` channel, 1,200 bytes), SFU-attested sender identity,
  and the `DataReceived` / data-throttled events. The codec is checked
  against `docs/architecture/data-envelope-vectors.json`.
- Participant metadata and attributes (Phase 7 §2), with
  `ParticipantMetadataChanged`. Needs `perms.updateOwnMetadata`.
- Screen-share audio (Phase 7 §3) on API 29+ through AudioPlaybackCapture
  (`ScreenShareOptions(captureAudio = true)`): its own
  `SCREEN_SHARE_AUDIO` track when the microphone is off, mixed into the
  microphone track when it is on.
- `RtcErrorCode.INVALID_ARGUMENT` for broken documented limits.

### Changed

- `sendData()` now throws `RtcException(INVALID_ARGUMENT)` for a payload
  over its size limit (64 KiB reliable, 1,200 bytes lossy), not
  `MEDIA_ERROR`. This matches every other platform. `MEDIA_ERROR` stays
  for real media failures.
- The SDK manifest now also merges in `CAMERA`, `RECORD_AUDIO` and
  `MANAGE_OWN_CALLS`. From targetSdk 34, Android requires each
  `foregroundServiceType` that `LivqenoCallService` declares (`camera`,
  `microphone`, `phoneCall`) to have these declared, or `startForeground()`
  throws `SecurityException`. `CAMERA` and `RECORD_AUDIO` are still runtime
  permissions that the app must request. `LivqenoCallManager.placeOutgoingCall`
  is annotated `@RequiresPermission(MANAGE_OWN_CALLS)`.
