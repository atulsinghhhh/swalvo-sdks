import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/errors.dart';
import 'package:swalvo_rtc/src/internal/engine.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';
import 'package:swalvo_rtc/src/room.dart';
import 'package:swalvo_rtc/src/types.dart';

import 'helpers/fake_socket.dart';
import 'helpers/fake_webrtc_platform.dart';

/// Phase 7 (docs/architecture/phase7-contracts.md): data messages v2,
/// participant metadata/attributes, screen-share audio.
void main() {
  late FakeSocket socket;
  late FakeWebRtcPlatform platform;

  setUp(() => platform = FakeWebRtcPlatform());
  tearDown(() => platform.dispose());

  Future<void> settle() async {
    for (var i = 0; i < 6; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  Future<({SwalvoRoom room, SwalvoEngine engine, String pcId})> joined({
    List<String> capabilities = const [],
    List<Map<String, dynamic>> participants = const [],
    SwalvoGrants? grants,
    String? localMetadata,
    Map<String, String>? localAttributes,
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
      initialGrants: grants,
    );
    final room = SwalvoRoom.attach(
      signaling: signaling,
      engine: engine,
      roomId: 'room-1',
      localIdentity: 'alice',
      localMetadata: localMetadata,
      localAttributes: localAttributes,
    );
    final joining = signaling.connect();
    await Future<void>.delayed(Duration.zero);
    socket.receive({
      'type': ServerMessageType.roomJoined,
      'roomId': 'room-1',
      'participants': participants,
      if (capabilities.isNotEmpty) 'capabilities': capabilities,
    });
    room.applyInitialJoin(await joining);
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await settle();
    return (room: room, engine: engine, pcId: platform.lastPeerConnectionId!);
  }

  Future<void> teardown(SwalvoRoom room) async {
    room.dispose();
    await settle();
  }

  const grantsWithMetadata = SwalvoGrants(
    subscribe: true,
    publish: true,
    publishAudio: true,
    publishVideo: true,
    publishData: true,
    updateOwnMetadata: true,
  );

  String hex(List<int> bytes) =>
      bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

  group('channels at connect (§1.1)', () {
    const viewerGrants = SwalvoGrants(
      subscribe: true,
      publish: false,
      publishAudio: false,
      publishVideo: false,
      publishData: false,
    );

    test(
        'without publishData a data.v2 join opens no channel: the API would '
        'refuse the offer and fail the connection', () async {
      final r = await joined(capabilities: ['data.v2'], grants: viewerGrants);
      await r.engine.ensureDataChannel();
      await settle();
      expect(platform.createdDataChannels, isEmpty);
      await expectLater(
        r.engine.sendData(Uint8List.fromList([1])),
        throwsA(isA<SwalvoException>()
            .having((e) => e.code, 'code', SwalvoErrorCode.permissionDenied)),
      );
      expect(platform.createdDataChannels, isEmpty);
      await teardown(r.room);
    });

    test('a data.v2 join opens both channels eagerly, with protocol raven.v2',
        () async {
      final r = await joined(capabilities: ['data.v2']);
      final channels = {
        for (final c in platform.createdDataChannels) c.label: c,
      };
      expect(
          channels.keys, unorderedEquals(['raven-data', 'raven-data-lossy']));
      expect(platform.createdDataChannels, hasLength(2));
      expect(channels['raven-data']!.init['protocol'], 'raven.v2');
      expect(channels['raven-data']!.init['ordered'], isTrue);
      expect(channels['raven-data-lossy']!.init['protocol'], 'raven.v2');
      expect(channels['raven-data-lossy']!.init['ordered'], isFalse);
      expect(channels['raven-data-lossy']!.init['maxRetransmits'], 0);
      await teardown(r.room);
    });

    test(
        'without data.v2 nothing opens until data is used, then raven-data with raven.v2',
        () async {
      final r = await joined();
      expect(platform.createdDataChannels, isEmpty);
      final sub = r.room.data.listen((_) {});
      await settle();
      expect(platform.createdDataChannels.map((c) => c.label), ['raven-data']);
      expect(platform.createdDataChannels.single.init['protocol'], 'raven.v2');
      await sub.cancel();
      await teardown(r.room);
    });
  });

  group('sendData', () {
    test('without options or data.v2, the wire bytes are exactly the payload',
        () async {
      final r = await joined();
      final sending = r.room.sendData(utf8.encode('hello'));
      await settle();
      await platform.openDataChannelLabeled(r.pcId, 'raven-data');
      await sending.timeout(const Duration(seconds: 2));

      expect(platform.createdDataChannels.map((c) => c.label), ['raven-data'],
          reason: 'no lossy channel against an old server');
      expect(hex(platform.dataChannelSends.single.data),
          hex(utf8.encode('hello')));
      await teardown(r.room);
    });

    test('with data.v2, every message is an envelope and both channels open',
        () async {
      final r = await joined(capabilities: ['data.v2']);
      expect(r.room.supportsDataV2, isTrue);
      final sending = r.room.sendData(utf8.encode('hello'));
      await settle();
      await platform.openDataChannelLabeled(r.pcId, 'raven-data');
      await sending.timeout(const Duration(seconds: 2));

      expect(
          hex(platform.dataChannelSends.single.data), '520200000068656c6c6f');
      final lossy = platform.createdDataChannels
          .singleWhere((c) => c.label == 'raven-data-lossy');
      expect(lossy.init['ordered'], isFalse);
      expect(lossy.init['maxRetransmits'], 0);
      await teardown(r.room);
    });

    test('topic and destinations go in the envelope even without data.v2',
        () async {
      final r = await joined();
      final sending = r.room.sendData(utf8.encode('hello'),
          topic: 'cursor', destinationIdentities: ['alice']);
      await settle();
      await platform.openDataChannelLabeled(r.pcId, 'raven-data');
      await sending.timeout(const Duration(seconds: 2));
      expect(hex(platform.dataChannelSends.single.data),
          '52020006637572736f720105616c69636568656c6c6f');
      await teardown(r.room);
    });

    test('reliable: false uses the lossy channel with data.v2', () async {
      final r = await joined(capabilities: ['data.v2']);
      final sending = r.room.sendData([1, 2], reliable: false);
      await settle();
      await platform.openDataChannelLabeled(r.pcId, 'raven-data-lossy');
      await sending.timeout(const Duration(seconds: 2));
      final lossy = platform.createdDataChannels
          .singleWhere((c) => c.label == 'raven-data-lossy');
      expect(platform.dataChannelSends.single.flutterId, lossy.flutterId);
      await teardown(r.room);
    });

    test('reliable: false falls back to the reliable channel without data.v2',
        () async {
      final r = await joined();
      final sending = r.room.sendData([1], reliable: false);
      await settle();
      await platform.openDataChannelLabeled(r.pcId, 'raven-data');
      await sending.timeout(const Duration(seconds: 2));
      expect(platform.createdDataChannels.map((c) => c.label), ['raven-data']);
      expect(hex(platform.dataChannelSends.single.data), '520200000001');
      await teardown(r.room);
    });

    test('limits throw invalidArgument before anything is sent', () async {
      final r = await joined(capabilities: ['data.v2']);
      final invalid = throwsA(isA<SwalvoException>()
          .having((e) => e.code, 'code', SwalvoErrorCode.invalidArgument));
      await expectLater(r.room.sendData([1], topic: 'a' * 256), invalid);
      await expectLater(
          r.room.sendData([1],
              destinationIdentities: List.generate(65, (i) => 'u$i')),
          invalid);
      await expectLater(
          r.room.sendData(List.filled(1201, 0), reliable: false), invalid);
      await expectLater(r.room.sendData(List.filled(65537, 0)), invalid);
      expect(platform.dataChannelSends, isEmpty);
      await teardown(r.room);
    });
  });

  group('dataMessages', () {
    test('attributes the sender and topic, server and legacy messages',
        () async {
      final r = await joined(
        capabilities: ['data.v2'],
        participants: [
          {'id': 'bob', 'tracks': []}
        ],
      );
      final messages = <SwalvoDataMessage>[];
      final payloads = <List<int>>[];
      final sub = r.room.dataMessages.listen(messages.add);
      final sub2 = r.room.data.listen(payloads.add);
      await settle();

      // From bob, topic "chat", payload "hello".
      await platform.receiveDataChannelMessage(r.pcId, 'raven-data', [
        0x52,
        0x03,
        3,
        ...utf8.encode('bob'),
        4,
        ...utf8.encode('chat'),
        ...utf8.encode('hello')
      ]);
      // From the server on the lossy channel, no topic.
      await platform.receiveDataChannelMessage(
          r.pcId, 'raven-data-lossy', [0x52, 0x03, 0, 0, 9]);
      // Legacy.
      await platform.receiveDataChannelMessage(r.pcId, 'raven-data', [7, 7]);
      await settle();

      expect(messages, hasLength(3));
      expect(messages[0].participant?.identity, 'bob');
      expect(messages[0].topic, 'chat');
      expect(utf8.decode(messages[0].payload), 'hello');
      expect(messages[1].participant, isNull);
      expect(messages[1].topic, isNull);
      expect(messages[1].payload, [9]);
      expect(messages[2].participant, isNull);
      expect(messages[2].payload, [7, 7]);
      expect(payloads, [
        utf8.encode('hello'),
        [9],
        [7, 7]
      ]);

      await sub.cancel();
      await sub2.cancel();
      await teardown(r.room);
    });

    test('data.throttled surfaces as an event', () async {
      final r = await joined(capabilities: ['data.v2']);
      final events = <SwalvoDataThrottled>[];
      final sub = r.room.dataThrottled.listen(events.add);
      socket.receive({'type': 'data.throttled', 'channel': 'lossy'});
      socket.receive({'type': 'data.throttled', 'channel': 'reliable'});
      await settle();
      expect(events.map((e) => e.channel),
          [SwalvoDataChannelKind.lossy, SwalvoDataChannelKind.reliable]);
      await sub.cancel();
      await teardown(r.room);
    });
  });

  group('participant metadata and attributes', () {
    test('initial values from the token and room.joined', () async {
      final r = await joined(
        localMetadata: 'me',
        localAttributes: {'role': 'host'},
        participants: [
          {
            'id': 'bob',
            'tracks': [],
            'metadata': '{"seat":3}',
            'attributes': {'hand': 'up'},
          },
        ],
      );
      expect(r.room.localParticipant.metadata, 'me');
      expect(r.room.localParticipant.attributes, {'role': 'host'});
      final bob = r.room.remoteParticipants.single;
      expect(bob.metadata, '{"seat":3}');
      expect(bob.attributes, {'hand': 'up'});
      await teardown(r.room);
    });

    test('participant.joined and participant.updated, with previous values',
        () async {
      final r = await joined();
      final changes = <SwalvoParticipantMetadataChanged>[];
      final sub = r.room.participantMetadataChanges.listen(changes.add);

      socket.receive({
        'type': 'participant.joined',
        'participant': {
          'id': 'carol',
          'metadata': 'm1',
          'attributes': {'a': '1'}
        },
      });
      socket.receive({
        'type': 'participant.updated',
        'participantId': 'carol',
        'metadata': 'm2',
        'attributes': {'a': '1', 'b': '2'},
      });
      // Unchanged: no event.
      socket.receive({
        'type': 'participant.updated',
        'participantId': 'carol',
        'metadata': 'm2',
        'attributes': {'b': '2', 'a': '1'},
      });
      // The local participant too.
      socket.receive({
        'type': 'participant.updated',
        'participantId': 'alice',
        'metadata': 'mine',
      });
      await settle();

      expect(changes, hasLength(2));
      expect(changes[0].participant.identity, 'carol');
      expect(changes[0].participant.metadata, 'm2');
      expect(changes[0].participant.attributes, {'a': '1', 'b': '2'});
      expect(changes[0].previousMetadata, 'm1');
      expect(changes[0].previousAttributes, {'a': '1'});
      expect(changes[1].participant.isLocal, isTrue);
      expect(r.room.localParticipant.metadata, 'mine');

      await sub.cancel();
      await teardown(r.room);
    });

    test('setMetadata without perms.updateOwnMetadata is permissionDenied',
        () async {
      final r = await joined();
      await expectLater(
        r.room.setMetadata('x'),
        throwsA(isA<SwalvoException>()
            .having((e) => e.code, 'code', SwalvoErrorCode.permissionDenied)),
      );
      await expectLater(
        r.room.setAttributes({'a': 'b'}),
        throwsA(isA<SwalvoException>()
            .having((e) => e.code, 'code', SwalvoErrorCode.permissionDenied)),
      );
      expect(socket.lastSent('participant.update'), isNull);
      await teardown(r.room);
    });

    test('setMetadata/setAttributes send participant.update, without optimism',
        () async {
      final r = await joined(grants: grantsWithMetadata);
      await r.room.setMetadata('hello');
      expect(socket.lastSent('participant.update'),
          {'type': 'participant.update', 'metadata': 'hello'});
      await r.room.setAttributes({'hand': 'up'});
      expect(socket.lastSent('participant.update'), {
        'type': 'participant.update',
        'attributes': {'hand': 'up'},
      });
      expect(r.room.localParticipant.metadata, isNull,
          reason: 'applied only when the server echoes participant.updated');
      await teardown(r.room);
    });

    test('metadata and attribute limits', () async {
      final r = await joined(grants: grantsWithMetadata);
      final invalid = throwsA(isA<SwalvoException>()
          .having((e) => e.code, 'code', SwalvoErrorCode.invalidArgument));
      await expectLater(r.room.setMetadata('a' * 4097), invalid);
      await expectLater(
          r.room.setAttributes({for (var i = 0; i < 33; i++) 'k$i': 'v'}),
          invalid);
      await expectLater(r.room.setAttributes({'k' * 65: 'v'}), invalid);
      await expectLater(r.room.setAttributes({'': 'v'}), invalid);
      await expectLater(r.room.setAttributes({'k': 'v' * 1025}), invalid);
      expect(socket.lastSent('participant.update'), isNull);
      await teardown(r.room);
    });

    test('a permissions update without updateOwnMetadata keeps the grant',
        () async {
      final r = await joined(grants: grantsWithMetadata);
      socket.receive({
        'type': ServerMessageType.participantPermissionsUpdated,
        'permissions': {
          'subscribe': true,
          'publish': true,
          'publishAudio': true,
          'publishVideo': true,
          'publishData': true,
        },
      });
      await settle();
      expect(r.room.grants?.updateOwnMetadata, isTrue);
      socket.receive({
        'type': ServerMessageType.participantPermissionsUpdated,
        'permissions': {'publish': true, 'updateOwnMetadata': false},
      });
      await settle();
      expect(r.room.grants?.updateOwnMetadata, isFalse);
      await teardown(r.room);
    });
  });

  test('screenShareAudio maps to its own track kind', () {
    expect(trackKindFromSource('screenShareAudio'),
        SwalvoTrackKind.screenShareAudio);
    expect(isAudioSource('screenShareAudio'), isTrue);
    expect(isAudioSource('screenShare'), isFalse);
  });
}
