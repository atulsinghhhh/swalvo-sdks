---
"@swalvo/rtc": minor
"@swalvo/react": minor
"@swalvo/react-native": minor
---

Call quality from the media server: active speakers, connection quality, paused video, dynacast, and a pre-call test.

- **Active speakers.** New `activeSpeakersChanged(speakers)` room event and `room.activeSpeakers` (loudest first, the local participant included), plus `participant.isSpeaking`, `participant.audioLevel` and a per-participant `isSpeakingChanged` event.
- **Connection quality.** New `connectionQualityChanged(participant, quality)` room event and `participant.connectionQuality`, scored by the SFU. `getConnectionStats().connectionQuality` now carries the server's score for this participant instead of always `'unknown'`.
- **Subscription state.** `RemoteTrack.subscriptionState` (`active` / `paused_bandwidth` / `paused_client`), `RemoteTrack.layer`, and the `trackSubscriptionStateChanged` room event.
- **Pausing video.** `RemoteTrack.setEnabled(false)` pauses a video at the SFU without unsubscribing; adaptive streaming now also pauses a video none of whose elements are visible (scrolled away, detached, zero size, background tab) after 500 ms and resumes it at once. `RemoteTrack.setVisible()` reports visibility for renderers the SDK cannot observe.
- **`autoSubscribe: false`** in `RTCClientConfig` (and `SwalvoConfig`) starts remote video paused until it is shown or enabled.
- **Dynacast.** The camera's simulcast encodings nobody is receiving are switched off on the server's `publisher.layers`, saving uplink and CPU.
- **Pre-call test.** `runConnectionTest()` checks camera, microphone, signaling, media and TURN over UDP/TCP/TLS, and measures RTT, jitter, loss and upload. In its own module, so it is tree-shaken when unused.
- **React**: `useActiveSpeakers`, `useIsSpeaking`, `useConnectionQuality`, `useTrackSubscriptionState`; `ParticipantView` gains `data-swalvo-speaking` / `data-swalvo-connection-quality` attributes, `speakingClassName` and `showConnectionQuality`.
- **React Native**: the same hooks (room passed in), `SwalvoVideoView` `visible` prop (zero size and unmount count as hidden), `adaptiveStream` / `autoSubscribe` in `SwalvoConfig`, and `runConnectionTest()`.

Against a server without these signals nothing changes: speakers stay empty, quality stays `'unknown'`, tracks stay `'active'`, and every layer keeps sending.
