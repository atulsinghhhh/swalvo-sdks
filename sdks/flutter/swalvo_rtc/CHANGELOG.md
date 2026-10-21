## Unreleased

- Data channels open only when the token grants `publishData`. Against a `data.v2` server the engine opened both channels at join; opening one is an offer, which the API refuses for a participant without publish or publishData (every live-stream viewer), failing the connection with `PERMISSION_DENIED`. A data stream listener without the grant no longer opens a channel, `sendData()` rejects with `permissionDenied`, and the channels open if the grant arrives mid-session.

* **Renamed from `raven_rtc` to `swalvo_rtc`** (Raven/Livqeno is now
  Swalvo). Change the dependency to `swalvo_rtc` and the import to
  `package:swalvo_rtc/swalvo_rtc.dart`. Every public `Raven*` type is now
  `Swalvo*` (`RavenRoom` →
  `SwalvoRoom`, …); the old names remain as deprecated
  typedefs until 1.0, so existing code compiles with deprecation warnings
  only. Wire contracts are unchanged: `RAVEN_*` error code strings,
  data-channel labels and protocol ids, and E2EE key-derivation labels
  stay as they were, so this release interoperates with every server and
  every client built on `raven_rtc`.

* **New:** live captions and AI voice agents (phase6-contracts §4, §8).
  `room.transcriptionSegments` (`RavenTranscriptionSegment`: interim
  segments share `segmentId`, `isFinal` closes one, an empty final clears
  a withdrawn interim), `room.transcriptionStateChanges`
  (`RavenTranscriptionState`, `RavenTranscriptionStatus`),
  `room.agentStateChanges` (`RavenAgentStateChanged`, `RavenAgentState`;
  a state that arrives before the agent joins is reported when it joins).
  `RavenParticipant.isAgent` (`agent-` identities), `isTranscriber`
  (`transcriber-`) and `agentState`.
* **New:** data messages v2 (phase7-contracts §1). `room.sendData(payload,
  {topic, destinationIdentities, reliable})`, a lossy channel
  (`raven-data-lossy`, `reliable: false`, 1,200 bytes), `room.dataMessages`
  (`RavenDataMessage` with the SFU-attested sender, null for the server, and
  the topic), `room.dataThrottled`, `room.supportsDataV2`. Without options
  against a server lacking `data.v2` the bytes sent are unchanged. Codec
  checked against `docs/architecture/data-envelope-vectors.json`.
* **New:** participant metadata and attributes (phase7-contracts §2).
  `RavenParticipant.metadata` is now live and `attributes` is new; token
  claims `md`/`attrs` seed the local participant. `room.setMetadata()`,
  `room.setAttributes()` (need `perms.updateOwnMetadata`,
  `RavenGrants.updateOwnMetadata`), `room.participantMetadataChanges`.
* **New:** `RavenTrackKind.screenShareAudio` and
  `enableScreenShare(audio: true)` (Flutter Web; native capturers return no
  audio, so mobile shares stay video only). `disableScreenShare()` stops both.
* **New:** `RavenErrorCode.invalidArgument` for broken size limits.

* **New:** end-to-end encryption. `Raven(e2ee: RavenE2EEOptions(...))` with
  `RavenKeyProvider.sharedPassphrase(passphrase)` or
  `RavenKeyProvider.perParticipant()` (`setKey`, `ratchetKey`,
  `ratchetWindow`). Uses flutter_webrtc's native `FrameCryptor` with
  `ratchetSalt: "LivqenoRatchet"` and HKDF key derivation, so it
  interoperates with the web SDK (phase5-contracts §3; checked against
  `docs/architecture/e2ee-vectors.json`). `RavenRoom.e2eeStateChanges`,
  `isE2EE`, `isE2EEActive`; error codes `e2eeRequired` (publishing into an
  E2EE room without a key provider) and `e2eeNotSupported` (Flutter Web).
* **New:** `audioRed` (default true) offers Opus RED first; off while E2EE
  is configured.
