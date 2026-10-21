---
"@swalvo/rtc": minor
"@swalvo/react-native": minor
---

**Behaviour change:** `room.sendData()` now rejects a payload over its size limit (64 KiB reliable, 1,200 bytes with `reliable: false`) with `RTCError` code `INVALID_ARGUMENT` instead of `MEDIA_ERROR`. This matches the topic / destination limits and the Flutter, iOS and Android SDKs, so the same `code` means the same thing on every platform. `MEDIA_ERROR` is now reserved for genuine media failures (capture, track negotiation), which are worth retrying; an oversized payload never was. If you branch on `error.code === 'MEDIA_ERROR'` around `sendData()`, check for `INVALID_ARGUMENT` as well (or instead). The error message is unchanged. React Native inherits this from `@swalvo/rtc`.
