import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/internal/engine.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';
import 'package:swalvo_rtc/src/types.dart';

import 'helpers/fake_socket.dart';
import 'helpers/fake_webrtc_platform.dart';

/// Simulcast publishing, and the layer-preference rules that depend on it.
///
/// # What went wrong before, and what these assert on instead
///
/// The previous implementation called `addTrack()` and then tried to attach
/// three encodings with `setParameters()`. That cannot work: the WebRTC
/// specification requires `setParameters` to reject a change to the number
/// of encodings, and RIDs only reach the SDP when they were present before
/// the offer was generated. The error was caught and discarded, so every
/// publisher sent one full-resolution layer while the SDK believed it was
/// sending three.
///
/// The test that should have caught it could not: the fake platform
/// returned an empty `encodings` list, which sent `_applySimulcast` down an
/// early return before it ever tried. So these tests deliberately assert on
/// two things the broken version could not have faked:
///
/// 1. the `sendEncodings` payload that genuinely crossed the platform
///    channel towards native code, and
/// 2. the `a=simulcast:send` / `a=rid:` lines in the generated offer.
///
/// An encodings list in Dart memory is not evidence. It is exactly what the
/// broken implementation had.
void main() {
  late FakeSocket socket;
  late FakeWebRtcPlatform platform;

  setUp(() => platform = FakeWebRtcPlatform());
  tearDown(() => platform.dispose());

  SignalingClient clientFor() {
    socket = FakeSocket();
    return SignalingClient(
      endpoint: 'ws://localhost:4000/v1/rtc',
      token: fakeToken({'rid': 'room-1', 'sub': 'alice'}),
      roomId: 'room-1',
      autoReconnect: false,
      socketFactory: (_) async => socket,
    );
  }

  Future<void> joinRoom(SignalingClient signaling) async {
    final joining = signaling.connect();
    await Future<void>.delayed(Duration.zero);
    socket.receive({
      'type': ServerMessageType.roomJoined,
      'roomId': 'room-1',
      'participants': const [],
    });
    await joining;
  }

  /// Brings an engine up to the point where a publish can negotiate.
  Future<({SwalvoEngine engine, SignalingClient signaling, String pcId})>
      connectedEngine({bool adaptiveStream = true}) async {
    final signaling = clientFor();
    final engine = SwalvoEngine(
      signaling: signaling,
      iceServers: const [],
      adaptiveStream: adaptiveStream,
    );
    engine.start();
    await joinRoom(signaling);

    // The SFU offers first; answering it releases publish()'s barrier.
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    return (
      engine: engine,
      signaling: signaling,
      pcId: platform.lastPeerConnectionId!,
    );
  }

  group('publishing a simulcast ladder', () {
    test('a camera is published through a transceiver carrying three RIDs',
        () async {
      final harness = await connectedEngine();
      final media = fakeLocalMedia(harness.pcId, trackId: 'camera-track');

      await harness.engine
          .publish(source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);

      expect(
        platform.calls,
        contains('addTransceiver'),
        reason: 'the ladder can only be declared when the transceiver is '
            'created; addTrack produces a sender with one fixed encoding',
      );
      expect(
        platform.calls,
        isNot(contains('addTrack')),
        reason: 'falling back to addTrack means no simulcast at all',
      );

      expect(platform.transceiverInits, hasLength(1));
      final encodings =
          (platform.transceiverInits.single['sendEncodings'] as List)
              .cast<Map<dynamic, dynamic>>();

      expect(encodings.map((e) => e['rid']), ['low', 'medium', 'high']);

      // Asserted field by field, because these are the exact values
      // PeerConnectionObserver.mapToEncoding reads on Android and
      // FlutterWebRTCPlugin's mapToEncoding reads on iOS. A ladder with
      // the right RIDs and the wrong bitrates would still collapse a call.
      expect(encodings[0]['scaleResolutionDownBy'], 4.0);
      expect(encodings[0]['maxBitrate'], 150000);
      expect(encodings[0]['maxFramerate'], 15);

      expect(encodings[1]['scaleResolutionDownBy'], 2.0);
      expect(encodings[1]['maxBitrate'], 500000);
      expect(encodings[1]['maxFramerate'], 30);

      expect(encodings[2]['scaleResolutionDownBy'], 1.0);
      expect(encodings[2]['maxBitrate'], 1500000);
      expect(encodings[2]['maxFramerate'], 30);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('the offer that goes to the SFU declares the simulcast layers',
        () async {
      final harness = await connectedEngine();
      final media = fakeLocalMedia(harness.pcId, trackId: 'camera-track');

      await harness.engine
          .publish(source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);

      final offer = socket.lastSent(ClientMessageType.sdpOffer);
      expect(offer, isNotNull, reason: 'publishing must renegotiate');

      final sdp = offer!['sdp'] as String;

      // The SFU reads exactly these lines. `a=simulcast:send` is what makes
      // it answer `a=simulcast:recv`, and the RIDs are what arrive in the
      // per-packet header extension that
      // services/sfu/internal/room/downtrack.go maps onto its layer names.
      expect(sdp, contains('a=simulcast:send low;medium;high'));
      expect(sdp, contains('a=rid:low send'));
      expect(sdp, contains('a=rid:medium send'));
      expect(sdp, contains('a=rid:high send'));

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('the publication reports simulcast as genuinely enabled', () async {
      final harness = await connectedEngine();
      final media = fakeLocalMedia(harness.pcId, trackId: 'camera-track');

      await harness.engine
          .publish(source: 'camera', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);

      // Read back from the sender's negotiated parameters, not from what
      // was asked for. That distinction is the entire point: the broken
      // implementation would have reported "enabled" on what it requested.
      expect(
        harness.engine.simulcastStatusFor('camera'),
        SwalvoSimulcastStatus.enabled,
      );

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('a microphone is published without a ladder, through addTrack',
        () async {
      final harness = await connectedEngine();
      final media =
          fakeLocalMedia(harness.pcId, trackId: 'mic-track', kind: 'audio');

      await harness.engine.publish(
          source: 'microphone', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);

      expect(platform.calls, contains('addTrack'));
      expect(platform.transceiverInits, isEmpty,
          reason: 'audio has no spatial layers to send');
      expect(
        harness.engine.simulcastStatusFor('microphone'),
        SwalvoSimulcastStatus.notApplicable,
      );

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('a screen share deliberately sends one high-quality layer', () async {
      final harness = await connectedEngine();
      final media = fakeLocalMedia(harness.pcId, trackId: 'screen-track');

      await harness.engine.publish(
          source: 'screenShare', stream: media.stream, track: media.track);
      await Future<void>.delayed(Duration.zero);

      // Not an oversight. Screen content is usually text, and dropping
      // resolution wrecks legibility in a way it never does for a face.
      expect(platform.transceiverInits, isEmpty);
      expect(
        harness.engine.simulcastStatusFor('screenShare'),
        SwalvoSimulcastStatus.notApplicable,
      );

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test(
        'republishing a camera stops the old transceiver and gives it a fresh one',
        () async {
      final harness = await connectedEngine();

      final first = fakeLocalMedia(harness.pcId, trackId: 'camera-1');
      await harness.engine
          .publish(source: 'camera', stream: first.stream, track: first.track);
      await Future<void>.delayed(Duration.zero);

      await harness.engine.unpublish('camera');
      await Future<void>.delayed(Duration.zero);

      final second = fakeLocalMedia(harness.pcId, trackId: 'camera-2');
      await harness.engine.publish(
          source: 'camera', stream: second.stream, track: second.track);
      await Future<void>.delayed(Duration.zero);

      // Reviving the old transceiver with replaceTrack kept its SSRCs and
      // msid, so the SFU never saw a new track and subscribers lost the
      // camera. The old one is stopped (a real platform recycles its
      // m-section) and the second publish gets a fresh ladder.
      expect(platform.stoppedTransceivers, hasLength(1),
          reason: 'unpublish must stop the simulcast transceiver');
      expect(platform.transceiverInits, hasLength(2),
          reason: 'the second publish must get a fresh transceiver');
      expect(platform.replacedTracks, isNot(contains('camera-2')));

      // And it is still a real ladder.
      expect(
        harness.engine.simulcastStatusFor('camera'),
        SwalvoSimulcastStatus.enabled,
      );

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });
  });

  group('layer preference precedence (adaptiveStream vs explicit)', () {
    test('an automatic request is ignored once the application pins a layer',
        () async {
      final harness = await connectedEngine();

      // The application pins `high` — a spotlighted speaker, say.
      harness.engine.requestLayer('bob', 'bob-video', 'high');
      await Future<void>.delayed(Duration.zero);

      // Adaptive streaming then measures a small tile and wants `low`.
      harness.engine.requestLayer('bob', 'bob-video', 'low', automatic: true);
      await Future<void>.delayed(Duration.zero);

      final requests = socket.sent
          .where((m) => m['type'] == ClientMessageType.subscriptionUpdate)
          .toList();
      expect(requests, hasLength(1),
          reason: 'adaptive streaming must not undo an explicit choice');
      expect(requests.single['layer'], 'high');
      expect(harness.engine.pinnedLayer('bob', 'bob-video'), 'high');

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('requesting auto releases the pin and hands the track back', () async {
      final harness = await connectedEngine();

      harness.engine.requestLayer('bob', 'bob-video', 'high');
      harness.engine.requestLayer('bob', 'bob-video', 'auto');
      await Future<void>.delayed(Duration.zero);

      expect(harness.engine.pinnedLayer('bob', 'bob-video'), isNull);

      harness.engine.requestLayer('bob', 'bob-video', 'low', automatic: true);
      await Future<void>.delayed(Duration.zero);

      final layers = socket.sent
          .where((m) => m['type'] == ClientMessageType.subscriptionUpdate)
          .map((m) => m['layer'])
          .toList();
      expect(layers, ['high', 'auto', 'low']);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('an explicit request still works with adaptiveStream off', () async {
      final harness = await connectedEngine(adaptiveStream: false);

      harness.engine.requestLayer('bob', 'bob-video', 'low');
      await Future<void>.delayed(Duration.zero);

      // This used to be dropped: the guard tested `adaptiveStream` before
      // deciding whether to send anything at all, so "I will manage quality
      // myself" was the one combination that could not work.
      final request = socket.lastSent(ClientMessageType.subscriptionUpdate);
      expect(request, isNotNull);
      expect(request!['layer'], 'low');

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('automatic requests are dropped entirely when adaptiveStream is off',
        () async {
      final harness = await connectedEngine(adaptiveStream: false);

      harness.engine.requestLayer('bob', 'bob-video', 'low', automatic: true);
      await Future<void>.delayed(Duration.zero);

      expect(socket.lastSent(ClientMessageType.subscriptionUpdate), isNull);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('a repeated request for the same layer is not re-sent', () async {
      final harness = await connectedEngine();

      for (var i = 0; i < 5; i++) {
        harness.engine
            .requestLayer('bob', 'bob-video', 'medium', automatic: true);
      }
      await Future<void>.delayed(Duration.zero);

      // A tile being laid out repeatedly at the same size is the normal
      // case. Every redundant message is one step closer to the
      // connection's rate limit and buys nothing.
      expect(
        socket.sent
            .where((m) => m['type'] == ClientMessageType.subscriptionUpdate),
        hasLength(1),
      );

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });
  });
}
