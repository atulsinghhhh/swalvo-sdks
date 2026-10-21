---
"@swalvo/rtc": minor
"@swalvo/react-native": minor
---

Data messages v2, participant metadata and screen-share audio (Phase 7, docs/architecture/phase7-contracts.md).

- **Data messages** (`@swalvo/rtc`): `room.sendData(payload, { topic, destinationIdentities, reliable })`. `reliable: false` uses a new unordered, no-retransmit `raven-data-lossy` channel (≤1,200 bytes), falling back to reliable with one warning against a server without `data.v2`. `dataReceived(payload, participant, topic)` now names the sender (as the SFU saw it; `undefined` for server messages) and the topic. New `dataThrottled(channel)` event when the SFU rate-limits you. Against a `data.v2` server both channels open at join with RTCDataChannel protocol `raven.v2`, so the SFU frames deliveries with the sender and topic; otherwise channels stay lazy. Binary envelope pinned by `docs/architecture/data-envelope-vectors.json`. Without options, and against an older server, `sendData` sends exactly the same bytes as before. New error code `INVALID_ARGUMENT` (topic over 255 bytes, more than 64 destinations, metadata over the limits). Data messages are not end-to-end encrypted.
- **Metadata**: `participant.metadata` and `participant.attributes`, seeded from the token (`md`/`attrs`) and `room.joined`/`participant.joined`, updated by `participant.updated`. `localParticipant.setMetadata()` / `setAttributes()` (needs `perms.updateOwnMetadata`, else `PERMISSION_DENIED`). Events: room `participantMetadataChanged(participant, prev)` and participant `metadataChanged(prev)`. `permissions.updateOwnMetadata`.
- **Screen-share audio**: `room.enableScreenShare({ audio: true })` publishes the browser's display audio as a `screenShareAudio` track (new `TrackKind`); disabling the share, or the browser's "Stop sharing", unpublishes both.
- **React Native** (`@swalvo/react-native`): `useDataReceived(room, handler, { topic })` and `useParticipantMetadata(participant)` hooks; the new types are re-exported. Screen-share audio is unsupported (react-native-webrtc's `getDisplayMedia` has no audio track), so `{ audio: true }` shares video only.