* **New:** `videoCodec: RavenVideoCodec.vp8 | h264 | vp9 | av1`. VP9/AV1
  publish one `L3T3_KEY` SVC encoding (`RavenSimulcastStatus.svc`), falling
  back to VP8 simulcast where the platform lacks the codec.
* Adds a dependency on `package:crypto` (PBKDF2/HKDF for the passphrase).
* **New:** session resume. A reconnect offers the server's latest resume
  token; when the server keeps the session (`JoinedPayload.resumed`) the
  peer connection is kept and media never stops. Otherwise the connection
  is rebuilt as before, and local tracks are now republished onto it
  (previously a reconnect silently dropped this device's publications).
* **New:** live token refresh. With `refreshToken` set, the SDK answers the
  server's `token.expiring` by handing the live session a new token, with
  no reconnect. Failures surface on `RavenRoom.warnings`, not as errors.
* **New:** close codes. `1012` reconnects within two seconds with resume,
  `4003` never reconnects, `4001` refreshes then reconnects (or fails with
  `tokenExpired` when there is no `refreshToken`).
  `RavenRoom.disconnectReason` says why a room ended.
* **New:** a peer connection that fails while signaling is up triggers a
  rejoin with a fresh connection (bounded, with backoff).
* **New:** `RavenRoom.grants` / `grantChanges` for live permission
  changes (withdrawn publish rights stop those tracks without an error),
  `localTracksMutedByServer`, and `handleNetworkChange()` for a
  connectivity listener to call.
* **Fix:** a first join that fails no longer keeps reconnecting in the
  background.
* **New:** active speakers (phase2-media-contracts §2).
  `RavenParticipant.isSpeaking` / `audioLevel`, `RavenRoom.activeSpeakers`,
  `activeSpeakerChanges` and `speakingChanges` (transitions only).
* **New:** connection quality from the SFU (§3).
  `RavenParticipant.connectionQuality`, `RavenRoom.connectionQuality` (this
  device; `lost` while the media connection has failed) and
  `connectionQualityChanges`.
* **New:** subscription state (§4). `RavenRenderableTrack.subscriptionState`
  (`active` / `pausedBandwidth` / `pausedClient`) and `layer`, plus
  `RavenRoom.subscriptionStateChanges`.
* **New:** client pause. `RavenRoom.setVideoEnabled(participant, kind, bool)`
  sends layer `off`, outranking pins and adaptive streaming.
  `RavenVideoView(visible: …)` — and a zero-sized view, or the last view of a
  track being disposed — pauses that video after 500 ms with adaptive
  streaming on, and resumes it immediately. Flutter has no intersection
  observer of its own, so "on screen" is the app's to say.
* **New:** `Raven(autoSubscribe: false)` joins with remote video paused until
  something asks for it (sent as `"autoSubscribe": false` on `room.join`).
* **Changed:** `dynacast` now does something. With it on (the default) the
  SDK honours `publisher.layers` (§5) by setting each simulcast encoding's
  `active` flag through `RTCRtpSender.setParameters`, serialized per sender
  and re-applied after every negotiation. flutter_webrtc's native sender
  exposes only the parameters it was created with plus our own updates (no
  live `getParameters`), which is sufficient because nothing else changes
  `active`; a refused `setParameters` is rolled back and retried on the next
  round.

## 0.3.0

* **Breaking:** removed the Livqeno Effects configuration layer —
  `RavenEffectsPipeline`, `RavenEffectFilters`, `RavenEffectPresets`,
  `RavenEffectBeauty`, `RavenEffectInstance`, `RavenEffectParamSpec`,
  `RavenFilterConfig`, `RavenPreset`, `RavenEffectsException`,
  `RavenEffectsErrorCode`, `RavenEffectsEngineStatus` and
  `ravenEffectsNativeEngineStatus`. The Effects product (camera filters
  and presets) has been discontinued across every Livqeno SDK. On Flutter
  it never processed video — the native engine was always `planned` — so
  removing it changes no call, track or rendering behavior. Delete any
  imports of these symbols; nothing replaces them.
* **Fix:** turning the camera off and on again during a call now reaches
  everyone else in the room. A re-enabled camera used to revive its old
  simulcast transceiver, so the media server never saw a new track and
  other participants silently stopped receiving that camera. The old
  transceiver is now stopped on unpublish and the camera gets a fresh one.

## 0.2.2

* **Fixed:** every other participant in a room hit an unhandled `Bad
  state: Cannot add new events after calling close` the instant the host
  ended a broadcast — one exception per participant still connected,
  every time.

  `_scheduleReconnect()` only checked whether the client had been closed
  at the moment `_onClosed` decided to start reconnecting, not at any of
  its own suspension points. When the app tore the client down
  (`dispose()`) while a reconnect attempt was parked mid-`await` —
  refreshing the token, or waiting out the backoff — `close()`'s
  `_reconnectTimer?.cancel()` had nothing to cancel yet, so the chain
  resumed after dispose anyway and tried to add a lifecycle event to a
  `StreamController` that `dispose()` had already closed.

  `_scheduleReconnect` now re-checks before every resumption: on entry,
  after the token-refresh `await`, and inside the retry timer's callback
  before reopening a socket. Same bug on 0.1.5 through 0.2.1 — the
  reconnect logic is unchanged across those versions.

  **Validated:** a unit test reproduces the exact race — `dispose()`
  arriving while a reconnect is parked awaiting a token refresh — against
  a fake socket, and confirmed it throws the reported exception when the
  fix is reverted.
  **Not yet validated:** the failure on a physical device against a real
  room teardown. This was diagnosed and fixed from the reported stack
  trace and a controlled reproduction, not by re-running the original
  broadcast-end scenario end-to-end.

## 0.2.1

* **Fixed:** an Android client could allocate a TURN relay, never send a
  CreatePermission for the server's address, never send a relay
  connectivity check, and sit in `checking` until the SFU gave up on it
  around thirty seconds later. Because it depended on which message won a
  race it looked intermittent, and so it read like a network problem.

  It was not. Remote ICE candidates were being discarded: the engine
  returned early when no peer connection existed yet, and wrapped
  `addCandidate` in a bare `catch`. `addCandidate` is illegal until a
  remote description has been applied, and the SFU trickles its candidates
  as soon as it has them — routinely before its offer has been processed.
  A client left holding no remote candidate has no peer to permit and
  nothing to check toward, which is exactly the shape the server-side
  investigation kept finding.

  Candidates that cannot be applied yet are now held — bounded, oldest
  dropped past 128 — and drained after every `setRemoteDescription`, on
  both the offer and the answer path, so neither ordering loses what the
  other would have applied. Device logs show why it mattered: every run
  buffers three candidates. The race was happening on every connection;
  the old code simply got lucky about half the time. Measured on Android
  against the published 0.2.0, same device and network, alternating: five
  of ten host connections succeeded before, ten of ten after.

* **Added:** a bounded stall watchdog. A connection still short of
  `connected` after twelve seconds — comfortably inside the SFU's own
  thirty-second deadline — gets exactly one ICE restart. Single-flight,
  one attempt per connection, and skipped outright if a negotiation is
  already in flight, so it cannot produce a duplicate publisher, a second
  peer connection, or a retry loop. It reuses the existing offer path, so
  published tracks stay on their transceivers. In practice it did not need
  to fire in any of the ten runs above; it is there for the connection
  that would otherwise wait for the server to end it.

* **Changed:** ICE diagnostics now go through `debugPrint`, so they reach
  `logcat` on a device. Candidates are logged by shape only —
  `relay/udp`, `srflx/udp` — never their address, because an ICE candidate
  line carries the connection's ufrag.

**Not yet validated:** repeated viewer-side sessions, physical devices,
network transitions, and the ICE restart path on a device. The host path
is well covered; the viewer path rests on a single clean end-to-end
session. See `flutter_check/android_ice` for the harness.

## 0.2.0

Simulcast now actually works. It never had.

* **Fixed (the big one):** `RavenEngine.publish()` called
  `pc.addTrack()` and then tried to attach a three-layer ladder with
  `sender.setParameters()`. That cannot work — the WebRTC specification
  requires implementations to reject a change to a sender's *number* of
  encodings, and RIDs only reach the SDP when they were present before the
  offer was generated. The error was caught by a bare `catch (_)` and
  discarded, so every published camera sent a single full-resolution layer
  while the SDK reported success. Subscribers had no cheaper layer to drop
  to, which is what made a call past four or five participants cost every
  device the full bitrate of every other device.

  A camera is now published through `pc.addTransceiver()` with
  `sendEncodings` declared at creation, which is the only point a ladder can
  be declared. The generated offer carries `a=simulcast:send low;medium;high`
  and three `a=rid:` lines, and the SFU answers `a=simulcast:recv`.

* **Fixed:** an explicit `room.requestLayer(...)` was silently dropped
  whenever `adaptiveStream` was false — the one combination that means "I
  will manage quality myself". It now always works; `adaptiveStream` gates
  only automatic requests.

* **Added:** `RavenSimulcastStatus` and `RavenRoom.simulcastStatusFor(kind)`.
  Read back from the negotiated sender, never from what was requested. A
  platform that refuses the ladder reports `unsupported` and logs a warning
  rather than failing silently, and still publishes a single layer.

* **Changed:** an explicit `requestLayer` now *pins* a track — adaptive
  streaming will not move it afterwards. Pass `'auto'` to release the pin.
  Previously a manual choice was undone by the next layout pass. The
  signature is unchanged; it still takes the layer as a `String`.

* **Changed:** `RavenVideoView`'s adaptive layer selection gained hysteresis
  and a 250 ms debounce. A grid that lands tiles on a threshold used to flip
  them between layers on every small nudge, and each flip costs a real layer
  switch — the SFU waits for a keyframe and the tile stutters.

* **Changed:** republishing a camera reuses its transceiver. Without that,
  every `disableCamera()`/`enableCamera()` cycle added an m-section that
  never went away.

* **Fixed:** a tile stayed on its placeholder after the camera it shows
  was enabled, and would only correct itself when some unrelated event
  happened to rebuild the tree. Two things had to line up. `RavenRoom`
  notifies its listeners *synchronously*, before the microtask that
  delivers the new roster on `participantChanges` runs, so
  `RavenVideoView`'s own listener re-resolved against a
  `widget.participant` that was still the snapshot from before the
  publish — and found nothing. The rebuild that followed carried the
  right snapshot, but `didUpdateWidget` skipped re-resolving because
  `RavenParticipant` compares by identity alone: two snapshots of the
  same person are `==` however different what they are publishing is.

  `RavenVideoView` now reads the participant back from the room by
  identity rather than trusting the snapshot it was handed, and
  re-resolves on every rebuild. The workaround that was circulating —
  keying the view on `isCameraEnabled`/`isScreenSharing` — is no longer
  needed, and harmless if you keep it. This affected remote tiles as well
  as local ones, and the layer request adaptive streaming makes on a
  tile's behalf, which was being dropped for the same reason.

* **Added:** `RavenRoom.mediaState` and `RavenRoom.mediaStateChanges`,
  reporting a new `RavenMediaState` read from the peer connection itself.

  `RavenConnectionState` is, and has always been, the *signaling*
  connection: it reads `connected` the moment the server accepts the
  join, whatever the media transport is doing. A network that permits
  outbound TLS but drops UDP therefore produced a room that joined
  cleanly, listed its participants, relayed chat, and never carried a
  frame — while every observable the SDK offered said `connected`. There
  was no way to tell that apart from "nobody has published yet" without
  reading `flutter_webrtc`'s logs. `mediaState` answers that question
  directly: `idle`, `connecting`, `connected`, `interrupted`, `failed`,
  `closed`. `RavenConnectionState`'s own documentation now says plainly
  what it does and does not cover.

## 0.1.8

Fixes the local self-preview tile staying on its placeholder while the
remote peer's tile rendered fine, found via the same external-developer
re-test as 0.1.6/0.1.7.

* **Fixed:** `enableCamera()`/`enableMicrophone()`/`enableScreenShare()`
  only told the UI about a newly published local track after
  `RavenEngine.publish()` fully resolved — which waits on a complete SFU
  offer/answer round trip. The local `MediaStream` is actually available
  and ready to render much earlier, right after `getUserMedia()`
  returns, but nothing notified listeners until negotiation finished. A
  remote track has no equivalent avoidable delay, so this asymmetry
  showed up exactly as reported: the local tile appearing stuck while
  the remote tile updated immediately. `RavenEngine.publish()` now
  notifies as soon as the local track is captured, independent of the
  negotiation round trip that follows.

## 0.1.7

Fixes a console warning logged on every single `enableCamera()`/
`enableMicrophone()` call on web, found via the same external-developer
re-test as 0.1.6.

* **Fixed:** `_cameraConstraints` passed `facingMode: 'user'`
  unconditionally, including on web. `flutter_webrtc`'s web
  `getUserMedia` shim only keeps `facingMode` for a mobile-browser user
  agent — desktop Chrome, including headless Chromium, never matches, so
  the shim stripped it and logged `[getUserMedia] failed to remove
  facingMode from mediaConstraints` on every call. `facingMode` is now
  omitted on web; mobile camera switching is unaffected, since it goes
  through `Room.switchCamera()` rather than this constraint.

## 0.1.6

Fixes `RavenRoom.participantChanges` silently missing the current roster
for a listener attached after `Raven.join()` returns, found via an
external-developer re-test of the published package against a real
backend and SFU — specifically, a viewer joining a live stream already
in progress.

* **Fixed:** `participantChanges` was a plain broadcast stream fed by
  `_emitParticipants()`, whose first call happens synchronously while
  `join()` itself is still resolving — applying the server's initial
  roster before any caller's code can possibly have attached a
  listener yet, since the `RavenRoom` (and so this getter) doesn't
  exist any earlier. A late listener on a broadcast stream simply never
  sees an event that already fired, so an app that builds its initial
  UI from this stream (rather than reading `participants`/
  `remoteParticipants` directly first) saw an empty roster until the
  *next* change — which, for a viewer joining a room where someone was
  already publishing, could be never. `participants` and
  `remoteParticipants` were never affected; they read current state
  directly. `participantChanges` now replays the current roster to
  each new listener the instant it subscribes, via `Stream.multi`. No
  public API changes — same getter, same event shape, now correct for
  every subscriber regardless of when it attaches.
* Added regression coverage (`test/room_test.dart`) proving a listener
  attached well after the initial join still receives the roster that
  was already there.

## 0.1.5

Fixes a data channel that could silently never open, found via a real
Flutter-to-Flutter and Flutter-to-browser end-to-end sweep against a real
backend and SFU. No public API changes.

* **Fixed:** `RavenEngine.ensureDataChannel()` created the local data
  channel but never negotiated it — unlike `publish()`/`unpublish()`,
  nothing else was ever going to prompt an offer for a participant who
  only wants `data`. A channel opened this way either rode along behind
  some unrelated publish's negotiation round, or, for a participant that
  never published anything, never opened at all: `RavenRoom.data`'s
  listener calls `ensureDataChannel()` exactly this way (spec §8), so a
  receive-only participant could not send *or* receive data.
  `ensureDataChannel()` now awaits the same join-time barrier `publish()`
  does and negotiates through the same guarded path, so the channel it
  creates is always the one actually offered to the SFU.
* Added regression coverage (`test/engine_test.dart`) proving
  `ensureDataChannel()` negotiates on its own, with no publish required.

## 0.1.4

Fixes a join-time negotiation race that could leave the SFU's very first
offer permanently unanswered, found via a real end-to-end sweep against a
real backend, SFU and browser. No public API changes.

* **Fixed:** `SignalingClient.send()` refused to send anything but
  `room.join` until the server's `room.joined` confirmation arrived,
  gating on `_joined`. The SFU's join-time offer reaches the client over
  a path with no ordering relationship to that confirmation — it travels
  node-link → gateway → socket independently of the join handler's own
  response — and the SFU builds and sends that offer synchronously, with
  no I/O in between, so it frequently wins the race. When it did, the
  client answered it correctly but `send()` silently dropped the answer,
  and the SFU waited out its full 15s `answerTimeout` for an answer that
  was never coming. `send()` now gates on a new `_joinSent` flag that
  flips the instant `room.join` is dispatched, so an answer or ICE
  candidate produced while a join is still in flight is no longer
  discarded.
* Added regression coverage (`test/signaling_client_test.dart`) pinning
  this exact race: an SFU offer arriving and being answered before
  `room.joined` has arrived.
* Verified via a real end-to-end sweep — a real Flutter Web build joining
  a real live stream through a real local SFU, with a real browser
  viewer's raw `RTCPeerConnection.getStats()` confirming `framesDecoded`
  and `bytesReceived` genuinely increasing — at 20/20 with zero dropped
  answers and zero negotiation timeouts.

## 0.1.3

Fixes a negotiation-glare bug that could leave a locally "published"
track never actually negotiated with the SFU, found via a real
end-to-end run against a real backend, SFU and browser. No public API
changes.

* **Fixed:** the SFU is the impolite peer in a glare (both sides
  offering at once) by design: it refuses the client's offer with a
  retryable `NEGOTIATION_GLARE` and expects the client to answer its
  own offer, then retry. `RavenEngine` received that error and simply
  discarded it — no rollback, no retry — so a track added right as the
  SFU's join-time offer arrived could sit on the peer connection with
  `track.publish` declared but never actually negotiated. Every other
  participant then saw that source as not published
  (`camera=false`/`microphone=false`) even though `enableCamera()` /
  `enableMicrophone()` reported success. `_handleOffer` now rolls the
  local offer back before accepting a colliding SFU offer, and a
  glared publish is requeued and retried once that round completes.
* **Fixed:** the retry itself could stay queued forever. It decided
  whether to negotiate by reading `RTCPeerConnection.signalingState`,
  which flutter_webrtc only updates from an asynchronous platform
  event; read immediately after our own rollback-and-answer (exactly
  where the retry needs to fire), it could still report the
  pre-answer state on Flutter Web. It now asks the platform directly
  (`getSignalingState()`) instead of trusting that cache.
* Every operation that can change the peer connection's signaling
  state (an incoming SFU offer, an incoming SFU answer, a local
  publish) is now serialized through one queue, so two of them can no
  longer interleave against a signaling state the other has since
  moved past.
* Added regression coverage (`test/engine_test.dart`) for glare
  recovery specifically: a colliding SFU offer rolling ours back, a
  glared publish surviving instead of being dropped, a publish
  deferred behind our own offer retrying once that offer is answered
  (not only once the SFU offers again), and the full
  publish → glare → rollback → retry → accepted sequence end to end.
* Verified via repeated real end-to-end runs — a real Flutter Web
  build publishing camera and microphone to a real live stream through
  a real local SFU, with a real browser subscriber's raw
  `RTCPeerConnection.getStats()` confirming `framesDecoded` and
  `bytesReceived` actually increase — including runs where the glare
  condition fired live and recovered correctly.
* **Known issue, not fixed here:** a separate, rarer race was found
  during this verification, unrelated to glare: a viewer joining right
  as a Flutter host's negotiation completes can occasionally time out
  waiting to subscribe. It traces to the SFU only subscribing a new
  participant to tracks it already considers published at join time,
  combined with this SDK's `ready`/publish-success signals meaning the
  local offer was sent, not that the SFU has accepted it yet. Fixing
  it would mean changing the SFU or the readiness contract; out of
  scope for this release.

## 0.1.2

Fixes `Raven.join()` rejecting rooms identified by name, found via a
real end-to-end check of `raven_live` against a real backend and SFU.
No public API changes.

* **Fixed:** `Raven.join(roomId)` only ever validated `roomId` against
  the RTC token's internal room id (`rid`), and then sent `roomId` —
  whatever the caller passed — verbatim on the wire. A token also
  carries the room's human name (`rnm`), and a caller who legitimately
  knows the room only by that name (a live stream's public id, which is
  what its underlying room's `name` is set to server-side) got rejected
  outright with `RavenErrorCode.roomNotFound`, or, once the local check
  was widened to accept either claim, still got rejected server-side:
  the signaling layer names a room by `rid` alone, and this SDK was
  sending its own `roomId` argument on the wire instead of the token's.
  `join()` now accepts a match against either claim, and the wire value
  is always the token's own `rid` — matching the web SDK's
  `assertTokenMatchesRoom`/`roomIdFromToken` exactly. A token naming no
  room at all now fails fast with `RavenErrorCode.invalidToken` instead
  of silently sending nothing meaningful.
* Added regression coverage (`test/raven_test.dart`) for the precheck
  accepting either claim, rejecting neither, and the no-room-claim
  failure mode.
* Verified via a genuine end-to-end run: a real Flutter Web build
  publishing camera and microphone to a real live stream through a real
  local SFU, with a real browser subscriber observing `framesDecoded`
  and `bytesReceived` actually increase over a sustained window — and
  the reverse direction, a real browser host with a real Flutter Web
  viewer subscribing to it. See `apps/api/test/flutter-live-streaming.e2e-spec.ts`
  and `flutter_check/live_host`.

## 0.1.1

Fixes a signaling/negotiation lifecycle bug that could prevent remote
media from ever arriving. No public API changes.

* **Fixed:** `RavenEngine` and `RavenRoom` now subscribe to signaling
  *before* `SignalingClient.connect()` is called, not after it resolves.
  Previously, `RavenRoom.attach()` and `RavenEngine.start()` ran only
  once the join had already completed, which left a window for the
  server's own messages — an `sdp.offer` most of all — to arrive on a
  broadcast stream with no subscriber yet and be silently dropped, with
  no `sdp.answer` ever sent back. Subscribing first closes that window
  unconditionally, matching how the web SDK registers its signaling
  listeners before awaiting `connect()`.
* **Fixed:** `RavenEngine.applyJoinedState()` — which restores announced
  tracks and reconciles the roster — was never called on the *first*
  join, only on reconnects. `RavenRoom._handleJoined()` now runs the same
  path both times.
* **Fixed:** `sendData()` could send into a data channel that had not
  finished opening. It now waits for the channel to open before sending;
  nothing sent while it's still coming up is dropped.
* **Fixed:** a participant that only listens for `RavenRoom.data` and
  never publishes or calls `sendData()` now still gets a local data
  channel opened (`RavenEngine.ensureDataChannel()`), so the SFU has
  somewhere to relay incoming data onto. Previously such a participant
  could not receive data either, only send it.
* Added unit-level regression coverage for all of the above
  (`test/engine_test.dart`, `test/room_test.dart`) against a mocked
  `flutter_webrtc` platform channel. Live end-to-end media validation
  against a real SFU and real devices should still be run before
  depending on this release for production calls — see
  `docs/sdk/flutter.md`.

## 0.1.0

Initial release (Livqeno Phase 13).

* `Raven` / `RavenRoom` — join, leave, camera, microphone, screen share,
  front/rear camera switch.
* `RavenVideoView` — renders a participant, follows track changes, and
  disposes its native texture with the widget.
* `RavenPermissions` — camera and microphone prompts without an extra
  plugin.
* Typed errors (`RavenException`, `RavenPermissionException`) sharing the
  web SDK's vocabulary.
* Adaptive streaming and dynacast on by default, which the web SDK leaves
  off — a phone pays for resolution it isn't showing.
