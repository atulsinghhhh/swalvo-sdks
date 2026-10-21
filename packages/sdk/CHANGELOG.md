# @swalvo/rtc

## Unreleased

### Patch Changes

- Data channels now open only when the token grants `publishData`. Against a server with `data.v2`, every client opened both channels at join, and opening one is an offer: the API refuses offers from a participant that may neither publish nor publishData, so subscribe-only participants (every live-stream viewer) failed to connect with `PERMISSION_DENIED`. A `dataReceived` listener without the grant is remembered rather than opened, `sendData()` without it rejects with `PERMISSION_DENIED`, and the channels open if the server grants `publishData` mid-session.

### Major Changes

- Renamed from `@ravenkash/rtc` to `@swalvo/rtc` as part of the Raven/Livqeno → Swalvo rebrand. The internal `RavenAdapter` class is now `SwalvoAdapter` (old name kept as a deprecated alias), and console log lines are prefixed `[swalvo-rtc]` instead of `[raven-rtc]`. Wire protocol identifiers (`raven-rtc`, `raven-data`, `raven.v2`, `raven-preflight`), `RAVEN_*` error codes and E2EE KDF labels (`LivqenoE2EE:`, `LivqenoRatchet`) are unchanged.

## 0.5.0

### Minor Changes

- [`01ebb72`](https://github.com/atulsinghhhh/swalvo-sdks/commit/01ebb72c21f18ed79149bb357a2245853d81f9b7) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - Publish real simulcast, and make adaptiveStream real

  Simulcast had never once reached the wire. `applySimulcast()` called
  `pc.addTrack()` and then tried to attach a three-layer ladder with
  `sender.setParameters()`. That cannot work: the WebRTC specification
  requires implementations to reject a change to a sender's _number_ of
  encodings, and RIDs only appear in the SDP when they were present before
  the offer was generated, which `setParameters` is by definition too late
  for. The rejection went to `logger.debug` and nowhere else, so every
  published camera sent a single full-resolution layer while the SDK
  believed it was sending three.

  The consequence was paid by subscribers. With only one layer to forward,
  the SFU handed every subscriber the publisher's full-quality stream
  regardless of how small it was being rendered — which is what makes a six-
  or eight-person call cost every participant the full bitrate of every
  other participant.

  **A camera is now published through `pc.addTransceiver()` with
  `sendEncodings` declared at creation**, the only point at which a ladder
  can be declared. The offer carries `a=simulcast:send low;medium;high` and
  three `a=rid:` lines, and the SFU answers `a=simulcast:recv`. The comment
  claiming the SFU could not answer a client offer that adds m-sections was
  stale — `Participant.AcceptOffer` has always done a plain
  `SetRemoteDescription` + `CreateAnswer`, and rejects only on glare.

  **`adaptiveStream` is new, on by default, and does something.** Each
  subscribed video is kept on the smallest layer that still covers the
  element it is attached to, measured with a `ResizeObserver` from
  `RemoteTrack.attach()`. Thresholds (240 / 640 CSS pixels) and hysteresis
  match the Flutter SDK exactly, so a call does not render at different
  quality on a phone and a laptop for no discoverable reason. Set
  `adaptiveStream: false` to manage layers yourself.

  **`RemoteTrack.setLayer(layer)` is new**, and it _pins_: adaptive
  streaming will not move a track you have chosen a layer for. Pass
  `'auto'` to release the pin.

  **`Room.simulcastStatus(kind)` is new.** It reads the ladder back off the
  negotiated sender rather than reporting what was requested — the
  distinction the previous implementation could not make. A browser that
  refuses the ladder reports `'unsupported'`, logs a warning, and still
  publishes a single layer.

  Failures are no longer swallowed: a simulcast configuration that does not
  survive negotiation logs at `warn` and is reported through
  `Room.simulcastStatus()`.

## 0.4.0

### Minor Changes

- [#55](https://github.com/atulsinghhhh/swalvo-sdks/pull/55) [`501d552`](https://github.com/atulsinghhhh/swalvo-sdks/commit/501d5529f61b16d1eb461ecd8a59dc3095adf1b2) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - Serialize negotiation, restore media across reconnects, bootstrap the data channel, and support application-provided tracks

  Four RTC reliability fixes, all in the browser SDK. Found during the same
  isolated static-page test as the SFU's DTLS role fix, which is unchanged.

  **Publish negotiation was a check-then-act race.** `negotiatePublish()` read
  `signalingState` and then awaited `createOffer()`. The SFU's offer lands in
  that gap, and `setLocalDescription` throws `Called in wrong state:
have-remote-offer`; an answer to a superseded offer throws `Called in wrong
state: stable`. Either way the publish never negotiated — the sender
  existed, its m-section stayed `recvonly`, and the room saw no media while
  the SDK reported `camera published`.

  Every operation that touches the signaling state machine now runs on one
  chain: remote offers, remote answers, our own offers, remote candidates.
  Nothing else goes near `setLocalDescription` / `setRemoteDescription`.
  Offers are triggered by the browser's own `negotiationneeded` event rather
  than by an SDK-side flag, which matters more than it sounds: the browser's
  bit clears when _any_ description covers the change, including one the SFU
  offered, and a flag that cannot know that re-offers forever. Glare resolves
  politely — the SFU's offer wins, ours rolls back, and the browser decides
  whether a retry is warranted. A server-side `NEGOTIATION_GLARE` now waits
  for the SFU's offer as the SFU's own message instructs, instead of retrying
  straight into another refusal.

  One extra guard sits alongside the browser's bit: Livqeno's SFU identifies a
  published track by the id in the SDP `msid` and matches it to the
  `track.publish` declaration that says camera or screen share. A track can
  be sending on a transceiver whose m-section still announces an msid
  inherited from the SFU's offer, so the SDK offers once more to put its own
  ids on the wire, then stops asking and logs a warning if the browser will
  not. `setTimeout` is gone from the publish path entirely.

  **A reconnect left the room silent.** `published` mixed desired state with
  the `RTCRtpSender` of a connection that no longer existed, and nothing
  re-published onto the replacement — both transceivers came back `inactive`
  with no senders. Desired state and connection state are now separate:
  rejoining re-adds every live publication, re-declares its source to the new
  SFU session, re-creates the data channel if one was in use, and renegotiates
  once. A screen share whose capture ended during the outage is dropped
  instead, with `localTrackUnpublished`, because only the user can start a new
  one.

  **The data channel could not bootstrap itself.** `openDataChannel()` created
  a channel and negotiated nothing, so the first `sendData()` threw "The data
  channel is not open yet" unless a media publish happened to carry the
  channel along. Creating the channel now drives the renegotiation it needs,
  `sendData()` waits for the channel internally, and payloads sent meanwhile
  are queued and delivered in order — so `await room.join()` then
  `await room.sendData(payload)` works in an empty room with nothing
  published. A connection that dies first rejects with `CONNECTION_FAILED`
  rather than hanging. Receiving needed the same treatment: the SFU fans data
  out over each recipient's own channel, so listening for `dataReceived` now
  provisions one. Without that, a page that never sent could not receive.

  **Application-provided tracks have a way in.** `LocalTrack` and
  `LocalTrackDelegate` are public, so a hand-built track looked publishable
  and was refused. New `createCustomTrack(mediaStreamTrack, { source })`, also
  `client.createCustomTrack()`, wraps a track the application already has —
  `canvas.captureStream()`, a Web Audio graph, a decoded file, a virtual
  camera — in a real internal delegate. What `publish()` accepts is unchanged;
  its refusal now names the way through.

## 0.3.1

### Patch Changes

- [#48](https://github.com/atulsinghhhh/swalvo-sdks/pull/48) [`ee0f646`](https://github.com/atulsinghhhh/swalvo-sdks/commit/ee0f646721f247b7647fbf06ccaccf2c974084d9) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - Take a publication's id from the SDP, not from the local track

  `0.3.0` shipped the negotiation rework but not the correction that followed
  it, so `reconcilePublicationIds()` was missing: the code landed on `main`
  through [#46](https://github.com/atulsinghhhh/swalvo-sdks/issues/46) with no changeset of its own and would otherwise go out
  undescribed.

  Raven's SFU identifies a published track by the id in the SDP `msid`, and
  matches that to the `track.publish` declaration saying camera or screen
  share. A track can therefore be sending on a transceiver whose m-section
  still announces an msid inherited from the SFU's own offer — Chrome will
  not rewrite an id it did not author. When that happens the SFU falls back
  to inferring the source from the codec kind, which reads a screen share as
  a camera: the media arrives and plays, but a layout keyed on the announced
  source puts the shared window in the face tile.

  `reconcilePublicationIds()` reads the ids back off the answer and re-maps
  publications onto what is actually on the wire. It offers once more to put
  its own ids there, then stops and warns rather than standing in a loop,
  because a permanent re-offer condition is the same treadmill the
  negotiation rework removed.

  Publishing each track on a transceiver of its own would settle the
  ambiguity outright and is deliberately not done: this SFU does not answer
  a client offer that adds m-sections, so the publish would never complete.
  That needs an SFU-side change, and `rtc/screen-sharing.md` now records
  what it costs until then.

## 0.3.0

### Minor Changes

- [#43](https://github.com/atulsinghhhh/swalvo-sdks/pull/43) [`1fca552`](https://github.com/atulsinghhhh/swalvo-sdks/commit/1fca5522e8a977e5b311b0d3cb2f4ef79f3e1298) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - Serialize negotiation, restore media across reconnects, bootstrap the data channel, and support application-provided tracks

  Four RTC reliability fixes, all in the browser SDK's `RavenAdapter`. Found
  during an isolated static-page test alongside the SFU's DTLS role fix.

  **Publish negotiation was a check-then-act race.** `negotiatePublish()`
  read `signalingState`, then awaited `createOffer()`. The SFU's offer lands
  in that gap, and `setLocalDescription` then throws `Called in wrong state:
have-remote-offer` — or the answer to a superseded offer throws `Called in
wrong state: stable`. Either way the publish never negotiated: the sender
  existed, its m-section stayed `recvonly`, and the room saw no media while
  the SDK reported `camera published`. Every operation that touches the
  signaling state machine now runs on one chain, and local changes request an
  offer rather than making one, so any number of them coalesce into a single
  round trip. Glare resolves politely — the SFU's offer wins, ours rolls back
  and is re-queued — and a server-side `NEGOTIATION_GLARE` re-queues instead
  of being logged and dropped. No timers anywhere; `setTimeout(0)` is gone
  from the publish path.

  **A reconnect left the room silent.** `published` mixed desired state with
  the `RTCRtpSender` of a connection that no longer existed, and nothing
  re-published onto the replacement. Desired state and connection state are
  now separate: rejoining re-adds every live publication, re-declares its
  source to the new SFU session, and renegotiates once. A screen share whose
  capture ended during the outage is dropped instead — the track is dead and
  only the user can start a new one — and reports
  `localTrackUnpublished`.

  **The data channel could not bootstrap itself.** `openDataChannel()`
  created a channel and negotiated nothing, so the first `sendData()` threw
  "The data channel is not open yet" unless a media publish happened to carry
  the channel along. Creating the channel now requests the renegotiation it
  needs, `sendData()` awaits it internally, and payloads sent meanwhile are
  queued and delivered in order. `await room.join()` then
  `await room.sendData(payload)` works in an empty room. A connection that
  dies first rejects with `CONNECTION_FAILED` rather than hanging.

  **Application-provided tracks have a way in.** `LocalTrack` and
  `LocalTrackDelegate` are public, so a hand-built track looked publishable
  and was refused. New `createCustomTrack(mediaStreamTrack, { source })`,
  also on the client as `client.createCustomTrack()`, wraps a track the
  application already has — `canvas.captureStream()`, a Web Audio graph, a
  decoded file, a virtual camera — in a real internal delegate. What
  `publish()` accepts is unchanged; its refusal now names the way through.

## 0.2.0

### Minor Changes

- [#40](https://github.com/atulsinghhhh/swalvo-sdks/pull/40) [`d7f48ea`](https://github.com/atulsinghhhh/swalvo-sdks/commit/d7f48ea4294a36c7fd6d60ebff0f5b32820101e9) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - RTC tokens can now be revoked, and two server errors reach you as their own
  typed codes instead of a generic one.

  `DELETE /v1/rooms/{roomId}/rtc-tokens/{tokenId}` revokes a minted token
  before it expires. Be clear about the boundary, because it is deliberate:
  revocation refuses the token for anything _new_ — the next signaling connect
  and the next telemetry call fail with `TOKEN_REVOKED` — and does **not** hang
  up a session already running on it. Authorization is checked when a
  connection is established, not re-checked per frame, so a participant who
  joined a moment earlier stays until they leave or their next reconnect fails.
  Close the room (`DELETE /v1/rooms/{roomId}`) to cut a live session. A short
  `ttlSeconds` therefore still does more to contain a leaked token than
  revocation does; revocation is the second control, not a replacement.

  Revocation is keyed by the token's `jti` — which is the `rtc_tokens` row id
  already returned as `id` from the mint — and the tombstone expires with the
  token, so nothing accumulates and no bearer token is ever stored. Same design
  as chat's, rather than a second mechanism.

  On the SDK side, `RTCErrorCode` gains `TOKEN_REVOKED` and
  `USAGE_LIMIT_EXCEEDED`. The second is the one worth noticing: running out of
  included Raven minutes previously surfaced as `SIGNALING_ERROR`, which is
  indistinguishable from signaling actually breaking. It is the one join
  failure whose remedy is commercial rather than technical, so an application
  can now show a billing prompt instead of a retry button. Both are treated as
  terminal for reconnect purposes: neither a backoff nor a fresh token can fix
  a revoked credential or an exhausted allowance.

### Patch Changes

- [#38](https://github.com/atulsinghhhh/swalvo-sdks/pull/38) [`3dd03cc`](https://github.com/atulsinghhhh/swalvo-sdks/commit/3dd03cccaca678e507c9ab67b93bc21357232b52) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - `@swalvo/rtc`'s `assertTokenMatchesRoom()` now actually works.

  It decoded the room from `video.room`, which was LiveKit's token claim
  shape. Raven's own signer emits `rid` (room id) and `rnm` (room name), so
  the claim read back `undefined` and the check silently passed every room —
  `client.join('anything')` proceeded to a connection that then failed at the
  signaling gateway. It now reads `rid`/`rnm` and accepts either, which is
  what the claim comment in the control plane always said it would.

  This is versioned as a patch. The note that previously stood here — that
  the `@swalvo/*` packages had never been published, so nobody could have
  observed the broken behaviour — was wrong by the time it was written:
  `@swalvo/rtc@0.1.0` is on npm and has been, so the broken `video.room`
  claim read did ship.

- [#40](https://github.com/atulsinghhhh/swalvo-sdks/pull/40) [`d7f48ea`](https://github.com/atulsinghhhh/swalvo-sdks/commit/d7f48ea4294a36c7fd6d60ebff0f5b32820101e9) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - `@swalvo/rtc` and `@swalvo/live` are installable again.

  Both shipped at 0.1.0 with the workspace protocol still in their published
  manifests — `"@swalvo/effects": "workspace:*"` for `rtc`, plus
  `"@swalvo/chat"` and `"@swalvo/rtc"` for `client`. The packages were
  public and downloadable the whole time; they just could not be installed by
  anyone outside this repo:

  ```
  npm  install @swalvo/rtc → EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"
  pnpm add     @swalvo/rtc → ERR_PNPM_WORKSPACE_PKG_NOT_FOUND @swalvo/effects@workspace:*
  ```

  That made step 2 of the documented quickstart — `npm install @swalvo/rtc`
  — impossible to follow, while `@swalvo/server` installed fine, so the
  break only showed up once a developer got as far as the browser half.

  No source change was needed: `workspace:*` is correct in the repo, and pnpm
  rewrites it to a concrete version when it packs. The 0.1.0 tarballs were
  published by hand with `npm publish`, which rewrites nothing and bypassed
  every gate in `.github/workflows/release.yml`. Three gates now cover that
  path — a `prepublishOnly` guard in each package that refuses an npm-driven
  publish, a packed-tarball inspection that reads the manifest npm would
  actually receive, and a metadata check that fails a package using the
  protocol without the guard wired up.

  0.1.0 stays on the registry as-is; npm unpublish is restricted to 72 hours
  and that window is long closed. Anyone stuck on it can use an npm
  `overrides` entry pinning `@swalvo/effects` to `0.1.0` until 0.1.1 lands.

- [#40](https://github.com/atulsinghhhh/swalvo-sdks/pull/40) [`0797ed2`](https://github.com/atulsinghhhh/swalvo-sdks/commit/0797ed2d9d07c1fc3defad08ac3cbab8ad00bfa4) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - Media now negotiates for the first participant in a room.

  The SFU took the DTLS client role when answering and the server role when
  offering, on the same peer connection. Since it offers at join and answers
  when a client publishes, the first participant in any room hit both in that
  order: it answered the join offer `active`, then the SFU's answer to its
  publish also said `active`. That asks both peers to swap DTLS roles
  mid-session, which is not a thing a transport can do — Chrome rejected the
  answer with "Failed to set SSL role for the transport", the publish never
  negotiated, and the participant sent and received nothing while the SDK
  cheerfully logged "camera published".

  Later joiners were unaffected: they answer an SFU offer first and happen to
  line up, which is why this looked intermittent rather than deterministic.

  `services/sfu` now pins its answering DTLS role to server
  (`SetAnsweringDTLSRole`), so the client is the DTLS client and the SFU the
  DTLS server whichever side offered. `docs/rtc/signaling.md` documents that
  as part of the protocol.

  The versioned part is `@swalvo/rtc`, which no longer discards the
  browser's reason when it cannot answer an offer. It reported a bare "Could
  not answer the server's offer", which said that renegotiation broke but not
  why — and renegotiation is exactly where a role or m-line mismatch shows
  up. The underlying message is now included.

  `services/sfu` is not a published package, so the fix itself is not
  versioned here.
