## 0.2.1

* **Renamed from `raven_live` to `swalvo_live`** (Raven/Livqeno is now
  Swalvo). Change the dependency to `swalvo_live` and the import to
  `package:swalvo_live/swalvo_live.dart`. Every public `Raven*` type is now
  `Swalvo*` (`RavenLiveStream` →
  `SwalvoLiveStream`, …); the old names remain as deprecated
  typedefs until 1.0, so existing code compiles with deprecation warnings
  only. Wire contracts are unchanged: `RAVEN_*` error code strings,
  data-channel labels and protocol ids, and E2EE key-derivation labels
  stay as they were, so this release interoperates with every server and
  every client built on `raven_live`.
  Depends on `swalvo_rtc` and `swalvo_chat` (`^0.2.0`). The extension
  `RavenLiveStreamRoleX` is now `SwalvoLiveStreamRoleX`; Dart has no
  extension aliases, so only an explicit `RavenLiveStreamRoleX(role)` call
  needs editing — `role.isHost` works unchanged.

* **Allows `raven_rtc` 0.3.x** (constraint widened to `>=0.2.0 <0.4.0`).
  `raven_rtc` 0.3.0 only removes the discontinued Effects configuration
  layer, which this package never used. Nothing in this package's own API
  changed.

## 0.2.0

* **Requires `raven_rtc` >= 0.2.0.** A live-stream viewer's tile for the
  host never rendered: it decoded the host's video for the whole stream
  and showed a placeholder over it. The defect and its fix are in
  `raven_rtc`'s `RavenVideoView`, but the constraint here was what
  decided whether an application could reach the fix at all — `^0.1.8`
  means `>=0.1.8 <0.2.0` to pub, so publishing the fix as 0.2.0 would
  have left every `raven_live` application on a version that cannot show
  a viewer anything. Nothing in this package's own API changed.

## 0.1.0

Initial release (Livqeno Phase 14).

* `RavenLiveStream.join()` — joins a stream's room and connects its chat,
  composing `raven_rtc` and `raven_chat` rather than reimplementing either.
* `role` / `isHost`, `room`, `chat`, `react()`, `leave()`.
* Typed credentials (`RavenLiveStreamCredentials.fromJson`) mirroring
  `@swalvo/live`'s `LiveStreamCredentials` field-for-field.
