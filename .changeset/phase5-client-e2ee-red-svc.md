---
"@swalvo/rtc": minor
"@swalvo/react": minor
"@swalvo/react-native": minor
---

End-to-end encryption, audio RED and VP9/AV1 SVC (Phase 5).

- **E2EE** (`@swalvo/rtc`): `createRTCClient({ e2ee: { keyProvider } })` with `createSharedKeyProvider(passphrase)` or `createKeyProvider()` (`setKey(participantId, key, keyIndex)`, `ratchetKey()`, `ratchetWindow`). Frames are encrypted in a Worker via `RTCRtpScriptTransform`, or Chrome's encoded insertable streams, in the cross-platform format of phase5-contracts §3 (AES-GCM-128, LiveKit/libwebrtc-compatible; vectors in `docs/architecture/e2ee-vectors.json`). New `e2eeStateChanged(participant, state)` event, `room.isE2EE` / `room.isE2EEActive`, `isE2EESupported()`, and error codes `E2EE_REQUIRED` (publishing into an E2EE room without a key provider is refused before capture) and `E2EE_NOT_SUPPORTED`. The worker is tree-shaken out of apps that never call a key provider factory, and is also shipped as `@swalvo/rtc/e2ee-worker` for strict CSPs.
- **RED**: `audioRed` (default true) offers `audio/red` first on the microphone. Off while E2EE is configured.
- **Codecs / SVC**: `videoCodec: 'vp8' | 'h264' | 'vp9' | 'av1'`. VP9 and AV1 publish one `L3T3_KEY` SVC encoding (`simulcastStatus` reports `'svc'`), falling back to VP8 simulcast where unsupported. `preferredVideoCodec` is now an alias of `videoCodec`.
- **React** (`@swalvo/react`): `useE2EEState(participant)`; `e2ee`, `audioRed` and `videoCodec` pass through `<SwalvoRoom>`; key provider factories re-exported.
- **React Native** (`@swalvo/react-native`): react-native-webrtc has no frame cryptor, so joining an E2EE room fails with `E2EE_NOT_SUPPORTED` (checked from the token before any prompt, and from `room.joined`). `audioRed` and `videoCodec` (`'vp8' | 'h264'`) pass through.
