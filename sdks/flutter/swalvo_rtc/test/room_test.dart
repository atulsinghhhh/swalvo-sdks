import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/internal/engine.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';
import 'package:swalvo_rtc/src/room.dart';
import 'package:swalvo_rtc/src/types.dart';

import 'helpers/fake_socket.dart';
import 'helpers/fake_webrtc_platform.dart';

void main() {
  late FakeSocket socket;
  late FakeWebRtcPlatform platform;

  setUp(() => platform = FakeWebRtcPlatform());
  tearDown(() => platform.dispose());

  SignalingClient clientFor({bool autoReconnect = true}) {
    socket = FakeSocket();
    return SignalingClient(
      endpoint: 'ws://localhost:4000/v1/rtc',
      token: fakeToken({'rid': 'room-1', 'sub': 'alice'}),
      roomId: 'room-1',
      autoReconnect: autoReconnect,
      // A fresh socket per attempt: a reconnect opens a brand new
      // connection, and reusing the dropped one would carry over its
      // already-completed `closed` future, making the reconnect look
      // instantly dead before it ever gets to join.
      socketFactory: (_) async => socket = FakeSocket(),
    );
  }

  group('SwalvoRoom.attach wiring order (spec §3-4)', () {
    test(
        'REGRESSION: a joins listener attached only after connect() resolves misses the first join',
        () async {
      // Direct proof of the mechanism the fix closes: SignalingClient
      // fires `_joins.add()` synchronously inside the very callback that
      // resolves `connect()` -- before that callback even returns, let
      // alone before anything awaiting connect() runs. The pre-fix
      // SwalvoRoom.attach() built the room (and so subscribed to
      // signaling.joins) only *after* awaiting connect(), which — as this
      // proves — is provably too late for the first join, every time,
      // not just under adverse timing.
      final signaling = clientFor();
      final joining = signaling.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': []
      });
      await joining;

      var receivedAfter = false;
      signaling.joins.listen((_) => receivedAfter = true);
      await Future<void>.delayed(Duration.zero);

      expect(receivedAfter, isFalse);
      await signaling.dispose();
    });

    test(
        'the fix: SwalvoRoom.attach() wires the room before connect() is called, so the first join is never missed',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);

      // Matches Swalvo.join(): attach() runs, *then* connect() is called.
      final room = SwalvoRoom.attach(
        signaling: signaling,
        engine: engine,
        roomId: 'room-1',
        localIdentity: 'alice',
      );
      expect(room.connectionState, SwalvoConnectionState.connecting,
          reason: 'not "connected" yet -- the join has not resolved');

      final joining = signaling.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [
          {
            'id': 'bob',
            'tracks': [
              {'trackId': 't1', 'kind': 'video', 'source': 'camera'}
            ],
          }
        ],
        'rtcServer': 'sfu-local-01',
        'region': 'local',
      });
      final joined = await joining;
      room.applyInitialJoin(joined);
      await Future<void>.delayed(Duration.zero);

      // All of this depends on SwalvoRoom._handleJoined having actually
      // run for the *first* join -- which is exactly what used to be
      // skipped (spec §6): _applyJoined() ran (old code called it
      // directly), but engine.applyJoinedState() never did.
      expect(room.rtcServer, 'sfu-local-01');
      expect(room.region, 'local');
      expect(room.remoteParticipants.map((p) => p.identity), ['bob']);
      expect(room.connectionState, SwalvoConnectionState.connected);

      room.dispose();
      // Let the fire-and-forget engine/signaling teardown finish
      // inside this test, not bleed into the next one's platform mock.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
    });

    test(
        'an sdp.offer immediately after room.joined is answered end to end through Swalvo.join()\'s real wiring',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      final room = SwalvoRoom.attach(
        signaling: signaling,
        engine: engine,
        roomId: 'room-1',
        localIdentity: 'alice',
      );

      final joining = signaling.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': []
      });
      final joined = await joining;
      room.applyInitialJoin(joined);

      // The SFU's very next message.
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(socket.lastSent(ClientMessageType.sdpAnswer), isNotNull,
          reason:
              'the subscriber transport must actually come up -- see spec §3');

      room.dispose();
      // Let the fire-and-forget engine/signaling teardown finish
      // inside this test, not bleed into the next one's platform mock.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
    });
  });

  group('participantChanges replays the current roster to a late listener', () {
    test(
        'REGRESSION: a listener attached only after the initial join misses the roster on a plain broadcast stream',
        () async {
      // Same mechanism as the joins/connectionState regression above, one
      // layer up: _emitParticipants()'s first call happens synchronously
      // inside applyInitialJoin(), before any caller of Swalvo.join() can
      // possibly have attached a participantChanges listener yet -- the
      // getter doesn't even exist until join() has already returned.
      // Direct proof that a plain .broadcast() stream drops that event
      // for good.
      final controller = StreamController<List<int>>.broadcast();
      controller.add([1]); // the "already published" roster, emitted early
      var received = false;
      controller.stream.listen((_) => received = true); // the "late" caller
      await Future<void>.delayed(Duration.zero);

      expect(received, isFalse);
      await controller.close();
    });

    test(
        'the fix: a listener attached well after join() still sees the roster that was already there',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      final room = SwalvoRoom.attach(
        signaling: signaling,
        engine: engine,
        roomId: 'room-1',
        localIdentity: 'alice',
      );

      final joining = signaling.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        // bob is already publishing camera -- the exact shape of a
        // viewer joining a live stream in progress, which is what
        // caught this: the one case this stream exists for.
        'participants': [
          {
            'id': 'bob',
            'tracks': [
              {'trackId': 't1', 'kind': 'video', 'source': 'camera'}
            ],
          }
        ],
      });
      final joined = await joining;
      room.applyInitialJoin(joined);
      // The point of this test: attach the listener well *after*
      // applyInitialJoin() has already run and _emitParticipants() has
      // already fired once -- exactly the ordering Swalvo.join()'s own
      // caller is stuck with, since the getter isn't reachable any
      // earlier.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      final firstEmission = room.participantChanges.first;

      final roster = await firstEmission.timeout(const Duration(seconds: 2));
      expect(roster.map((p) => p.identity), contains('bob'));

      room.dispose();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
    });
  });

  group('applyJoinedState on reconnect', () {
    test(
        'a reconnect reconciles the roster: departed participants are dropped, new ones appear',
        () async {
      final signaling = clientFor(autoReconnect: true);
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      final room = SwalvoRoom.attach(
        signaling: signaling,
        engine: engine,
        roomId: 'room-1',
        localIdentity: 'alice',
      );

      final joining = signaling.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [
          {'id': 'bob', 'tracks': []},
        ],
      });
      final joined = await joining;
      room.applyInitialJoin(joined);
      await Future<void>.delayed(Duration.zero);
      expect(room.remoteParticipants.map((p) => p.identity), ['bob']);

      // Reconnect: bob left during the outage, carol joined.
      socket.drop(1006);
      await Future<void>.delayed(const Duration(milliseconds: 400));
      expect(room.connectionState, SwalvoConnectionState.reconnecting);

      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [
          {'id': 'carol', 'tracks': []},
        ],
        'rtcServer': 'sfu-local-02',
      });
      await Future<void>.delayed(Duration.zero);

      expect(room.remoteParticipants.map((p) => p.identity), ['carol']);
      expect(room.rtcServer, 'sfu-local-02');
      expect(room.connectionState, SwalvoConnectionState.connected);

      room.dispose();
      // Let the fire-and-forget engine/signaling teardown finish
      // inside this test, not bleed into the next one's platform mock.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
    });
  });

  group('receive-only participants and the data channel (spec §8)', () {
    test(
        'listening to room.data opens a local data channel even though nothing is published or sent',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      final room = SwalvoRoom.attach(
        signaling: signaling,
        engine: engine,
        roomId: 'room-1',
        localIdentity: 'alice',
      );

      final joining = signaling.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': []
      });
      final joined = await joining;
      room.applyInitialJoin(joined);

      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(platform.calls, isNot(contains('createDataChannel')));

      final subscription = room.data.listen((_) {});
      await Future<void>.delayed(Duration.zero);

      expect(platform.calls, contains('createDataChannel'),
          reason:
              'a receive-only participant still needs a channel for the SFU to relay onto');

      await subscription.cancel();
      room.dispose();
      // Let the fire-and-forget engine/signaling teardown finish
      // inside this test, not bleed into the next one's platform mock.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
    });
  });

  group('media state is reported separately from signaling (spec §3)', () {
    /// A joined room with its peer connection up, which is the state the
    /// tests below start from.
    Future<({SwalvoRoom room, String pcId})> joined(
        {bool autoReconnect = true}) async {
      final signaling = clientFor(autoReconnect: autoReconnect);
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      final room = SwalvoRoom.attach(
        signaling: signaling,
        engine: engine,
        roomId: 'room-1',
        localIdentity: 'alice',
      );

      final joining = signaling.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': []
      });
      room.applyInitialJoin(await joining);

      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      return (room: room, pcId: platform.lastPeerConnectionId!);
    }

    test('a room with no peer connection reports idle, not connected',
        () async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
          signaling: signaling, iceServers: const [], adaptiveStream: false);
      final room = SwalvoRoom.attach(
        signaling: signaling,
        engine: engine,
        roomId: 'room-1',
        localIdentity: 'alice',
      );

      final joining = signaling.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': []
      });
      room.applyInitialJoin(await joining);

      expect(room.connectionState, SwalvoConnectionState.connected);
      expect(room.mediaState, SwalvoMediaState.idle,
          reason: 'nothing has been published or subscribed yet');

      room.dispose();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
    });

    test(
        'REGRESSION: a failed ICE transport is visible even though signaling says connected',
        () async {
      // autoReconnect off, so nothing rebuilds the transport and the
      // failure stays put to be observed. With it on, the SDK rejoins: see
      // the next test.
      final context = await joined(autoReconnect: false);
      final room = context.room;

      final seen = <SwalvoMediaState>[];
      final subscription = room.mediaStateChanges.listen(seen.add);
      await Future<void>.delayed(Duration.zero);

      await platform.peerConnectionState(context.pcId, 'connecting');
      await platform.peerConnectionState(context.pcId, 'failed');
      await Future<void>.delayed(Duration.zero);

      // The exact combination that used to be unobservable: the socket is
      // fine and says so, and no frame will ever arrive.
      expect(room.connectionState, SwalvoConnectionState.connected);
      expect(room.mediaState, SwalvoMediaState.failed);
      expect(
          seen,
          [
            SwalvoMediaState.idle,
            SwalvoMediaState.connecting,
            SwalvoMediaState.failed,
          ],
          reason: 'a new listener is seeded with the current state first');

      await subscription.cancel();
      room.dispose();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
    });

    test('a failed ICE transport under a live socket triggers a rejoin',
        () async {
      // Nothing else would notice: the socket is healthy and the SFU may
      // still think the session is alive. The SDK abandons the session
      // and joins fresh, which rebuilds the peer connection.
      final context = await joined();
      final room = context.room;
      final firstSocket = socket;

      await platform.peerConnectionState(context.pcId, 'failed');
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(firstSocket.closeCalled, isTrue);
      expect(room.connectionState, SwalvoConnectionState.reconnecting);

      // The fresh join carries no resume token: resuming would only
      // re-bind the session whose media just died.
      await Future<void>.delayed(const Duration(milliseconds: 400));
      expect(identical(socket, firstSocket), isFalse);
      expect(socket.lastSent(ClientMessageType.roomJoin)!['resume'], isNull);

      room.dispose();
      await Future<void>.delayed(Duration.zero);
    });

    test('a dropped transport reads interrupted, and recovers to connected',
        () async {
      final context = await joined();
      final room = context.room;

      await platform.peerConnectionState(context.pcId, 'connected');
      await Future<void>.delayed(Duration.zero);
      expect(room.mediaState, SwalvoMediaState.connected);

      // A phone changing network passes through here and usually comes
      // back, which is why this is its own state rather than a failure.
      await platform.peerConnectionState(context.pcId, 'disconnected');
      await Future<void>.delayed(Duration.zero);
      expect(room.mediaState, SwalvoMediaState.interrupted);

      await platform.peerConnectionState(context.pcId, 'connected');
      await Future<void>.delayed(Duration.zero);
      expect(room.mediaState, SwalvoMediaState.connected);

      room.dispose();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
    });

    test('a reconnect drops the old transport back to idle', () async {
      final context = await joined();
      final room = context.room;

      await platform.peerConnectionState(context.pcId, 'connected');
      await Future<void>.delayed(Duration.zero);
      expect(room.mediaState, SwalvoMediaState.connected);

      // Signaling reconnecting tears the peer connection down: the SFU
      // allocates a fresh session on rejoin. Continuing to report
      // `connected` for the connection just discarded would be the most
      // misleading possible answer.
      socket.drop(1006);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(room.mediaState, SwalvoMediaState.idle);

      room.dispose();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
    });
  });
}
