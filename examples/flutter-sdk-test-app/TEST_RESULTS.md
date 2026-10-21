# Test results

Status legend used throughout: **PASS**, **FAIL**, **BLOCKED** (environment
doesn't permit running it — not the same as skipped), **NOT RUN** (could
have run, didn't get to it this pass).

Separate categories on purpose: mocked/automated results prove the app's
own logic and the SDKs' pure-Dart logic. Real-backend results prove the SDK
and backend actually work together. Browser results prove Flutter Web
specifically. iOS results are split into build / Simulator / physical
device because each proves something the others can't, and conflating them
would misrepresent what was actually verified. Physical-device results
prove things an emulator/Simulator can't (a real camera sensor, real
cellular/Wi-Fi handoff, real device permission UX).

**Follow-up pass, same day (2026-10-10), continuing from the pass below:**
closed the `swalvo_live` test-coverage gap (§3.3) with a reviewed, minimal
seam; audited everything that would be staged by a commit of this app,
`third_party/`, and `.github/workflows/` for necessity and secrets (§4.10)
— found and fixed a real leaked API key and a real `.gitignore` gap;
validated `flutter-ios.yml` and found and fixed a real job-control bug
(§4.11); re-ran every Flutter suite (all green); and ran a genuine,
deliberate Android network-cut disconnect/reconnect test (§2 scenario 10,
§3.4), which caught and then confirmed the fix for a mistaken claim this
same document had made in the pass below it. No JavaScript SDK work was
started this pass.

