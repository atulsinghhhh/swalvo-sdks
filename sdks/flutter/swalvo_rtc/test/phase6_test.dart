import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/internal/engine.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';
import 'package:swalvo_rtc/src/room.dart';
import 'package:swalvo_rtc/src/types.dart';

import 'helpers/fake_socket.dart';
import 'helpers/fake_webrtc_platform.dart';

/// Phase 6 (docs/architecture/phase6-contracts.md §4, §8): captions,
/// transcription state, AI agent state, isAgent / isTranscriber.

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

  test('isAgent and isTranscriber follow the identity prefix', () {
    expect(
        const SwalvoParticipant(identity: 'agent-agt_1', isLocal: false)
            .isAgent,
        isTrue);
    expect(
        const SwalvoParticipant(identity: 'agent-agt_1', isLocal: false)
            .isTranscriber,
        isFalse);
    expect(
        const SwalvoParticipant(identity: 'transcriber-trx_1', isLocal: false)
            .isTranscriber,
        isTrue);
    expect(const SwalvoParticipant(identity: 'alice', isLocal: false).isAgent,
        isFalse);
    expect(
        const SwalvoParticipant(identity: 'alice', isLocal: false).agentState,
        isNull);
  });

  test(
      'transcription.segment: interim, final and an empty final are delivered unchanged',
      () async {
    final (:room, engine: _, pcId: _) = await joined();
    final segments = <SwalvoTranscriptionSegment>[];
    final sub = room.transcriptionSegments.listen(segments.add);
    socket.receive({
      'type': ServerMessageType.transcriptionSegment,
      'transcriptionId': 'trx_1',
      'participantId': 'bob',
      'segmentId': 'seg_1',
      'text': 'hello every',
      'final': false,
      'language': 'en',
      'startMs': 120340,
      'endMs': 121010,
    });
    socket.receive({
      'type': ServerMessageType.transcriptionSegment,
      'transcriptionId': null,
      'agentId': 'agt_1',
      'participantId': 'agent-agt_1',
      'segmentId': 'seg_2',
      'text': '',
      'final': true,
      'language': 'en',
      'startMs': 5,
      'endMs': 6,
    });
    // Malformed: no segmentId.
    socket.receive({
      'type': ServerMessageType.transcriptionSegment,
      'participantId': 'bob',
      'text': 'x',
      'final': true,
    });
    await settle();
    expect(segments, hasLength(2));
    expect(segments[0].transcriptionId, 'trx_1');
    expect(segments[0].participantId, 'bob');
    expect(segments[0].segmentId, 'seg_1');
    expect(segments[0].text, 'hello every');
    expect(segments[0].isFinal, isFalse);
    expect(segments[0].startMs, 120340);
    expect(segments[0].endMs, 121010);
    expect(segments[1].transcriptionId, isNull);
    expect(segments[1].agentId, 'agt_1');
    expect(segments[1].isFinal, isTrue);
    expect(segments[1].text, '');
    await sub.cancel();
    await teardown(room);
  });

  test('transcription.state parses status; unknown status is ignored',
      () async {
    final (:room, engine: _, pcId: _) = await joined();
    final states = <SwalvoTranscriptionState>[];
    final sub = room.transcriptionStateChanges.listen(states.add);
    socket.receive({
      'type': ServerMessageType.transcriptionState,
      'transcriptionId': 'trx_1',
      'status': 'ACTIVE',
      'language': 'en',
    });
    socket.receive({
      'type': ServerMessageType.transcriptionState,
      'transcriptionId': 'trx_1',
      'status': 'BOGUS',
      'language': 'en',
    });
    socket.receive({
      'type': ServerMessageType.transcriptionState,
      'transcriptionId': 'trx_1',
      'status': 'ENDED',
      'language': 'en',
    });
    await settle();
    expect(states.map((s) => s.status),
        [SwalvoTranscriptionStatus.active, SwalvoTranscriptionStatus.ended]);
    expect(states.first.isActive, isTrue);
    expect(states.first.language, 'en');
    await sub.cancel();
    await teardown(room);
  });

  test('agent.state resolves the participant and sets agentState', () async {
    final (:room, engine: _, pcId: _) = await joined(participants: [
      {'id': 'agent-agt_1', 'tracks': <Object>[]},
    ]);
    final events = <SwalvoAgentStateChanged>[];
    final sub = room.agentStateChanges.listen(events.add);
    socket.receive({
      'type': ServerMessageType.agentState,
      'agentId': 'agt_1',
      'participantId': 'agent-agt_1',
      'state': 'thinking',
    });
    socket.receive({
      'type': ServerMessageType.agentState,
      'agentId': 'agt_1',
      'participantId': 'agent-agt_1',
      'state': 'dancing',
    });
    await settle();
    expect(events, hasLength(1));
    expect(events.single.participant.identity, 'agent-agt_1');
    expect(events.single.participant.isAgent, isTrue);
    expect(events.single.participant.agentState, SwalvoAgentState.thinking);
    expect(events.single.state, SwalvoAgentState.thinking);
    expect(
        room.remoteParticipants.single.agentState, SwalvoAgentState.thinking);
    await sub.cancel();
    await teardown(room);
  });

  test(
      'agent.state before the agent joins is reported when it joins; ended for an unknown agent is dropped',
      () async {
    final (:room, engine: _, pcId: _) = await joined();
    final events = <SwalvoAgentStateChanged>[];
    final sub = room.agentStateChanges.listen(events.add);
    socket.receive({
      'type': ServerMessageType.agentState,
      'agentId': 'agt_1',
      'participantId': 'agent-agt_1',
      'state': 'listening',
    });
    socket.receive({
      'type': ServerMessageType.agentState,
      'agentId': 'agt_2',
      'participantId': 'agent-agt_2',
      'state': 'ended',
    });
    await settle();
    expect(events, isEmpty);
    socket.receive({
      'type': ServerMessageType.participantJoined,
      'participant': {'id': 'agent-agt_1', 'tracks': <Object>[]},
    });
    await settle();
    expect(events, hasLength(1));
    expect(events.single.participant.identity, 'agent-agt_1');
    expect(events.single.state, SwalvoAgentState.listening);
    socket.receive({
      'type': ServerMessageType.participantLeft,
      'participant': {'id': 'agent-agt_1'},
    });
    await settle();
    socket.receive({
      'type': ServerMessageType.agentState,
      'agentId': 'agt_1',
      'participantId': 'agent-agt_1',
      'state': 'ended',
    });
    await settle();
    expect(events, hasLength(1));
    await sub.cancel();
    await teardown(room);
  });
}
