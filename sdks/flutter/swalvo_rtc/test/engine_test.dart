import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/errors.dart';
import 'package:swalvo_rtc/src/internal/engine.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';

import 'helpers/fake_socket.dart';
import 'helpers/fake_webrtc_platform.dart';

void main() {
  late FakeSocket socket;
  late FakeWebRtcPlatform platform;

  setUp(() => platform = FakeWebRtcPlatform());
  tearDown(() => platform.dispose());

  SignalingClient clientFor({bool autoReconnect = false}) {
    socket = FakeSocket();
    return SignalingClient(
      endpoint: 'ws://localhost:4000/v1/rtc',
      token: fakeToken({'rid': 'room-1', 'sub': 'alice'}),
      roomId: 'room-1',
      autoReconnect: autoReconnect,
      socketFactory: (_) async => socket,
    );
  }

  Future<void> joinRoom(SignalingClient signaling,
      {List<Map<String, dynamic>>? participants}) async {
    final joining = signaling.connect();
    await Future<void>.delayed(Duration.zero);
    socket.receive({
      'type': ServerMessageType.roomJoined,
      'roomId': 'room-1',
      'participants': participants ?? const [],
    });
    await joining;
  }

  group('offer handling — the join-transition race (spec §3-4)', () {
    test(
        'an sdp.offer that arrives right after room.joined is answered when engine.start() runs before connect()',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);

      // The fix: subscribe before the join, exactly like SwalvoRoom.attach.
      engine.start();
      await joinRoom(signaling);

      // The SFU's very next message, same as the live trace in the bug
      // report: sdp.offer immediately after room.joined.
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      final answer = socket.lastSent(ClientMessageType.sdpAnswer);
      expect(answer, isNotNull,
          reason: 'the offer must be processed, not silently dropped');
      expect(answer!['sdp'], isNotEmpty);

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'REGRESSION: signaling.messages never loses an event a subscriber attached before connect() is listening for',
        () async {
      // Direct proof of the mechanism, independent of SwalvoEngine: a
      // broadcast stream delivers nothing to a listener that did not
      // exist yet when the event was added (see room_test.dart's twin
      // test for signaling.joins, which is the deterministic half of
      // this same class of bug).
      final signaling = clientFor();
      final received = <Map<String, dynamic>>[];
      signaling.messages.listen(received.add);

      await joinRoom(signaling);
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(1));
      expect(received.single['type'], ServerMessageType.sdpOffer);
      await signaling.dispose();
    });
  });

  group('publish negotiation — the state machine (spec §9)', () {
    test(
        'a publish attempted while the peer connection is mid-round defers instead of racing the server',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);

      // The SFU offers first, establishing the peer connection.
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(socket.lastSent(ClientMessageType.sdpAnswer), isNotNull);

      final pcId = platform.lastPeerConnectionId!;
      final media = fakeLocalMedia(pcId);

      // The connection settled after the first offer/answer above — a
      // publish() here would legitimately be free to offer immediately.
      // Force it back into a genuinely-mid-round state (the SFU's next
      // offer, still unanswered) so this test actually exercises the
      // defer branch instead of a publish that's free to go.
      await platform.signalingState(pcId, 'have-remote-offer');

      await engine.publish(
          source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);

      expect(
        socket.sent.where((m) => m['type'] == ClientMessageType.sdpOffer),
        isEmpty,
        reason:
            'must defer rather than offer while a round could still be in flight',
      );

      // The connection settles...
      await platform.signalingState(pcId, 'stable');
      // ...and the SFU's next offer is what actually flushes the queue
      // (see _handleOffer -> _flushDeferredPublishes), exactly as the
      // adapter's own doc comment describes.
      socket
          .receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer 2'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(
        socket.sent.where((m) => m['type'] == ClientMessageType.sdpOffer),
        isNotEmpty,
        reason: 'the queued publish negotiation must flush once the round ends',
      );

      await engine.dispose();
      await signaling.dispose();
    });
  });

  group('glare recovery — the SFU is the impolite peer (spec §9)', () {
    // Shared setup for every test below: join, let the SFU's join-time
    // offer establish the peer connection, and report the round settled
    // (`stable`) so a subsequent publish() offers immediately instead of
    // deferring — exactly the "the platform side finally caught up" state
    // real devices/browsers report between rounds.
    Future<String> establishPeerConnection(SignalingClient signaling) async {
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(socket.lastSent(ClientMessageType.sdpAnswer), isNotNull);

      final pcId = platform.lastPeerConnectionId!;
      await platform.signalingState(pcId, 'stable');
      return pcId;
    }

    test(
        'Test A — an SFU offer that arrives while our own offer is outstanding rolls our offer back before answering',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      final pcId = await establishPeerConnection(signaling);

      final media = fakeLocalMedia(pcId);
      await engine.publish(
          source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);
      expect(
        socket.sent.where((m) => m['type'] == ClientMessageType.sdpOffer),
        isNotEmpty,
        reason:
            'the fresh camera transceiver must offer immediately: the connection was stable',
      );
      final answersBefore = socket.sent
          .where((m) => m['type'] == ClientMessageType.sdpAnswer)
          .length;

      // The native/browser side now reports what setLocalDescription(offer)
      // actually did: our own offer is outstanding. Real glare follows —
      // the SFU's own offer lands in the same window.
      await platform.signalingState(pcId, 'have-local-offer');
      socket.receive(
          {'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 sfu-offer-2'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(
        platform.localDescriptionTypes,
        contains('rollback'),
        reason:
            'our outstanding offer must be rolled back, not left for setRemoteDescription to choke on',
      );
      expect(
        socket.sent
            .where((m) => m['type'] == ClientMessageType.sdpAnswer)
            .length,
        greaterThan(answersBefore),
        reason:
            "the SFU's offer must still be answered — glare is not a reason to stop responding to it",
      );

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'Test B — NEGOTIATION_GLARE does not drop the publish; it is requeued and retried',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      final pcId = await establishPeerConnection(signaling);

      final media = fakeLocalMedia(pcId);
      await engine.publish(
          source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);
      final offersBefore = socket.sent
          .where((m) => m['type'] == ClientMessageType.sdpOffer)
          .length;
      expect(offersBefore, greaterThan(0),
          reason: 'camera offer must have gone out first');

      final errors = <SwalvoException>[];
      engine.errors.listen(errors.add);

      // The server refuses our offer: its own is already on the way.
      socket.receive({
        'type': ServerMessageType.error,
        'code': SignalingErrorCode.negotiationGlare,
        'message':
            'an offer from the server is already in flight; answer it, then retry',
      });
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // Glare must never surface as a failed/lost publish.
      expect(errors, isEmpty,
          reason: 'NEGOTIATION_GLARE is expected protocol, not a media error');

      // The SFU's own offer — the one glare made way for — now arrives,
      // and the round settles.
      await platform.signalingState(pcId, 'have-local-offer');
      await platform.signalingState(pcId, 'stable');
      socket.receive(
          {'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 sfu-offer-2'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(
        socket.sent
            .where((m) => m['type'] == ClientMessageType.sdpOffer)
            .length,
        greaterThan(offersBefore),
        reason:
            'the glared publish must retry once the round it lost to completes, not vanish silently',
      );

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'Test C — a publish deferred behind our own outstanding offer retries once that offer is answered',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      final pcId = await establishPeerConnection(signaling);

      // Camera publishes first: the connection is stable, so its offer
      // goes out immediately.
      final camera =
          fakeLocalMedia(pcId, trackId: 'camera-track', kind: 'video');
      await engine.publish(
          source: 'camera', stream: camera.stream, track: camera.track);
      await Future<void>.delayed(Duration.zero);
      final offersAfterCamera = socket.sent
          .where((m) => m['type'] == ClientMessageType.sdpOffer)
          .length;
      expect(offersAfterCamera, greaterThan(0));

      // The native/browser side reports the camera offer outstanding —
      // exactly the window main_live_host.dart's back-to-back
      // enableCamera(); enableMicrophone(); can land microphone in.
      await platform.signalingState(pcId, 'have-local-offer');

      final mic = fakeLocalMedia(pcId, trackId: 'mic-track', kind: 'audio');
      await engine.publish(
          source: 'microphone', stream: mic.stream, track: mic.track);
      await Future<void>.delayed(Duration.zero);

      expect(
        socket.sent
            .where((m) => m['type'] == ClientMessageType.sdpOffer)
            .length,
        offersAfterCamera,
        reason:
            'microphone must defer rather than race the camera offer still outstanding',
      );

      // The SFU plainly answers the camera offer — no glare this time.
      await platform.signalingState(pcId, 'stable');
      socket
          .receive({'type': ServerMessageType.sdpAnswer, 'sdp': 'v=0 answer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(
        socket.sent
            .where((m) => m['type'] == ClientMessageType.sdpOffer)
            .length,
        greaterThan(offersAfterCamera),
        reason:
            '_handleAnswer must flush the deferred microphone negotiation, not only _handleOffer',
      );

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'Test D — full sequence: publish, glare, rollback, SFU offer answered, retry accepted, track stays negotiated',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      final pcId = await establishPeerConnection(signaling);

      final media = fakeLocalMedia(pcId);
      final published = await engine.publish(
          source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);
      expect(socket.sent.where((m) => m['type'] == ClientMessageType.sdpOffer),
          isNotEmpty);

      final errors = <SwalvoException>[];
      engine.errors.listen(errors.add);

      // Glare: the SFU refuses our camera offer.
      await platform.signalingState(pcId, 'have-local-offer');
      socket.receive({
        'type': ServerMessageType.error,
        'code': SignalingErrorCode.negotiationGlare,
        'message': 'glare',
      });
      await Future<void>.delayed(Duration.zero);

      // ...and its own offer — the one that caused the glare — arrives
      // right behind it. This must roll our offer back and answer.
      socket.receive(
          {'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 sfu-offer-2'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(platform.localDescriptionTypes, contains('rollback'));

      // The round settles; the retried camera negotiation goes out and the
      // SFU accepts it.
      await platform.signalingState(pcId, 'stable');
      await Future<void>.delayed(Duration.zero);
      final offersAfterRound2 = socket.sent
          .where((m) => m['type'] == ClientMessageType.sdpOffer)
          .length;
      // Nudge the queue again in case the first flush attempt landed
      // before the native side reported `stable` (see establishPeerConnection).
      socket.receive(
          {'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 sfu-offer-3'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await platform.signalingState(pcId, 'stable');

      final retried = socket.sent
          .where((m) => m['type'] == ClientMessageType.sdpOffer)
          .toList();
      expect(retried.length, greaterThan(offersAfterRound2 - 1),
          reason:
              'the camera publish must have retried at least once after the glared round settled');

      socket.receive(
          {'type': ServerMessageType.sdpAnswer, 'sdp': 'v=0 final-answer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(errors, isEmpty,
          reason:
              'the whole glare/rollback/retry sequence must never surface as a media error');
      expect(
        engine.publishedTracks.map((t) => t.source),
        contains('camera'),
        reason:
            'the camera stays a locally published track throughout — publish() itself never failed',
      );
      expect(published.source, 'camera');

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'Test E (production failure) — glare recovers off its own response when the SFU never sends anything else, not after a 15s wait',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      final pcId = await establishPeerConnection(signaling);

      final media = fakeLocalMedia(pcId);
      final published = await engine.publish(
          source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);
      final offersBefore = socket.sent
          .where((m) => m['type'] == ClientMessageType.sdpOffer)
          .length;
      expect(offersBefore, greaterThan(0),
          reason: 'camera offer must have gone out first');

      final errors = <SwalvoException>[];
      engine.errors.listen(errors.add);

      // The native side now reports what our own setLocalDescription(offer)
      // actually did.
      await platform.signalingState(pcId, 'have-local-offer');

      // The server refuses it: its own join-time offer is still in flight
      // from *its* point of view. Unlike Tests B/D, nothing else is ever
      // delivered after this line — no SFU offer, no answer, nothing. This
      // is the production failure verbatim: services/sfu's own
      // AcceptAnswer for our join-time answer stalled for the full 15s
      // answerTimeout, with no other signaling event to flush the deferred
      // publish against in the meantime.
      socket.receive({
        'type': ServerMessageType.error,
        'code': SignalingErrorCode.negotiationGlare,
        'message':
            'an offer from the server is already in flight; answer it, then retry',
      });

      // Only microtask-flushing delays below — no `fakeAsync`, no
      // `async.elapse`, no real Duration longer than zero. If recovery
      // needed the SFU's 15s answerTimeout, none of the assertions past
      // this point could pass.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(
        platform.localDescriptionTypes,
        contains('rollback'),
        reason:
            'the glared offer must be rolled back locally before anything retries on top of it',
      );

      expect(
        socket.sent
            .where((m) => m['type'] == ClientMessageType.sdpOffer)
            .length,
        greaterThan(offersBefore),
        reason:
            'the deferred publish must retry off the glare response itself — '
            'nothing else was ever going to arrive to flush it',
      );

      expect(errors, isEmpty,
          reason:
              'glare and its immediate, bounded retry must never surface as a media error');

      // The publication itself was never lost, only its negotiation.
      expect(engine.publishedTracks.map((t) => t.source), contains('camera'));
      expect(published.source, 'camera');

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'Test F — a single glare-triggered retry does not loop: a second glare on the retry falls back to waiting for a real round trip',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      final pcId = await establishPeerConnection(signaling);

      final media = fakeLocalMedia(pcId);
      await engine.publish(
          source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);

      final errors = <SwalvoException>[];
      engine.errors.listen(errors.add);

      // First glare: the bounded immediate retry fires.
      await platform.signalingState(pcId, 'have-local-offer');
      socket.receive({
        'type': ServerMessageType.error,
        'code': SignalingErrorCode.negotiationGlare,
        'message': 'glare',
      });
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      final offersAfterFirstGlare = socket.sent
          .where((m) => m['type'] == ClientMessageType.sdpOffer)
          .length;
      expect(offersAfterFirstGlare, greaterThan(0),
          reason: 'the first glare must trigger exactly one retry offer');

      // The retry glares too — the server is still stuck. This must not
      // trigger a second immediate retry (the connection's own message
      // rate limit, and packages/sdk's own documented history of a
      // 48-round offer/rollback storm, is exactly what an unbounded loop
      // here would reproduce).
      await platform.signalingState(pcId, 'have-local-offer');
      socket.receive({
        'type': ServerMessageType.error,
        'code': SignalingErrorCode.negotiationGlare,
        'message': 'glare',
      });
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(
        socket.sent
            .where((m) => m['type'] == ClientMessageType.sdpOffer)
            .length,
        offersAfterFirstGlare,
        reason: 'a glare on the retry itself must not spend a second immediate '
            'attempt — it falls back to waiting for _handleOffer/_handleAnswer',
      );

      // A real round trip — the SFU's own offer finally arriving — earns
      // a fresh attempt and this is what actually resolves it.
      await platform.signalingState(pcId, 'stable');
      socket.receive(
          {'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 sfu-offer-3'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(
        socket.sent
            .where((m) => m['type'] == ClientMessageType.sdpOffer)
            .length,
        greaterThan(offersAfterFirstGlare),
        reason:
            'once a real offer/answer round completes, the publish must retry again',
      );
      expect(errors, isEmpty);

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'a published local track is available and notified immediately, before the SFU negotiation round trip resolves',
        () async {
      // External report: the local self-preview tile stayed on its
      // placeholder while the remote tile rendered fine, because
      // enableCamera() only told the UI about the new local track after
      // publish() fully resolved — which waits on a full SFU offer/answer
      // round trip the local preview doesn't actually depend on.
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      unawaited(engine.ensureDataChannel());
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      final pcId = platform.lastPeerConnectionId!;

      var notified = false;
      final sub = engine.changes.listen((_) => notified = true);

      final media = fakeLocalMedia(pcId);
      final publishing = engine.publish(
          source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);

      // The SFU's join-time offer has not arrived yet — publish() itself
      // cannot have resolved — but the local track must already be
      // queryable and a change already notified, since a self-preview
      // never depends on the far end of a negotiation it hasn't finished.
      expect(engine.publishedTrack('camera'), isNotNull);
      expect(notified, isTrue);

      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await platform.signalingState(pcId, 'stable');
      await publishing.timeout(const Duration(seconds: 2));

      await sub.cancel();
      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'Test G — publish() called before the SFU\'s initial offer arrives waits for it instead of racing it',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);

      // A peer connection has to exist to hand a track to, but creating
      // one is not what's under test here — ensureDataChannel() gates its
      // own negotiation behind the same [_initialOfferHandled] barrier
      // publish() does, so calling it now only forces a peer connection
      // into existence; it will not race the SFU's join-time offer either.
      unawaited(engine.ensureDataChannel());
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      final pcId = platform.lastPeerConnectionId!;

      // publish() called immediately after joining — before the SFU's own
      // join-time offer has even arrived, let alone been answered. This is
      // main_live_host.dart's enableCamera() called right after
      // SwalvoLiveStream.join() resolves.
      final media = fakeLocalMedia(pcId);
      final publishing = engine.publish(
          source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(
        socket.sent.where((m) => m['type'] == ClientMessageType.sdpOffer),
        isEmpty,
        reason:
            'nothing must be offered before the SFU\'s own join-time offer has been answered',
      );

      // Now the SFU's initial offer arrives and gets answered.
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(socket.lastSent(ClientMessageType.sdpAnswer), isNotNull);

      await platform.signalingState(pcId, 'stable');
      await publishing.timeout(const Duration(seconds: 2));
      await Future<void>.delayed(Duration.zero);

      expect(
        socket.sent.where((m) => m['type'] == ClientMessageType.sdpOffer),
        isNotEmpty,
        reason:
            'only once the join-offer is answered may the publish negotiation begin',
      );

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'Test H — the initial-offer barrier only gates the very first offer of a generation, never a later publish',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      final pcId = await establishPeerConnection(signaling);

      final camera =
          fakeLocalMedia(pcId, trackId: 'camera-track', kind: 'video');
      await engine
          .publish(source: 'camera', stream: camera.stream, track: camera.track)
          .timeout(const Duration(seconds: 2));
      final offersAfterCamera = socket.sent
          .where((m) => m['type'] == ClientMessageType.sdpOffer)
          .length;
      expect(offersAfterCamera, greaterThan(0));

      // Let the camera's own offer settle before publishing the
      // microphone, so this exercises the initial-offer barrier
      // specifically — not the pre-existing "defer behind our own
      // outstanding offer" path Test C already covers.
      await platform.signalingState(pcId, 'stable');

      final mic = fakeLocalMedia(pcId, trackId: 'mic-track', kind: 'audio');
      await engine
          .publish(source: 'microphone', stream: mic.stream, track: mic.track)
          .timeout(const Duration(seconds: 2));

      expect(
        socket.sent
            .where((m) => m['type'] == ClientMessageType.sdpOffer)
            .length,
        greaterThan(offersAfterCamera),
        reason:
            'the barrier must already be satisfied for every publish after the first',
      );

      await engine.dispose();
      await signaling.dispose();
    });
  });

  group('peer connection creation — concurrent callers (spec §3)', () {
    test(
        'a local publish racing an incoming SFU offer for the very first peer connection share one, not two',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);

      // Two things that both need a peer connection to exist, fired
      // without awaiting either first: exactly the shape of the race a
      // participant hits joining an already-live room and publishing
      // right away — the SFU's join-time offer and this device's own
      // publish both reach _ensurePeerConnection() before either has
      // finished creating one.
      final ensuring = engine.ensureDataChannel();
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});

      await ensuring;
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(
        platform.calls.where((call) => call == 'createPeerConnection').length,
        1,
        reason:
            'concurrent callers must share one peer connection, not silently create and orphan a second',
      );

      await engine.dispose();
      await signaling.dispose();
    });
  });

  group('sendData — data-channel negotiation (spec §7)', () {
    test(
        'a payload sent before the channel opens is queued and delivered once it does, never dropped',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      final pcId = platform.lastPeerConnectionId!;

      var sent = false;
      final sending = engine.sendData([1, 2, 3]).then((_) => sent = true);

      // Not sent yet: createDataChannel resolved, but nothing has told
      // the engine the channel is open.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(sent, isFalse,
          reason:
              'must wait for the channel, not send into one that may not be open');

      await platform.openDataChannel(pcId);
      await sending.timeout(const Duration(seconds: 2));

      expect(sent, isTrue);
      expect(platform.calls, contains('dataChannelSend'));

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'sendData() times out with a SwalvoException instead of hanging forever if the channel never opens',
        () async {
      // Deliberately never calls platform.openDataChannel: this is the
      // field report's scenario — negotiation never actually completes,
      // so nothing ever tells the engine the channel opened, and the old
      // behavior was to wait on a bare Completer forever.
      Object? caught;
      var settled = false;
      late SignalingClient signaling;
      late SwalvoEngine engine;

      fakeAsync((async) {
        // Everything — construction included — has to happen inside this
        // one fakeAsync zone. SwalvoEngine's `_negotiationChain` starts out
        // as an already-completed `Future<void>.value()` set at
        // construction time; a Future completed in one zone never notifies
        // a `.then()`/`await` registered from a different zone (a
        // documented fake_async/Dart-Future interaction, reproduced in
        // isolation while narrowing this test down), so building the
        // engine outside this zone would silently wedge every negotiation
        // — including the one ensureDataChannel() now kicks off — forever.
        signaling = clientFor();
        engine = SwalvoEngine(
            signaling: signaling, iceServers: const [], adaptiveStream: false);
        engine.start();
        unawaited(signaling.connect());
        // A few milliseconds of margin, not zero: createPeerConnection's
        // own fake platform delay is a real (faked) Timer, and each hop
        // through it plus the several chained MethodChannel round trips
        // this drives needs elapsed time to actually fire.
        async.elapse(const Duration(milliseconds: 10));
        socket.receive({
          'type': ServerMessageType.roomJoined,
          'roomId': 'room-1',
          'participants': const [],
        });
        async.elapse(const Duration(milliseconds: 10));
        socket
            .receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
        async.elapse(const Duration(milliseconds: 10));
        expect(socket.lastSent(ClientMessageType.sdpAnswer), isNotNull,
            reason: 'setup: the join-time offer must be answered before '
                'sendData() is exercised');

        unawaited(engine.sendData([1, 2, 3]).then(
          (_) => settled = true,
          onError: (Object error) {
            caught = error;
            settled = true;
          },
        ));
        async.elapse(const Duration(milliseconds: 10));

        async.elapse(const Duration(seconds: 14));
        expect(settled, isFalse,
            reason: 'must not time out before the documented deadline');

        async.elapse(const Duration(seconds: 2));
      });

      expect(settled, isTrue,
          reason:
              'sendData() must settle, not hang forever, once the channel never opens');
      expect(caught, isA<SwalvoException>());
      expect((caught as SwalvoException).code, SwalvoErrorCode.timeout);

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'ensureDataChannel opens a channel for a receive-only participant who never publishes or sends',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(platform.calls, isNot(contains('createDataChannel')));

      await engine.ensureDataChannel();

      expect(platform.calls, contains('createDataChannel'));

      // The regression this test now also covers: creating a data channel
      // has to negotiate it, or a participant who never publishes anything
      // sits with a channel the SFU was never told to expect (spec §18) —
      // see ensureDataChannel()'s own doc comment. Before this offer, this
      // participant has no track and never published, so this is the only
      // negotiation round that could have produced it.
      expect(
        socket.sent.where((m) => m['type'] == ClientMessageType.sdpOffer),
        isNotEmpty,
        reason: 'ensureDataChannel() must negotiate the channel it just '
            'created, not merely create it locally and rely on some other '
            'publish to carry it along',
      );

      await engine.dispose();
      await signaling.dispose();
    });

    test(
        'sendData() waiters are aborted, not left hanging, once signaling fails terminally',
        () async {
      final signaling = clientFor(autoReconnect: false);
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      engine.start();
      await joinRoom(signaling);
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      final sending = engine.sendData([9]);
      // Attached immediately: an error a Future completes with before
      // anything is listening is reported as unhandled by the zone, even
      // if something awaits it a turn later.
      final expectation = expectLater(sending, throwsA(anything));
      await Future<void>.delayed(Duration.zero);

      socket.drop(1006); // ordinary drop, autoReconnect off -> failed
      await Future<void>.delayed(Duration.zero);

      await expectation;

      await engine.dispose();
      await signaling.dispose();
    });
  });
}
