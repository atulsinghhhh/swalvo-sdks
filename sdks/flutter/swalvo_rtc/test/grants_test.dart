// Live permission changes and server mutes on the engine
// (docs/architecture/phase1-contracts.md §1.4, §1.6).

import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/internal/engine.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';
import 'package:swalvo_rtc/src/types.dart';

import 'helpers/fake_socket.dart';
import 'helpers/fake_webrtc_platform.dart';

void main() {
  late FakeSocket socket;
  late FakeWebRtcPlatform platform;

  setUp(() => platform = FakeWebRtcPlatform());
  tearDown(() => platform.dispose());

  const allowed = SwalvoGrants(
    subscribe: true,
    publish: true,
    publishAudio: true,
    publishVideo: true,
    publishData: true,
  );

  Future<({SwalvoEngine engine, String pcId})> publishing() async {
    socket = FakeSocket();
    final signaling = SignalingClient(
      endpoint: 'ws://localhost:4000/v1/rtc',
      token: fakeToken({'rid': 'room-1', 'sub': 'alice'}),
      roomId: 'room-1',
      autoReconnect: false,
      socketFactory: (_) async => socket,
    );
    final engine = SwalvoEngine(
      signaling: signaling,
      iceServers: const [],
      adaptiveStream: false,
      localIdentity: 'alice',
      initialGrants: allowed,
    );
    engine.start();
    final joining = signaling.connect();
    await Future<void>.delayed(Duration.zero);
    socket.receive({
      'type': ServerMessageType.roomJoined,
      'roomId': 'room-1',
      'participants': const [],
    });
    await joining;
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    final pcId = platform.lastPeerConnectionId!;

    final camera = fakeLocalMedia(pcId, trackId: 'camera-track');
    await engine.publish(
        source: 'camera', stream: camera.stream, track: camera.track);
    final mic = fakeLocalMedia(pcId, trackId: 'mic-track', kind: 'audio');
    await engine.publish(
        source: 'microphone', stream: mic.stream, track: mic.track);
    return (engine: engine, pcId: pcId);
  }

  test('starts from the grants it was given', () async {
    final harness = await publishing();
    expect(harness.engine.grants?.publishVideo, isTrue);
    await harness.engine.dispose();
  });

  test('withdrawing video stops the camera, keeps the microphone, no error',
      () async {
    final harness = await publishing();
    final engine = harness.engine;
    final changes = <SwalvoGrants>[];
    final errors = <Object>[];
    final c = engine.grantChanges.listen(changes.add);
    final e = engine.errors.listen(errors.add);

    socket.receive({
      'type': ServerMessageType.participantPermissionsUpdated,
      'permissions': {
        'subscribe': true,
        'publish': true,
        'publishAudio': true,
        'publishVideo': false,
        'publishData': true,
      },
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(engine.publishedTrack('camera'), isNull);
    expect(engine.publishedTrack('microphone'), isNotNull);
    expect(changes.single.publishVideo, isFalse);
    expect(engine.grants?.publishVideo, isFalse);
    expect(errors, isEmpty);

    await c.cancel();
    await e.cancel();
    await engine.dispose();
  });

  test(
      'withdrawing screen share stops it independently of camera (agora-parity audit, phase 2)',
      () async {
    final harness = await publishing();
    final engine = harness.engine;
    final pcId = harness.pcId;
    final screen = fakeLocalMedia(pcId, trackId: 'screen-track');
    await engine.publish(
        source: 'screenShare', stream: screen.stream, track: screen.track);

    socket.receive({
      'type': ServerMessageType.participantPermissionsUpdated,
      'permissions': {
        'subscribe': true,
        'publish': true,
        'publishAudio': true,
        'publishVideo': true,
        'publishScreen': false,
        'publishData': true,
      },
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(engine.publishedTrack('screenShare'), isNull);
    expect(engine.publishedTrack('camera'), isNotNull);
    expect(engine.publishedTrack('microphone'), isNotNull);
    expect(engine.grants?.publishScreen, isFalse);
    expect(engine.grants?.publishVideo, isTrue);

    await engine.dispose();
  });

  test('a server mute of our own track mutes it locally', () async {
    final harness = await publishing();
    final engine = harness.engine;
    final mutes = <String>[];
    final m = engine.serverMutes.listen(mutes.add);

    socket.receive({
      'type': ServerMessageType.trackMuted,
      'participantId': 'alice',
      'trackId': 'mic-track',
      'byServer': true,
    });
    await Future<void>.delayed(Duration.zero);

    expect(mutes, ['microphone']);
    expect(engine.publishedTrack('microphone')!.muted, isTrue);
    expect(engine.publishedTrack('camera')!.muted, isFalse);

    await m.cancel();
    await engine.dispose();
  });

  test("ignores byServer on somebody else's track", () async {
    final harness = await publishing();
    final engine = harness.engine;
    final mutes = <String>[];
    final m = engine.serverMutes.listen(mutes.add);

    socket.receive({
      'type': ServerMessageType.trackMuted,
      'participantId': 'bob',
      'trackId': 'mic-track',
      'byServer': true,
    });
    await Future<void>.delayed(Duration.zero);

    expect(mutes, isEmpty);
    expect(engine.publishedTrack('microphone')!.muted, isFalse);

    await m.cancel();
    await engine.dispose();
  });
}
