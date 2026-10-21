# Instrumented tests

These need libwebrtc's native library, so they only run on a device or
emulator:

```bash
./gradlew :swalvo-rtc:connectedDebugAndroidTest
```

They are **not** part of `testDebugUnitTest` and have not been run in CI.

| Test | What it proves |
|---|---|
| `NativeE2eeKeyProviderTest` | webrtc-sdk's native key provider (HKDF, salt `LivqenoRatchet`) ratchets key material exactly like the pure-Kotlin schedule in `docs/architecture/e2ee-vectors.json`. |
| `PeerConnectionEngineLoopbackTest` | Against a local PeerConnection playing the SFU: the engine answers `a=setup:active`, sends `track.publish` before its own offer, and the offer carries the declared track id. |