**Third pass, same day (2026-10-10): the fresh-clone blocker is now closed.**
Committed this app and `third_party/flutter_webrtc-1.6.2-hotfix.4-swalvo-patch`
(`eb2260c`), then fixed two now-stale CI comments that asserted the
platform directories were uncommitted (`8f98131`). Verified from a genuine
second `git clone` of the repository at `8f98131` — not the working tree
this and prior passes ran in — that both the long-standing fresh-clone
blocker (§0's caveat) and `ci.yml`'s `flutter-webrtc-patch` job are now
real: writing the same `pubspec_overrides.yaml` that job writes resolved
cleanly against the committed `sdks/flutter/*` packages and the committed
`third_party/` patch, `flutter analyze --fatal-infos` and `flutter test`
both passed, and `flutter build apk --debug` **actually built** (Gradle
assembled `app-debug.apk` in 25s) — stronger evidence than a dry read,
though not a substitute for the job actually running on GitHub's own
runner. See §0a for the full command-by-command record. No JavaScript SDK
work was started this pass either; that begins next.

## 0. Environment and revision, this pass (2026-10-10)

```
$ git rev-parse HEAD
66f72ca3620d882350cf2849a3f214b2c16bd529   # HEAD at the start of this pass
                                             # (commit message: "fix(chat):
                                             # recognize raw-query unique
                                             # violations in message dedupe")

$ flutter --version
Flutter 3.47.2 • channel stable
Engine revision 1cf1c4773fb941c4c74a7f8bb144a8837596c0f4
Tools • Dart 3.13.2 • DevTools 2.60.0

$ dart --version
Dart SDK version: 3.13.2 (stable) (macos_arm64)

$ node --version && pnpm --version
v26.3.1
11.22.0

$ xcodebuild -version
xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer
directory '/Library/Developer/CommandLineTools' is a command line tools
instance        # → no Xcode.app, no iOS Simulator. See §4 and
                 #   docs/sdk/flutter-ios-testing.md.

Platform: macOS, darwin/arm64. Two Android emulators used throughout
(Pixel_10 AVD, API 37, emulator-5554 / emulator-5556). Playwright 1.63.0 +
Chromium (cached, already installed) used for browser coverage.
```

**Important, not optional context:** as of this writing,
`examples/flutter-sdk-test-app` (this whole app — `lib/`, `pubspec.yaml`,
`server.mjs`, this file, and every generated platform directory) is **not
committed** to this repository. `git ls-files examples/flutter-sdk-test-app`
returns nothing. Everything in this document was run against a real,
working local checkout — none of it is fabricated — but a fresh `git clone`
of this repo does not yet contain any of it, including the two new CI
workflows this pass added that reference it
(`.github/workflows/flutter-ios.yml`,
`ci.yml`'s `flutter-webrtc-patch` job). Commit the app before relying on
either.

**Superseded by §0a below, same day:** the paragraph above was true when
this pass started. It no longer is — the app and the vendored patch are
committed as of `eb2260c`.

## 0a. Third pass (2026-10-10): committed, then validated from a real second clone

```
$ git log --oneline -3
8f98131 docs(ci): fix stale "not committed" comments now that the Flutter example app is tracked
eb2260c feat(flutter): commit flutter-sdk-test-app and the vendored flutter_webrtc patch
66f72ca fix(chat): recognize raw-query unique violations in message dedupe
```

Before staging anything: dry-run (`git add -A -n`) over exactly
`examples/flutter-sdk-test-app`, `third_party/flutter_webrtc-1.6.2-hotfix.4-swalvo-patch`,
`.github/workflows/ci.yml`, `.github/workflows/flutter-ios.yml`, and
`.gitignore` — 471 files. Confirmed none of `build/`, `.dart_tool/`,
`android/.gradle`, `pubspec_overrides.yaml`, or `*.iml` were in that list
(verified with `git check-ignore -v` on representative paths from each,
all correctly matched by either the root or the app's own `.gitignore`).
Scanned every candidate file for `rvk_`/`AKIA`/`sk_live_`/`ghp_`/PEM-header
patterns outside `test/`/`README.md` — none found; `.env.example` still
carries the `rvk_xxx.yyy` placeholder from §4.10's fix, not a real key.
No file in the candidate set exceeds 200KB. Committed as `eb2260c`.

Two of the workflow comments this repo already shipped then became false
the moment that commit landed: both `ci.yml`'s `flutter-webrtc-patch` job
and `flutter-ios.yml`'s `simulator` job carried a comment asserting the
platform directories "are not committed to this repo — confirmed via
`git ls-files`". Fixed in `8f98131` to describe the `flutter create .`
step as a defensive no-op instead of a load-bearing workaround — the step
itself is unchanged and still correct either way.

**Validation method, stated plainly:** everything below ran in a genuine
second `git clone` of this repository at `8f98131`
(`git clone . /path/to/scratch/fresh-clone`) — not the working tree any
other section of this document used — specifically so "works on a fresh
clone" is demonstrated rather than assumed from a read of the YAML. This
is still local execution, not GitHub's own `ubuntu-latest`/`macos-latest`
runners; §10 item 1 below is explicit about what that distinction does
and doesn't prove.

| Step (mirrors `ci.yml`'s `flutter-webrtc-patch` job exactly) | Result |
|---|---|
| Write `pubspec_overrides.yaml` (the exact heredoc the job writes) | done |
| `flutter pub get` | **PASS** — resolved `swalvo_rtc`/`swalvo_chat`/`swalvo_live` to `../../sdks/flutter/*` and `flutter_webrtc` to `../../third_party/flutter_webrtc-1.6.2-hotfix.4-swalvo-patch`, all from the committed tree |
| Grep `pubspec.lock` for the patched-fork path (the job's own assertion step) | **PASS** |
| `flutter analyze --fatal-infos` | **PASS** — 0 issues |
| `flutter build apk --debug` | **PASS** — Gradle assembled `build/app/outputs/flutter-apk/app-debug.apk` in ~25s, no errors (Kotlin-Gradle-Plugin and Java-8-obsolete lines are pre-existing warnings, not failures) |
| `flutter test` (the app's own suite) | **PASS** — 19/19 |

| Step (mirrors `flutter-ios.yml`'s OS-independent `flutter-test` job) | Result |
|---|---|
| `swalvo_rtc`: `flutter pub get && flutter analyze --fatal-infos && flutter test` | **PASS** — 0 issues, 196/196 |
| `swalvo_chat`: same | **PASS** — 0 issues, 67/67 |
| `swalvo_live`: same | **PASS** — 0 issues, 13/13 |

Ran on this machine (macOS, same Flutter 3.47.2 as `flutter-ios.yml`
pins), so this is genuine evidence for that job's Dart-level logic, not
just a structural read — but it is not a claim that the job has run *on*
`macos-latest`, which only GitHub Actions can confirm.

**Still BLOCKED, unchanged by this pass:** `flutter-ios.yml`'s `simulator`
and `rtc-chat-build` jobs need Xcode (§6) — not available in this
environment either. **Still not executed on GitHub Actions:** nothing was
pushed this pass (local commits only, per working in a local checkout);
`gh workflow run` cannot target a workflow that only exists on local
commits not yet on a remote branch. The exact trigger command, unchanged
from §4.11:

```bash
git push origin main   # — not run this pass; a visible, shared action
gh workflow run flutter-ios.yml --repo atulsinghhhh/Relayo --ref main
```

## 1. Automated results — mocked, no network, no real backend

All three SDK packages resolved against their working tree (local,
untracked `pubspec_overrides.yaml` per the README's "Until the SDKs are
published" note — the committed `pubspec.yaml` depends on the hosted
versions, which don't exist yet).

| Package / check | Result | Notes |
|---|---|---|
| `flutter analyze` — `swalvo_rtc` | **PASS** | 0 issues |
| `flutter analyze` — `swalvo_chat` | **PASS** | 0 issues |
| `flutter analyze` — `swalvo_live` | **PASS** | 0 issues |
| `flutter analyze` — `flutter-sdk-test-app` (`--fatal-infos`) | **PASS** | 0 issues |
| `flutter test` — `swalvo_rtc` | **PASS** | 200/200 (199 baseline + 1 new regression test, §3) |
| `flutter test` — `swalvo_chat` | **PASS** | 70/70 (67 baseline + 3 new regression tests, §3) |
| `flutter test` — `swalvo_live` | **PASS** | 15/15 (13 baseline + 2 new lifecycle-cleanup regression tests this follow-up pass — see §3.3) |
| `flutter test` — `flutter-sdk-test-app` | **PASS** | 19/19 (redaction, ring buffer, `BackendClient` request/error shaping, Config/Checklist screen state machines) |
| `flutter test integration_test` — `flutter-sdk-test-app` | **NOT RUN** | Analyzed clean; needs an attached device/Simulator to actually execute, which the real emulator runs below used instead |
| `apps/api` — chat module (`npx jest --testPathPattern="modules/chat"`) | **PASS** | 368/368, 40 suites (365 baseline + a new 5-test file, §3) |
| `apps/api` — `npx tsc --noEmit` | **PASS** | Clean |

These prove the app's own code and the SDKs' pure-Dart logic do what they
claim under mocks. §2 and §4 are what actually prove the SDKs work against
real infrastructure.

## 2. Real-backend / Android emulator results

Two independent `flutter-sdk-test-app` instances on two concurrent Android
emulators, against a real `apps/api` (Docker), a real API key, real
`coturn`, and a real `raven-sfu`. Carried over from the 2026-10-09–10
baseline pass and re-verified against today's fixed SDK sources in a fresh
debug-APK smoke test (§3).

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | SDK initialization succeeds with valid configuration | **PASS** | Connection tab: backend reachable, API key configured true |
| 2 | Invalid configuration produces a clear error | **NOT RUN** | Covered in `MANUAL_TESTING.md` |
| 3 | API authentication succeeds with a valid credential | **PASS** | Real sessions minted repeatedly: RTC + chat tokens, real ICE servers |
| 4 | Invalid/unauthorized credentials fail safely | **NOT RUN** | Covered in `MANUAL_TESTING.md` |
| 5 | RTC room join and leave work | **PASS** | Single- and two-client; `connectionState: connected`, clean leave each time; re-confirmed today after the signaling fix (§3) |
| 6 | Local media publishing works on supported devices | **PASS** | Real camera frame captured and rendered in the local preview tile; real mic enable with no crash |
| 7 | Two clients exchange real audio/video | **PASS** | `tester`'s camera feed rendered as a real decoded video frame in `tester2`'s remote tile, over the real SFU/TURN relay path. `Media: connected`, `Quality` genuinely fluctuated (`poor`→`good`) — not hardcoded |
| 8 | Chat messages reach a second client | **PASS** | Message sent from `tester` arrived at `tester2` with the identical server-assigned id, sender, timestamp. Re-verified on Flutter Web too (§5) |
| 9 | Chat retries do not create duplicate durable messages | **PASS** | Reproducibly **failed** against current source on 2026-10-10 — a real, confirmed `apps/api` defect, not a flake — root-caused and fixed (§4.7), then re-verified live: retry now returns the original message id |
| 10 | Disconnect and reconnect work | **PASS** | Deliberate `adb shell svc wifi/data disable` network cut run this follow-up pass (not simulated — confirmed via `ping`: "Network is unreachable", and independently via the emulator's own Calendar app showing a "No connection" banner). RTC and Chat both correctly transitioned to `reconnecting`; RTC exhausted its bounded retry count during a sustained 20s+ outage and reached a terminal `failed` state (expected — not an infinite-retry design), fully recovered via a manual Leave+Join; Chat recovered fully **on its own** once network returned (confirmed by actually sending a message post-recovery, which arrived with a real server-assigned id). `adb logcat -s flutter:E` showed **zero** unhandled exceptions throughout either path, confirming fix §3.2(c) live under the exact real-network-interruption condition it was written for — the first live re-verification of that fix, since it had only been unit-tested until this pass |
| 11 | Camera/microphone permissions are handled correctly | **PASS** | Sequential camera-then-mic system permission dialogs, both granted cleanly |
| 12 | Live-stream host/viewer flows work where supported | **PASS** | Host and viewer both join, correct `role`/`delivery` reported; status-refresh fetches real, matching data on both devices (`GET /api/live/:id/status`) |
| 13 | Repeated joins/leaves don't leak resources | **PASS** | Left and rejoined the same room multiple times across both clients; no stale participants |
| 14 | Backend or network failure produces a recoverable error | **PASS** | `Swalvo.join()` fails with a clean, readable `SwalvoException` — no crash, no hang, Join re-enabled for retry |

Full narrative history (the camera-crash fix, the viewer/status-refresh
follow-up, the chat-idempotency bug, today's smoke-retest) is in §4.

## 3. What was fixed this pass (2026-10-10) — SDK-level

Four confirmed, reproduced-not-assumed defects, three in the Flutter SDKs
and already covered in §4.7 for the fourth (`apps/api`). Each: reproduced →
root-caused → minimal fix → regression test (where a test seam exists) →
full suite re-run.

### 3.1 `swalvo_rtc`: a reconnect attempt racing `dispose()` leaks a socket and can rejoin a room nobody asked for

**File:** `lib/src/internal/signaling_client.dart`, `_openAndJoin`.
**Found by:** targeted code audit of dispose/listener/timer patterns (this
pass), not live reproduction — confirmed by tracing every caller.

`close()`/`dispose()` can run while a scheduled reconnect's own `_open()`
(a real network round trip) is still in flight — an ordinary "leave during
a reconnect attempt" race. `_openAndJoin` committed that late socket
unconditionally once `_open()` resolved: assigned to `_socket`, subscribed
to, and actually joined into the room, even though the caller had already
left. Result: a leaked socket nobody ever closes, a stale server-side
participant nobody asked for, and (if the join then succeeded) a
`room.joined` payload written to `_joins`/`_states` after `dispose()` may
have already closed them.

**Fix:** re-check `_closedByCaller` immediately after `_open()` resolves,
before touching `_socket` or calling `_join()`; close the late socket and
throw instead. Mirrors the same guard already present at every other
resumption point in the reconnect chain.

**Regression test:** `test/signaling_client_test.dart` — a `SignalingClient`
whose second `socketFactory` call is gated by a `Completer` the test
controls; `dispose()` fires while that gate is still closed, then the gate
opens. Asserts the late socket is closed (`closeCalled`) and never sent a
`room.join` (`sent.isEmpty`). Confirmed to fail without the fix, pass with
it.

**Suite after fix:** `swalvo_rtc` 200/200, `flutter analyze` clean.

### 3.2 `swalvo_chat`: three related `dispose()`/connection-failure defects

**File:** `lib/src/chat_client.dart`. Found by targeted audit, with one of
the three (3.2c) then independently reproduced live on a real Android
device (see below) before a code-level cause was known.

**(a) `dispose()`/`disconnect()` while `connect()` awaits the server's
hello can hang that `connect()` forever.** `_teardownSocket()` cancels the
socket subscription *before* closing it, on purpose, so the close doesn't
drive a reconnect — but that also skips the only other code
(`_handleSocketClosed`) that completes/fails the `_connected` `Completer`
`connect()` is awaiting. No error, no success, forever.
**Fix:** `_teardownSocket()` now completes `_connected` with a
`SwalvoChatException(connectionClosed)` if it's still pending, before
cancelling the subscription.

**(b) `dispose()` never failed in-flight requests.** `disconnect()` already
called `_failPending(...)`; `dispose()` didn't, so a pending `_request()`
(e.g. `markAsRead`, a moderation call) would sit until its own
`requestTimeout` (15s default) instead of failing immediately.
**Fix:** added the same `_failPending(...)` call to `dispose()`.

**(c) A failed connection attempt reports an unhandled exception,
independent of (a)/(b).** `WebSocketChannel.connect` (the real transport —
confirmed by reading `package:web_socket_channel`'s source) completes a
separate `channel.ready` Future with an error when the underlying
connection fails — distinct from the `stream` this class listens to.
Nothing in `swalvo_chat` ever read `ready`, so Dart reports that
`Completer.completeError` as a top-level **"Unhandled Exception"**.
**Reproduced live, unprompted, on a real Android device** via `adb logcat`
while this pass's other emulator work was running in the background — one
such entry per failed chat-socket connection attempt (connection refused,
HTTP connection reset), which is an ordinary, frequent event (a network
blip, a backend restart), not an edge case. An app wiring a crash reporter
to the zone's uncaught-error handler (the normal setup) would count every
one of those as a crash.
**Fix:** `_openSocket` now does `unawaited(channel.ready.catchError((_) {}));`
immediately after creating the channel — marks the error observed without
changing any actual error handling, which stays on the stream exactly as
before.

**Regression tests:** `test/chat_client_test.dart`, new `dispose() lifecycle
races` and `connection-failure handling` groups (3 tests): (a) a `connect()`
left awaiting a `FakeChatSocket` that never calls `acceptConnection`, then
disposed, resolves with a `SwalvoChatException` within 500ms rather than
hanging; (b) a pending `markAsRead()` after `connected()` fails immediately
on `dispose()`, well inside the 15s `requestTimeout`; (c) `FakeChatSocket`
extended with a `readyAccessed` flag and an injectable `readyError` —
asserts `_openSocket` reads `ready` at all (deterministic and what actually
regressed; *whether* Dart's unhandled-error reporting fires is a
best-effort, timing-dependent diagnostic this pass found isn't reliably
assertable in a unit test — see that test's own comment for why). All three
confirmed to fail without their respective fix, pass with it.

**Suite after fix:** `swalvo_chat` 70/70, `flutter analyze` clean.

### 3.3 `swalvo_live`: a chat connection that fails after the RTC room already joined is never disposed

**File:** `lib/src/live_stream.dart`, `join()` and `_connectChat()`. Found
by targeted audit (traced `SwalvoChat`'s constructor to confirm it
allocates a real REST client immediately, so this is a real leak, not
theoretical).

In the RTC+chat path, `join()`'s `catch` block correctly does
`await room.leave(); room.dispose();` when `chat.connect()` throws — but
never touches `chat`, which is otherwise dropped still holding its own REST
client and any timer `connect()` armed before failing. The
`_connectChat()` path (pure-HLS-viewer-with-chat, no RTC room at all) had
no `try/catch` around `chat.connect()` whatsoever — same gap, nothing to
even reroute through.

**Fix:** both sites now call `chat.dispose()` before rethrowing/propagating,
mirroring the existing `room.leave(); room.dispose();` discipline.

**Regression tests added this follow-up pass** (closing the gap left
above). Reviewed the API impact before adding anything: `swalvo_rtc`'s
`SwalvoRoom` has a private constructor (confirmed via `grep` —
`SwalvoRoom._(...)`, only constructible from within that package's own
`room.dart`), so no test outside `swalvo_rtc` can ever obtain a real,
network-free one. Rather than ask `swalvo_rtc` to expose one (a
cross-package API change, out of scope here) or force a real signaling
round trip in a unit test, `live_stream.dart` now declares a minimal,
additive, `@visibleForTesting` seam, entirely local to `swalvo_live`:

- `LiveStreamRoomCleanup` — an abstract interface narrowed to exactly the
  two calls the cleanup path needs (`leave()`, `dispose()`). `join()`
  always wraps the real `SwalvoRoom` in a trivial pass-through
  (`_RealRoomCleanup`) — never alternate behavior.
- `SwalvoLiveStream.connectChatOrCleanUp` — the single, now de-duplicated
  implementation both of `join()`'s chat-attach sites call, made public
  and `@visibleForTesting` (not exported from the `swalvo_live.dart`
  barrel — src-level import only, same convention `swalvo_rtc`'s own
  tests use) specifically so a test can drive the real failure-and-cleanup
  logic without a network.

**Public API impact: none for real callers.** `join(credentials)`'s single
required argument is unchanged; both additions are new, optional,
`@visibleForTesting` surface that doesn't appear in the package's normal
public barrel at all.

New test file `test/live_stream_join_failure_test.dart`, two cases, both
confirmed to fail without their respective fix and pass with it:
1. A chat whose `connect()` fails deterministically (a `connectChannel`
   that throws synchronously — no fake socket needed, `_openSocket`'s own
   try/catch converts it into a `SwalvoChatException` immediately) after a
   fake room: asserts `leave()` then `dispose()` were called on the room,
   in that order, and that `chat` itself was disposed
   (`ChangeNotifier.addListener` asserting post-dispose is the standard
   Flutter-test proof, since `SwalvoChat` has no public `isDisposed`
   getter of its own).
2. The same chat failure with `room: null` (the HLS-viewer path): asserts
   chat is disposed and nothing touches a room that was never there.

**Suite after fix:** `swalvo_live` 15/15 (13 baseline + 2 new), `flutter
analyze --fatal-infos` clean.

### 3.4 Real-device smoke test after 3.1–3.3

Rebuilt `flutter-sdk-test-app`'s debug APK against the three fixed SDK
packages (path-override resolution, so the fixes were live, not
theoretical) and re-ran the two-emulator RTC flow end-to-end against the
real backend:

- Both emulators joined the same room against a real `apps/api`/`coturn`/
  `raven-sfu` — `Connection: connected · Media: connected · Quality:
  excellent` on the surviving client.
- A real, ungraceful disconnect occurred naturally (an identity collision —
  both clients briefly used the same identity, which the server correctly
  evicted the earlier session for) and was handled cleanly: the evicted
  client's UI correctly showed `Connection: disconnected · Media: failed ·
  Quality: lost`, no crash.
- `adb logcat -s flutter:E` showed **zero** uncaught-exception entries
  during or after this specific test.

**Correction, this follow-up pass:** the line above was true for *this*
smoke test, but an earlier draft of this document over-generalized it into
"confirming fix 3.2c closed exactly what it was meant to" — which hadn't
actually been checked under the one condition that matters for that fix
(a live, real connection-failure during a network outage), only under a
same-identity-eviction disconnect, a different failure shape. This
follow-up pass's own deliberate airplane-mode test (§2, scenario 10)
initially *reproduced the exact pre-fix "Unhandled Exception" pattern
again*, live — not because the fix was wrong, but because the APK
installed for that first disconnect test still predated it: 3.2c was
written and committed to source *after* the APK used in this section's
smoke test was built, and no rebuild had happened in between. Rebuilding
and reinstalling before retrying closed the gap and gave the real
confirmation — see §2 scenario 10 for that result. Left both entries in
this document rather than silently editing the earlier one out: the
mistake (claiming a fix was live-verified when only the source change had
been made, not a fresh build) is itself worth a reader noticing, and is
exactly the kind of claim this document's own instructions say not to
make.

### Flaky-test note (not a regression)

A first run of `swalvo_rtc`'s `ice_recovery_test.dart` (real-timer-based:
12s/26s/52s/65s wall-clock waits, not `fakeAsync`) showed 3 failures with
`MissingPluginException` and `TimeoutException`, while two Android emulators
and heavy Docker/background load were running concurrently (`uptime` load
average 14.7–20 on this machine). Re-run with both emulators stopped: clean
8/8 in 65s, matching the original baseline timing exactly. Root-caused to
system contention delaying real timers past the test's own internal
timeouts, not a code defect — confirmed by the complete absence of any
plausible causal path from the actual code change (`signaling_client.dart`,
pure Dart/WebSocket code) to the actual failure mode (a native
`flutter_webrtc` platform-channel mock, `createOffer`, a completely
different subsystem). Documented here per this pass's instruction not to
silently skip or hand-wave a test result either way.

## 4. What was fixed — `apps/api` and the example app itself

Continuing the numbering from earlier sessions' investigation narrative
(§4.1–4.6 below predate this pass; §4.7 is from earlier today; §4.8–4.9 are
new this pass).

### 4.1 The camera crash — `swalvo_rtc` + `flutter_webrtc` (the original ask)

**Two separate, independently necessary fixes**, not one:

**(a) `swalvo_rtc`'s own lifecycle bug (fixed in source, both call sites in
`sdks/flutter/swalvo_rtc/lib/src/internal/engine.dart`):** every
peer-connection teardown called `pc.close()`, never `pc.dispose()`.
`flutter_webrtc`'s native side only removes a `PeerConnection`'s observer
from its own process-lifetime registry on `dispose()`
(`peerConnectionDispose`); `close()` alone leaves that registry entry
behind forever. Every room leave/reset therefore permanently leaked one
stale native observer, for the life of the app process.

**(b) A genuine, still-open upstream `flutter_webrtc` defect**
([flutter-webrtc/flutter-webrtc#1809](https://github.com/flutter-webrtc/flutter-webrtc/issues/1809),
filed 2025-04-04, independently reproduced by an unrelated project on real
Android hardware, no maintainer fix as of this writing):
`PeerConnectionFactory.createPeerConnection()` can return `null` on
internal libwebrtc construction failure; the plugin registered the broken
observer anyway, and the *next* `getUserMedia()` call from *any* room
crashed on `PeerConnectionObserver.getTransceiversTrack()`'s unguarded
`peerConnection.getTransceivers()`.

Fixed by vendoring a locally patched `flutter_webrtc` 1.6.2+hotfix.4 into
`third_party/flutter_webrtc-1.6.2-hotfix.4-swalvo-patch/` (three minimal,
documented patches — see `SWALVO_PATCH_NOTES.md` in that directory). **This
protects only this example app.** See
`docs/sdk/flutter-webrtc-patch-distribution.md` (new this pass) for the
full analysis of why, the pub.dev constraints that rule out the easy fixes,
and the concrete long-term plan.

### 4.2 `apps/api` was serving a stale Docker build

TURN-cascade code was running from before the current host:port-aware
`TURN_HOSTS` parsing was written. Fixed by `docker compose build api` +
recreate — no code change needed.

### 4.3 Pending Prisma migrations

8 already-written, already-committed migrations had never been applied to
the connected database. Fixed with
`pnpm --filter @swalvo/api run prisma:migrate:deploy` — no schema authored.

### 4.4 Emulator-only networking (reverted after every use; documented, not a defect)

`apps/api` (`API_PUBLIC_URL`, `TURN_HOST`), coturn (`TURN_EXTERNAL_IP`), and
the SFU (`SFU_PUBLIC_HOST`/`SFU_PUBLIC_IP`) all default to `localhost`,
which doesn't resolve to the host machine from inside the Android emulator
(`10.0.2.2` does). Reused repeatedly throughout this pass and reverted to
`localhost`/`127.0.0.1` every time afterward, confirmed via
`docker compose up -d --no-deps api coturn sfu` + `/health` each time. See
§6 for the exact commands.

### 4.5 `flutter-sdk-test-app`'s own dashboard dropped live sessions on tab switch

Rebuilding the tab list on every `build()` call looked like "navigate to a
different screen" to Flutter, silently disposing the Chat tab's live
`SwalvoChat` connection. Fixed in `lib/screens/dashboard_screen.dart` with
an `IndexedStack`. Re-verified immune to this specific cause during this
pass's follow-up testing (direct re-test: join a room, check Diagnostics,
come back — session survives).

### 4.6 `flutter-sdk-test-app`'s own retry button never enabled

`ChatTab._send()` mutated state without `setState()`. One-line fix in
`lib/screens/chat_tab.dart`.

### 4.7 `apps/api` chat idempotent-retry fallback never actually caught its own retries

`MessagesService.insertWithSeq` writes via `$executeRaw` (atomic seq-bump +
insert), so a retried `clientMessageId` surfaces as a **raw-query**
failure — Prisma 7.10's `PrismaClientKnownRequestError` with
`code: 'P2010'` and an **empty** `meta` object, not `code: 'P2002'` with
`meta.code: '23505'` the way the same violation looks through a typed
`.create()` call. The dedupe fallback only ever checked for `P2002`, so
every real retry 500'd instead of idempotently returning the original
message. Reproduced 3/3 against the real backend; root-caused from
`raven-api`'s own logs plus a temporary diagnostic log of Prisma's actual
error shape (removed before the real fix landed).

**Fix:** `isUniqueViolation` in
`apps/api/src/modules/chat/messages/messages.service.ts` now also matches
`P2010` whose message text names `chat_messages_idempotency_key`
specifically — narrow on purpose, per this pass's own instruction not to
treat every `P2010` as a successful duplicate retry; a `P2010` naming a
*different* constraint is correctly still a real failure.

**Regression test (added this pass, previously missing):** the function
is now `export`ed specifically for a direct, dependency-free test
(`messages.service.spec.ts`, 5 cases: P2002, matching P2010, a
*differently*-named P2010 constraint — must stay `false` — an unrelated
P2010, and a non-Prisma error). Chosen over mocking `MessagesService`'s
14-dependency constructor to reach the same branch indirectly, which risks
a false-positive pass from a mocking mistake more than it adds confidence.
Confirmed to fail to even compile without the `export` (i.e. without the
fix present at all), pass with it.

Fixed, committed separately (`66f72ca`) from unrelated pre-existing
uncommitted changes already in that file, per the user's explicit request
to commit only this fix.

### 4.8 `examples/flutter-sdk-test-app/server.mjs` had no CORS handling at all

Found while setting up Flutter Web testing (§5) — every request from a
browser origin different from the dev-helper's own (`flutter run -d
chrome`'s random port, or a static file server serving a `flutter build
web` output, as used for this pass's testing) failed before reaching any
route, with no `Access-Control-Allow-Origin` header anywhere in the
server. **This means Flutter Web has likely never actually been tested
against this dev-helper before** — Android/iOS/desktop builds are
unaffected (no browser, no CORS), so nothing short of a real browser run
would have surfaced this.

**Fix:** added a permissive (`Access-Control-Allow-Origin: *`) CORS
middleware to `server.mjs`. Justified specifically for this file: a
never-shipped local dev tool with no cookies or ambient credentials — the
only thing it holds is an API key POSTed to it directly, same trust
boundary with or without CORS.

### 4.9 `ensureRoomAndConversation`'s room creation raced itself under concurrent clients

Found live, reproduced twice, while setting up Flutter Web two-browser
chat testing (§5): two Playwright browser contexts connecting at nearly
the same instant both saw the target room as absent
(`rooms.list()`-then-`create()`, non-atomic) and both called
`rooms.create()`; the loser got a raw `BackendException(409)` surfaced
straight to the user instead of just using the room.

**Fix:** `@swalvo/server`'s own `rooms.create()` and
`chat.createConversation()` already support a documented `getOrCreate: true`
flag for exactly this race (see
`apps/api/src/modules/rooms/dto/create-room.dto.ts`'s own comment: "two
callers race to create the same named room concurrently, which the normal
'everyone joins by room name' flow does on the very first try") —
`server.mjs` simply never used it. Rewrote `ensureRoomAndConversation` to
pass `getOrCreate: true` on both calls, which also made the preceding
`rooms.list()` call unnecessary (the atomic `getOrCreate` already
subsumes it) and removed the separate get-then-create-on-404 pattern for
the conversation, which had the identical latent race.

### 4.10 Commit-readiness audit: a real API key was sitting in a file named `.env.example`

This follow-up pass audited every file that would actually be staged by a
bulk `git add` of `examples/flutter-sdk-test-app`,
`third_party/flutter_webrtc-1.6.2-hotfix.4-swalvo-patch`, and
`.github/workflows` — not by inspection alone, but via
`git add -A -n` dry-runs, to see the literal, authoritative list rather
than guess from a directory listing.

**Found: `.env.example` contained a real, live `SWALVO_API_KEY`** — the
same key used throughout this and the prior session's live testing — in
place of the placeholder the file's own surrounding comments and this
app's `README.md` both use (`rvk_xxx.yyy`). Not a hypothetical: this file
is specifically the one meant to be safe to commit (every other real
credential path in this app is correctly never persisted — see the
Security model section of `README.md`), so a real key sitting in it was
one `git add -A` away from landing in history permanently. **Fixed**: value
replaced with the same `rvk_xxx.yyy` placeholder `README.md` already uses.
No other real-looking secrets were found in a scan of every file the dry
run would stage (a few `rvk_test.secret`/`rvk_live.supersecret123` strings
in `test/*.dart` are fixtures for the redaction logic they test, not real
keys).

**Found: `pubspec_overrides.yaml` was not `.gitignore`d anywhere**, despite
being documented repeatedly, by name, throughout this app's own
`README.md`, `third_party/.../SWALVO_PATCH_NOTES.md`, and this very
document as "local, untracked" — confirmed via the same dry run, which
listed it for staging. **Fixed**: added
`examples/*/pubspec_overrides.yaml` and
`sdks/flutter/*/pubspec_overrides.yaml` to the repository root
`.gitignore`, with the reasoning written inline (committing one would
silently force every contributor and CI run onto local path dependencies
forever, including masking the day the SDKs are actually published).
Verified with `git check-ignore -v` and a repeat dry run.

**Confirmed already correct, no action needed:** `node_modules/`,
`.dart_tool/`, `build/`, `.idea/`, `*.iml` are all already excluded (the
root `.gitignore`'s `node_modules/` rule plus this app's own Flutter-
template `.gitignore` already cover them); `pubspec.lock` and
`package-lock.json` are correctly included (an *app*, unlike the `sdks/
flutter/*` libraries, should pin both for reproducibility); the vendored
`third_party/` patch carries its own `LICENSE`+`NOTICE` (MIT, upstream
flutter_webrtc's own license — redistribution-compliant), has no nested
`.git`, no build artifacts, and nothing exceeding 120KB per file.

**Still true, not newly broken by this pass:** every platform directory
(`android/`, `ios/`, `macos/`, `web/`, `.metadata`) and this entire example
app's hand-written source are *themselves* not yet committed to this
repository at all (§0's caveat, carried over unchanged) — this pass's audit
confirms what *would* be staged once that happens, not that it has
happened. **No commit or push was made this pass**, per explicit
instruction; the two fixes above (the leaked key, the gitignore gap) are
sitting in the working tree, ready for review alongside everything else.

### 4.11 `flutter-ios.yml` validation: one real job-control bug found and fixed, workflow confirmed not yet runnable

Re-read the workflow file added in the previous pass end to end, rather
than assuming it from having written it, and checked two things that
needed actual verification rather than a read-through:

- **The override-writing heredoc's indentation**, parsed with Ruby's YAML
  loader against the real file to see the exact string GitHub Actions
  would execute (not inferred from the YAML spec) — confirmed clean: the
  literal block scalar's common-indentation stripping produces a correctly
  left-aligned `pubspec_overrides.yaml` body, not one still carrying the
  workflow file's own indentation.
- **`flutter run ... & sleep 90 && kill %1 || true`** — found and fixed a
  real bug: `%1`-style job specs need shell job control (`set -m`), which
  a GitHub Actions `run:` step's non-interactive `bash` doesn't reliably
  have enabled, so `kill %1` could silently fail to find the job and leave
  the backgrounded `flutter run` process running for the rest of the step.
  Fixed by capturing the PID explicitly (`pid=$!`) and killing that
  instead — unambiguous regardless of job-control state.

**GitHub access check** (read-only; nothing was triggered): `gh auth
status` confirms this environment is authenticated to `github.com` as
`atulsinghhhh` with `workflow` scope, and the repository remote is
`atulsinghhhh/Relayo`. `gh workflow list --repo atulsinghhhh/Relayo` does
**not** list `Flutter SDKs (iOS)` — only workflows already present on a
pushed branch are visible to GitHub's API at all, and this file exists
only in the local working tree. **The exact command to trigger it, once
it (and `examples/flutter-sdk-test-app`, per §4.10's note) are committed
and pushed:**

```bash
gh workflow run flutter-ios.yml --repo atulsinghhhh/Relayo --ref main
```

**Not run.** No push happened this pass (per explicit instruction), so
this command was not executed, and nothing in this document claims a
result for it beyond "the YAML is syntactically valid and the one bug
found in careful review has been fixed."

## 5. Browser (Flutter Web) results

**First real-browser testing this repo's `flutter-sdk-test-app` has had**
(§4.8 above is why it was never possible before this pass). Headless
Chromium via Playwright 1.63.0, `--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream` for camera/mic (Chromium's synthetic
rotating-pie-chart test pattern — real decoded frames, not a stub), served
from a `flutter build web` output via a local static file server, against
the real local backend (dev-helper + `apps/api` + real `coturn`/SFU, all on
`localhost` — no `10.0.2.2` translation needed for a browser on the same
host).

| Check | Result | Notes |
|---|---|---|
| Declared platform support (`dart:io` audit) | **PASS** | `swalvo_live/lib/src/live_player.dart` imports `dart:io` unconditionally but only *uses* it behind `if (kIsWeb) return;` — empirically confirmed this still compiles clean for web (`flutter build web` succeeded); not a bug, see note below |
| `flutter build web` (`flutter-sdk-test-app`) | **PASS** | Clean build, ~32s compile |
| Page load, Config screen render (CanvasKit) | **PASS** | Full UI renders correctly; DOM `textContent` finds nothing (expected — CanvasKit draws to `<canvas>`, not real DOM text; drove the rest via coordinates + screenshots, same method as the Android pass) |
| API key configure + Save & Connect, real `/api/configure` call | **PASS** | Blocked by §4.8 until fixed; clean after |
| Connection tab: backend reachable, API key configured | **PASS** | |
| Chat: connect (real `GET`/`POST` + WebSocket to real `apps/api`) | **PASS** | Pulled real shared message history from a previous session on connect |
| Chat: real-time two-way delivery, two separate browser contexts | **PASS** | Identical server-assigned message id on both sides, both directions |
| Room/conversation creation race under concurrent browser contexts | **PASS** (after fix) | Reproducibly **failed** (§4.9) before the fix; clean after |
| RTC: room join, two separate browser contexts, real SFU/TURN | **PASS** | `Connection: connected · Media: connected · Quality: excellent`/`good`; accurately reported remote peer's camera-off state before either enabled video |
| RTC: real two-way video, fake camera devices | **PASS** | Chromium's synthetic test-pattern video decoded and rendered correctly on **both** sides — genuine bidirectional media over the real pipeline, not a stub |
| Console/page errors throughout (`page.on('console'/'pageerror')`) | **PASS** | Zero errors after the §4.8/§4.9 fixes (only benign WebGL performance warnings beforehand) |
| Live Streaming tab on web | **NOT RUN** | Built on the same already-verified RTC (above) and chat (above) primitives; not independently exercised this pass beyond that — not claiming redundant coverage it doesn't have |
| Secure-context / HTTPS restrictions | **NOT RUN** | Tested over plain `http://localhost` only, where Chromium already treats `localhost` as a secure-context exception; a real deployed HTTPS origin's behavior (mixed content, stricter permission prompts) wasn't exercised |
| Autoplay restrictions (`SwalvoLivePlayer`/HLS) | **NOT RUN** | No BROADCAST/HLS-mode stream was exercised on web this pass (§5's Live Streaming row) |

**`dart:io` note, so a future reader doesn't re-flag it:** this pass
initially suspected `live_player.dart`'s unconditional `import 'dart:io'
show HttpClient, ContentType;` would hard-fail a web compile, since
`dart:io` isn't part of the web SDK's library set. Verified empirically
rather than asserted — `flutter build web` succeeded. Current Dart/Flutter
tooling evidently tree-shakes or stubs this correctly when the only usage
is behind a `kIsWeb` guard; reported here as a passing result, not a latent
bug, specifically because the initial assumption was wrong and is worth
correcting for.

## 6. iOS results — build / Simulator / physical device, kept separate on purpose

**All three: BLOCKED in this environment**, not skipped. Full detail,
exact commands checked, and the two paths forward (local Xcode vs. a new
GitHub Actions macOS workflow this pass added, `workflow_dispatch`-only) are
in `docs/sdk/flutter-ios-testing.md`. Summary:

| Check | Result | Why |
|---|---|---|
| iOS build (`flutter build ios` / `ios --simulator`) | **BLOCKED** | No Xcode.app on this machine — only Command Line Tools. `xcodebuild` itself refuses to build an iOS target without it |
| iOS Simulator run | **BLOCKED** | `xcrun simctl` unavailable for the same reason — no Simulator runtime exists to boot |
| Physical iOS device | **BLOCKED** | No physical iPhone available to this agent in any configuration |
| CI path for the above | **Prepared, not executed** | `.github/workflows/flutter-ios.yml` (new this pass) — Simulator build/run + integration test for `flutter-sdk-test-app`, Simulator build for `flutter-rtc-chat`, plus the three SDK packages' own `flutter test` on `macos-latest`. `workflow_dispatch`-only (manual) since macOS runner minutes cost more than Linux ones — a deliberate cost decision left to you, not turned on silently. **Not run from here** — no way to trigger GitHub Actions from this environment, so treat it as reasoned-but-unverified, and note it depends on `examples/flutter-sdk-test-app` actually being committed (§0) |

No browser result above, and no Android emulator result in §2/§3, is
represented anywhere in this document as iOS or physical-device coverage.
Android and iOS exercise entirely different native WebRTC implementations;
a Simulator result is never represented as a physical-device result either
(no camera hardware on a Simulator — permissions/signaling/chat/lifecycle
only).

## 7. Real backend vs. mocked coverage, at a glance

| Area | Mocked (§1) | Real backend (§2/§5) |
|---|---|---|
| RTC join/leave, lifecycle, dispose races | ✅ unit-level (signaling, engine) | ✅ Android (§2/§3.4) + Web (§5) |
| Chat connect/send/receive, dispose races | ✅ unit-level (`chat_client_test.dart`) | ✅ Android (§2) + Web (§5) |
| Chat idempotent retry | ✅ unit-level, server-side (§4.7's new spec) | ✅ Android, reproduced the real defect live (§4.7) |
| Live Streaming host/viewer | ✅ type/parsing only (no lifecycle tests, §3.3) | ✅ Android only (§2) |
| Room/conversation creation race | — | ✅ Web, reproduced the real defect live (§4.9) |

Every "✅ real backend" cell above means an actually-running `apps/api` +
Postgres + Redis + coturn + an SFU was in the loop — never a mocked
response standing in for one.

## 8. Known upstream bugs and local patches

- **flutter_webrtc#1809** (Android `createPeerConnection()` null return
  crash) — open upstream since 2025-04-04, no maintainer fix. Patched
  locally (§4.1b); see `docs/sdk/flutter-webrtc-patch-distribution.md` for
  the full distribution-strategy analysis and why the easy fixes
  (git-dependency, a path override) don't actually solve it for anyone
  outside this repo.

## 9. Unsupported / gaps (confirmed by reading the SDK source, not assumed)

- **No native RTMP/WHIP publish in `swalvo_live`.** A host joins the
  stream's RTC room; there is no encoder/ingest code path in Flutter.
  Confirmed live, both Android (§2 scenario 12) and Web (§5): `delivery:
  rtc` for the host role in both.
- **No raw WebRTC `getStats()` surface in `swalvo_rtc`.** `SwalvoRoom`
  exposes `connectionQuality` (`excellent/good/poor/lost/unknown`) and
  `mediaState`, not bitrate/packet-loss/jitter counters. Confirmed these
  are real (not hardcoded) by observing `connectionQuality` genuinely
  change on both Android and Web.
- **No SDK-level viewer count.** `swalvo_live` has no `viewerCount` field;
  the Live tab's status comes from the dev-helper backend's
  `GET /api/live/:id/status`, which forwards `@swalvo/server`'s
  `liveStreams.get()`.

## 10. Remaining limitations and exact next steps

Status since the previous pass: items 4 and 5 below are now **closed**;
item 1 is **closed for the commit, still open for the push**. Everything
else is unchanged or newly found.

1. ~~Commit `examples/flutter-sdk-test-app`, and the fixes to it~~ —
   **commit half closed this pass (§0a):** committed as `eb2260c`
   (app + `third_party/` patch) and `8f98131` (stale-comment fix),
   validated from a genuine second clone. **Still open: push to the
   remote.** Nothing was pushed this pass — `git push` is a visible,
   shared action this document's own instructions don't authorize on
   their own — so `flutter-ios.yml` still cannot be triggered via
   `gh workflow run` (§4.11's command), and GitHub's own CI runners have
   not executed either workflow against this app yet. Local validation
   (§0a) is strong evidence, not a substitute for that run.
2. **iOS: BLOCKED**, see §6 and `docs/sdk/flutter-ios-testing.md` for the
   two concrete paths (local Xcode, or trigger the prepared
   `workflow_dispatch` GitHub Actions workflow) and what each does and
   doesn't prove. The workflow itself was re-validated this pass (§4.11):
   one real job-control bug found and fixed, YAML confirmed syntactically
   valid against the real file, `gh auth status` confirms this
   environment *could* trigger it once pushed — but it was not pushed,
   and nothing here claims it ran.
3. **`flutter_webrtc` patch distribution**: documented, not executed this
   pass (`docs/sdk/flutter-webrtc-patch-distribution.md`) — republishing a
   renamed fork needs verification on iOS/macOS/Windows/Linux this
   environment cannot do, and a pub.dev publish credential this agent
   doesn't have. Not urgent today (`swalvo_rtc` isn't published yet) but
   becomes so the moment it is. The override that wires the local patch in
   is now also `.gitignore`d repo-wide (§4.10), closing the specific risk
   of it being committed by accident in the meantime.
4. ~~`swalvo_live` has no `join()`/`leave()` lifecycle test coverage at
   all~~ — **CLOSED this follow-up pass.** A minimal, reviewed,
   backward-compatible `@visibleForTesting` seam was added
   (`LiveStreamRoomCleanup`, `connectChatOrCleanUp` — see §3.3) and two
   regression tests now cover exactly the resource-leak bug fixed in the
   previous pass, both confirmed to fail without the fix and pass with it.
5. ~~Deliberate airplane-mode disconnect/reconnect on Android: not
   re-run~~ — **CLOSED this follow-up pass.** A real network cut
   (`adb shell svc wifi/data disable`, independently confirmed via `ping`
   and the emulator's own Calendar app's "No connection" banner) was run
   against both RTC and Chat simultaneously — see §2 scenario 10 for the
   full result, and §3.4's correction for an honest account of a
   previously-unverified claim this exact test exposed and then closed.
6. **Secure-context (HTTPS) and autoplay restrictions on Web**: not
   exercised (§5) — this pass only had `http://localhost` and no
   BROADCAST/HLS stream to test against.
7. **Physical Android and iOS device testing**: still genuinely
   unavailable to this agent in any configuration tried.

## 11. Commands to reproduce

```bash
# --- Mocked / automated (§1) ---
cd sdks/flutter/swalvo_rtc && flutter analyze && flutter test
cd sdks/flutter/swalvo_chat && flutter analyze && flutter test
cd sdks/flutter/swalvo_live && flutter analyze && flutter test
cd examples/flutter-sdk-test-app && flutter analyze --fatal-infos && flutter test
cd apps/api && npx jest --testPathPattern="modules/chat" && npx tsc --noEmit

# --- Real-backend, Android, two emulators (§2/§3.4) ---
cd examples/flutter-sdk-test-app
node server.mjs &                 # dev-helper backend, port 8792
flutter emulators --launch Pixel_10
flutter build apk --debug --dart-define=SWALVO_BACKEND_URL=http://10.0.2.2:8792
adb -s emulator-5554 install -r build/app/outputs/flutter-apk/app-debug.apk
# repeat install for a second, concurrently-booted emulator

# Emulator-only networking overrides (temporary; ALWAYS revert after —
# see §4.4):
#   .env: TURN_HOST, TURN_EXTERNAL_IP, API_PUBLIC_URL,
#         SFU_PUBLIC_HOST, SFU_PUBLIC_IP  →  10.0.2.2
docker compose up -d --no-deps api coturn sfu
# ... test ...
#   .env: revert all five lines above to localhost/127.0.0.1
docker compose up -d --no-deps api coturn sfu

# --- Flutter Web, real backend, headless Chromium (§5) ---
cd examples/flutter-sdk-test-app
node server.mjs &
flutter build web --dart-define=SWALVO_BACKEND_URL=http://localhost:8792
cd build/web && python3 -m http.server 8793 &
# Drive with Playwright (chromium.launch with
# --use-fake-device-for-media-stream --use-fake-ui-for-media-stream);
# see this pass's session for the exact scripts — not committed anywhere,
# written to scratch and discarded after use.

# --- iOS, once Xcode/a macOS CI runner is available (§6) ---
# See docs/sdk/flutter-ios-testing.md in full.
gh workflow run flutter-ios.yml   # after examples/flutter-sdk-test-app is committed
```
