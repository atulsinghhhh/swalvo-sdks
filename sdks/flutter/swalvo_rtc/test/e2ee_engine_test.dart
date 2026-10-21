import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;
import 'package:swalvo_rtc/src/e2ee.dart';
import 'package:swalvo_rtc/src/errors.dart';
import 'package:swalvo_rtc/src/internal/e2ee_controller.dart';
import 'package:swalvo_rtc/src/internal/e2ee_crypto.dart';
import 'package:swalvo_rtc/src/internal/engine.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';
import 'package:swalvo_rtc/src/types.dart';

import 'helpers/fake_socket.dart';
import 'helpers/fake_webrtc_platform.dart';

/// Phase 5 in the engine: the E2EE gate, FrameCryptor wiring with the
/// shared key schedule, RED and the camera codec / SVC.
void main() {
  late FakeSocket socket;
  late FakeWebRtcPlatform platform;

  setUp(() => platform = FakeWebRtcPlatform());
  tearDown(() => platform.dispose());

  Future<({SwalvoEngine engine, SignalingClient signaling, String pcId})>
      connected({
    E2EEController? e2ee,
    bool e2eeUnsupported = false,
    bool roomE2EE = false,
    bool audioRed = true,
    String? videoCodec,
  }) async {
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
      e2ee: e2ee,
      e2eeUnsupported: e2eeUnsupported,
      roomId: 'room_e2ee_vectors',
      audioRed: audioRed,
      videoCodec: videoCodec,
    );
    engine.start();
    final joining = signaling.connect();
    await Future<void>.delayed(Duration.zero);
    socket.receive({
      'type': ServerMessageType.roomJoined,
      'roomId': 'room-1',
      'participants': const [],
      if (roomE2EE) 'e2ee': true,
    });
    final joined = await joining;
    engine.applyJoinedState(joined);
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    return (
      engine: engine,
      signaling: signaling,
      pcId: platform.lastPeerConnectionId!
    );
  }

  Future<void> settle() async {
    for (var i = 0; i < 5; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  group('E2EE gate', () {
    test('room.joined e2ee without a key provider refuses to publish',
        () async {
      final h = await connected(roomE2EE: true);
      expect(h.engine.roomRequiresE2EE, isTrue);
      expect(h.engine.isE2EEActive, isFalse);
      final media = fakeLocalMedia(h.pcId);
      await expectLater(
        h.engine.publish(
            source: 'microphone', stream: media.stream, track: media.track),
        throwsA(isA<SwalvoException>()
            .having((e) => e.code, 'code', SwalvoErrorCode.e2eeRequired)),
      );
      expect(platform.calls, isNot(contains('addTrack')));
      await h.engine.dispose();
      await h.signaling.dispose();
    });

    test('web (no frame cryptor) says e2eeNotSupported', () async {
      final h = await connected(roomE2EE: true, e2eeUnsupported: true);
      expect(
          () => h.engine.assertMayPublish(),
          throwsA(isA<SwalvoException>().having(
              (e) => e.code, 'code', SwalvoErrorCode.e2eeNotSupported)));
      await h.engine.dispose();
      await h.signaling.dispose();
    });

    test('an ordinary room publishes as before', () async {
      final h = await connected();
      final media = fakeLocalMedia(h.pcId);
      await h.engine.publish(
          source: 'microphone', stream: media.stream, track: media.track);
      expect(platform.calls, contains('addTrack'));
      await h.engine.dispose();
      await h.signaling.dispose();
    });
  });

  group('FrameCryptor wiring', () {
    test('configures the native key provider for the shared key schedule',
        () async {
      final controller = E2EEController(
          SwalvoKeyProvider.sharedPassphrase('correct horse battery staple'));
      final h = await connected(e2ee: controller, roomE2EE: true);
      await settle();
      final options = platform.keyProviderOptions!;
      expect(options['sharedKey'], isTrue);
      expect(options['ratchetSalt'], ratchetSalt);
      expect(options['ratchetWindowSize'], 8);
      expect(options.containsKey('uncryptedMagicBytes'), isFalse);
      expect(options['keyDerivationAlgorithm'], 1,
          reason: 'KeyDerivationAlgorithm.kHKDF');
      expect(options['discardFrameWhenCryptorNotReady'], isTrue);
      // The material handed to the cryptor is the shared vector's. PBKDF2
      // runs through `compute` (another isolate), so wait for it.
      for (var i = 0; i < 500 && platform.keyCalls.isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(platform.keyCalls, hasLength(1));
      expect(platform.keyCalls.single.index, 0);
      expect(
        platform.keyCalls.single.key,
        deriveMaterialFromPassphrase(
            'correct horse battery staple', 'room_e2ee_vectors'),
      );
      expect(h.engine.isE2EEActive, isTrue);
      await h.engine.dispose();
      await h.signaling.dispose();
    });

    test('encrypts every published sender and reports states', () async {
      final controller =
          E2EEController(SwalvoKeyProvider.sharedPassphrase('pw'));
      final h = await connected(e2ee: controller, roomE2EE: true);
      final states = <E2EEStateEvent>[];
      final sub = controller.states.listen(states.add);
      final media = fakeLocalMedia(h.pcId);
      await h.engine.publish(
          source: 'microphone', stream: media.stream, track: media.track);
      expect(platform.frameCryptors, hasLength(1));
      expect(platform.frameCryptors.single, containsPair('type', 'sender'));
      expect(platform.frameCryptors.single,
          containsPair('participantId', 'alice'));
      expect(platform.frameCryptors.single, containsPair('algorithm', 0));
      expect(
        platform.frameCryptorCalls.map((c) => c.method),
        containsAllInOrder(
            ['frameCryptorSetKeyIndex', 'frameCryptorSetEnabled']),
      );
      await platform.cryptorState('frame-cryptor-1', 'alice', 'ok');
      await platform.cryptorState('frame-cryptor-1', 'alice', 'missingKey');
      await settle();
      expect(states.map((s) => (s.participantId, s.local, s.state)), [
        ('alice', true, SwalvoE2EEState.ok),
        ('alice', true, SwalvoE2EEState.missingKey),
      ]);
      await sub.cancel();
      await h.engine.dispose();
      await h.signaling.dispose();
    });

    test(
        'per-participant keys reach the native provider, including ones set mid-call',
        () async {
      final provider = SwalvoKeyProvider.perParticipant();
      await provider.setKey('alice', [1, 2, 3], keyIndex: 2);
      final controller = E2EEController(provider);
      final h = await connected(e2ee: controller, roomE2EE: true);
      await settle();
      expect(platform.keyCalls, hasLength(1));
      expect(platform.keyCalls.single.participantId, 'alice');
      expect(platform.keyCalls.single.index, 2);
      expect(platform.keyCalls.single.key, [1, 2, 3]);
      await provider.setKey('bob', [4, 5], keyIndex: 0);
      expect(platform.keyCalls.last.participantId, 'bob');
      await h.engine.dispose();
      await h.signaling.dispose();
    });

    test('does nothing in a room without e2ee (no cryptors, media as usual)',
        () async {
      final controller =
          E2EEController(SwalvoKeyProvider.sharedPassphrase('pw'));
      final h = await connected(e2ee: controller);
      final media = fakeLocalMedia(h.pcId);
      await h.engine.publish(
          source: 'microphone', stream: media.stream, track: media.track);
      expect(platform.frameCryptors, isEmpty);
      expect(platform.keyProviderOptions, isNull);
      await h.engine.dispose();
      await h.signaling.dispose();
    });

    test('maps every native state', () {
      expect(
          mapCryptorState(rtc.FrameCryptorState.FrameCryptorStateOk,
              local: true),
          SwalvoE2EEState.ok);
      expect(
          mapCryptorState(rtc.FrameCryptorState.FrameCryptorStateKeyRatcheted,
              local: false),
          SwalvoE2EEState.ok);
      expect(
          mapCryptorState(
              rtc.FrameCryptorState.FrameCryptorStateDecryptionFailed,
              local: false),
          SwalvoE2EEState.decryptFailed);
      expect(
          mapCryptorState(rtc.FrameCryptorState.FrameCryptorStateInternalError,
              local: true),
          SwalvoE2EEState.encryptFailed);
      expect(
          mapCryptorState(rtc.FrameCryptorState.FrameCryptorStateNew,
              local: true),
          isNull);
    });
  });

  group('key provider', () {
    test('ratchets offline with HKDF, matching the shared vectors', () async {
      final provider = SwalvoKeyProvider.perParticipant();
      final from = deriveMaterialFromPassphrase(
          'correct horse battery staple', 'room_e2ee_vectors');
      await provider.setKey('bob', from);
      await provider.ratchetKey(participantId: 'bob');
      expect(provider.explicitKeys.single.material, ratchetMaterial(from));
    });

    test('rejects bad input', () async {
      expect(() => SwalvoKeyProvider.sharedPassphrase(''),
          throwsA(isA<SwalvoException>()));
      final provider = SwalvoKeyProvider.perParticipant();
      await expectLater(provider.setKey('bob', [1], keyIndex: 256),
          throwsA(isA<SwalvoException>()));
      await expectLater(provider.ratchetKey(participantId: 'carol'),
          throwsA(isA<SwalvoException>()));
    });
  });

  group('codecs', () {
    const opus = {'mimeType': 'audio/opus', 'clockRate': 48000, 'channels': 2};
    const red = {'mimeType': 'audio/red', 'clockRate': 48000, 'channels': 2};
    const vp8 = {'mimeType': 'video/VP8', 'clockRate': 90000};
    const vp9 = {'mimeType': 'video/VP9', 'clockRate': 90000};

    test('puts audio/red first on the microphone by default', () async {
      platform.senderCapabilities['audio'] = [opus, red];
      final h = await connected();
      final media = fakeLocalMedia(h.pcId, kind: 'audio');
      await h.engine.publish(
          source: 'microphone', stream: media.stream, track: media.track);
      expect(
          platform.codecPreferences.values.single, ['audio/red', 'audio/opus']);
      await h.engine.dispose();
      await h.signaling.dispose();
    });

    test('leaves audio alone with audioRed: false, or while E2EE is configured',
        () async {
      platform.senderCapabilities['audio'] = [opus, red];
      var h = await connected(audioRed: false);
      var media = fakeLocalMedia(h.pcId, kind: 'audio');
      await h.engine.publish(
          source: 'microphone', stream: media.stream, track: media.track);
      expect(platform.codecPreferences, isEmpty);
      await h.engine.dispose();
      await h.signaling.dispose();

      h = await connected(
          e2ee: E2EEController(SwalvoKeyProvider.sharedPassphrase('pw')),
          roomE2EE: true);
      media = fakeLocalMedia(h.pcId, kind: 'audio');
      await h.engine.publish(
          source: 'microphone', stream: media.stream, track: media.track);
      expect(platform.codecPreferences, isEmpty);
      await h.engine.dispose();
      await h.signaling.dispose();
    });

    test('publishes VP9 as one L3T3_KEY encoding with VP9 first', () async {
      platform.senderCapabilities['video'] = [vp8, vp9];
      final h = await connected(videoCodec: 'vp9');
      final media = fakeLocalMedia(h.pcId);
      final published = await h.engine
          .publish(source: 'camera', stream: media.stream, track: media.track);
      final encodings =
          (platform.transceiverInits.single['sendEncodings'] as List)
              .cast<Map<Object?, Object?>>();
      expect(encodings, hasLength(1));
      expect(encodings.single['scalabilityMode'], 'L3T3_KEY');
      expect(platform.codecPreferences.values.single.first, 'video/VP9');
      expect(published.simulcast, SwalvoSimulcastStatus.svc);
      await h.engine.dispose();
      await h.signaling.dispose();
    });

    test('falls back to VP8 simulcast when the platform has no AV1', () async {
      platform.senderCapabilities['video'] = [vp8, vp9];
      final h = await connected(videoCodec: 'av1');
      final media = fakeLocalMedia(h.pcId);
      await h.engine
          .publish(source: 'camera', stream: media.stream, track: media.track);
      final encodings =
          (platform.transceiverInits.single['sendEncodings'] as List)
              .cast<Map<Object?, Object?>>();
      expect(encodings.map((e) => e['rid']), ['low', 'medium', 'high']);
      expect(platform.codecPreferences.values.single.first, 'video/VP8');
      await h.engine.dispose();
      await h.signaling.dispose();
    });
  });
}
