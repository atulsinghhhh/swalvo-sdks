import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/swalvo_rtc.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';
// trackKindFromSource is internal: imported directly rather than
// widening the public surface just to test it.
import 'package:swalvo_rtc/src/types.dart' show trackKindFromSource;

import 'helpers/fake_socket.dart';

void main() {
  group('decodeTokenClaims', () {
    test('reads the room and subject a token was minted for', () {
      final token = fakeToken({'rid': 'room-1', 'sub': 'alice'});
      final claims = decodeTokenClaims(token);

      expect(claims?['rid'], 'room-1');
      expect(claims?['sub'], 'alice');
    });

    test('returns null for anything that is not a three-part JWT', () {
      expect(decodeTokenClaims(''), isNull);
      expect(decodeTokenClaims('not-a-token'), isNull);
      expect(decodeTokenClaims('aa.bb'), isNull);
    });

    test('returns null rather than throwing on a corrupt payload', () {
      // A malformed token must not take down the join with a raw
      // FormatException from inside the SDK.
      expect(decodeTokenClaims('aaa.!!!not-base64!!!.ccc'), isNull);
    });
  });

  group('SignalingClient', () {
    late FakeSocket socket;

    SignalingClient clientFor({
      bool autoReconnect = false,
      Future<String> Function()? refreshToken,
    }) {
      socket = FakeSocket();
      return SignalingClient(
        endpoint: 'ws://localhost:4000/v1/rtc',
        token: fakeToken({'rid': 'room-1', 'sub': 'alice'}),
        roomId: 'room-1',
        autoReconnect: autoReconnect,
        refreshToken: refreshToken,
        socketFactory: (_) async => socket,
      );
    }

    test('sends room.join and completes on room.joined', () async {
      final client = clientFor();
      final joining = client.connect();

      // The join is sent as soon as the socket is handed over.
      await Future<void>.delayed(Duration.zero);
      expect(socket.lastSent(ClientMessageType.roomJoin), isNotNull);
      expect(socket.lastSent(ClientMessageType.roomJoin)!['roomId'], 'room-1');

      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [
          {'id': 'bob', 'tracks': []},
        ],
        'rtcServer': 'sfu-local-01',
        'region': 'local',
      });

      final joined = await joining;
      expect(joined.roomId, 'room-1');
      expect(joined.participants.single.id, 'bob');
      expect(joined.rtcServer, 'sfu-local-01');
      expect(client.isJoined, isTrue);

      await client.dispose();
    });

    test('puts the token in the URL, since a handshake carries no headers',
        () async {
      var requestedUrl = '';
      final token = fakeToken({'rid': 'room-1', 'sub': 'alice'});
      final probe = FakeSocket();
      final client = SignalingClient(
        endpoint: 'ws://localhost:4000/v1/rtc/',
        token: token,
        roomId: 'room-1',
        autoReconnect: false,
        socketFactory: (url) async {
          requestedUrl = url;
          return probe;
        },
      );

      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      probe.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
      });
      await joining;

      // The trailing slash is normalised away instead of producing a
      // double slash before the query.
      expect(requestedUrl, startsWith('ws://localhost:4000/v1/rtc?token='));
      expect(requestedUrl, contains(Uri.encodeQueryComponent(token)));

      await client.dispose();
    });

    test('maps a rejected token onto a typed, actionable error', () async {
      final client = clientFor();
      final joining = client.connect();

      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.error,
        'code': SignalingErrorCode.tokenExpired,
        'message': 'RTC token has expired',
      });

      // TOKEN_EXPIRED, not a generic auth failure: the caller
      // should refresh, not re-authenticate the user.
      await expectLater(
        joining,
        throwsA(isA<SwalvoException>()
            .having((e) => e.code, 'code', SwalvoErrorCode.tokenExpired)),
      );

      await client.dispose();
    });

    test('maps capacity and reachability failures onto connectionFailed',
        () async {
      for (final code in [
        SignalingErrorCode.roomFull,
        SignalingErrorCode.noRtcCapacity,
        SignalingErrorCode.rtcServerUnreachable,
      ]) {
        final client = clientFor();
        final joining = client.connect();
        await Future<void>.delayed(Duration.zero);
        socket.receive({
          'type': ServerMessageType.error,
          'code': code,
          'message': 'nope',
        });

        await expectLater(
          joining,
          throwsA(isA<SwalvoException>()
              .having((e) => e.code, 'code', SwalvoErrorCode.connectionFailed)),
        );
        await client.dispose();
      }
    });

    test('forwards ordinary server messages to listeners', () async {
      final client = clientFor();
      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
      });
      await joining;

      final received = <Map<String, dynamic>>[];
      final subscription = client.messages.listen(received.add);

      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);

      expect(received.single['type'], ServerMessageType.sdpOffer);
      expect(received.single['sdp'], 'v=0 offer');

      await subscription.cancel();
      await client.dispose();
    });

    test(
        'an answer sent in reaction to an offer that beats room.joined is '
        'not dropped', () async {
      // The SFU's join-time offer travels a path with no ordering
      // relationship to the API's own room.joined reply — node-link to
      // gateway straight to the socket, versus the join handler's own
      // response. When the offer wins that race (the common case: the SFU
      // creates and sends it synchronously, with no I/O), a real client
      // answers it before room.joined has arrived. That answer must reach
      // the wire: gating `send` on "joined" instead of "join dispatched"
      // silently dropped it here, and the SFU waited out its answerTimeout
      // for an answer that was never coming.
      final client = clientFor();
      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      expect(socket.lastSent(ClientMessageType.roomJoin), isNotNull);
      expect(client.isJoined, isFalse);

      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
      await Future<void>.delayed(Duration.zero);

      // Still not joined — room.joined has not arrived yet.
      expect(client.isJoined, isFalse);
      client.send({'type': ClientMessageType.sdpAnswer, 'sdp': 'v=0 answer'});

      expect(
          socket.lastSent(ClientMessageType.sdpAnswer)?['sdp'], 'v=0 answer');

      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
      });
      await joining;
      await client.dispose();
    });

    test('ignores a non-text frame instead of guessing at it', () async {
      final client = clientFor();
      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
      });
      await joining;

      final received = <Map<String, dynamic>>[];
      final subscription = client.messages.listen(received.add);

      // Swalvo's signaling is text-only. A binary frame means something
      // else is on this socket.
      socket.incoming.add([1, 2, 3]);
      socket.incoming.add('{not json');
      await Future<void>.delayed(Duration.zero);

      expect(received, isEmpty);

      await subscription.cancel();
      await client.dispose();
    });

    test('reports a fatal error and does not reconnect', () async {
      final client = clientFor(autoReconnect: true);
      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
      });
      await joining;

      final lifecycle = <SignalingLifecycle>[];
      final subscription = client.lifecycle.listen(lifecycle.add);

      // A rejected credential is not something a reconnect can fix.
      socket.receive({
        'type': ServerMessageType.error,
        'code': SignalingErrorCode.unauthorized,
        'message': 'not allowed in this room',
      });
      await Future<void>.delayed(Duration.zero);

      expect(lifecycle.whereType<SignalingFailed>(), hasLength(1));
      expect(lifecycle.whereType<SignalingReconnecting>(), isEmpty);
      expect(socket.closeCalled, isTrue);

      await subscription.cancel();
      await client.dispose();
    });

    test('fails immediately when autoReconnect is off', () async {
      final client = clientFor(autoReconnect: false);
      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
      });
      await joining;

      final lifecycle = <SignalingLifecycle>[];
      final subscription = client.lifecycle.listen(lifecycle.add);

      socket.drop(1006);
      await Future<void>.delayed(Duration.zero);

      expect(lifecycle.single, isA<SignalingFailed>());

      await subscription.cancel();
      await client.dispose();
    });

    test('refreshes the token before reconnecting', () async {
      // A reconnect after a long outage very often has an expired token,
      // and discovering that by being rejected costs an extra round trip
      // (spec §21).
      var refreshes = 0;
      final client = clientFor(
        autoReconnect: true,
        refreshToken: () async {
          refreshes++;
          return fakeToken({'rid': 'room-1', 'sub': 'alice'});
        },
      );

      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
      });
      await joining;

      final lifecycle = <SignalingLifecycle>[];
      final subscription = client.lifecycle.listen(lifecycle.add);

      socket.drop(4001); // the server's credential-rejected close code
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(lifecycle.whereType<SignalingReconnecting>(), isNotEmpty);
      expect(refreshes, greaterThanOrEqualTo(1));

      await subscription.cancel();
      await client.dispose();
    });

    test('close() leaves the room and suppresses reconnection', () async {
      final client = clientFor(autoReconnect: true);
      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
      });
      await joining;

      final lifecycle = <SignalingLifecycle>[];
      final subscription = client.lifecycle.listen(lifecycle.add);

      await client.close();
      await Future<void>.delayed(Duration.zero);

      expect(socket.lastSent(ClientMessageType.roomLeave), isNotNull);
      expect(lifecycle.whereType<SignalingReconnecting>(), isEmpty);
      expect(client.isJoined, isFalse);

      await subscription.cancel();
      await client.dispose();
    });

    test(
        'a reconnect suspended awaiting a token refresh does not crash '
        'after dispose', () async {
      // Regression test: dispose() arriving while _scheduleReconnect is
      // parked in `await _tryRefreshToken()` — before any retry Timer
      // exists — used to leave close()'s `_reconnectTimer?.cancel()`
      // with nothing to cancel. The chain would resume once the refresh
      // settled and add to StreamControllers dispose() had already
      // closed, surfacing as an unhandled "Bad state: Cannot add new
      // events after calling close".
      final refreshGate = Completer<void>();
      final client = clientFor(
        autoReconnect: true,
        refreshToken: () async {
          await refreshGate.future;
          return fakeToken({'rid': 'room-1', 'sub': 'alice'});
        },
      );

      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      socket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
      });
      await joining;

      socket.drop(4001); // the server's credential-rejected close code
      await Future<void>.delayed(Duration.zero);

      await client.dispose();
      refreshGate.complete();

      // Long enough to cover the reconnect backoff (up to 300ms on the
      // first attempt) so a resurrected chain would have thrown by now.
      await Future<void>.delayed(const Duration(milliseconds: 500));
    });

    test(
        'dispose() while a reconnect attempt is still opening its socket '
        'does not leak that socket or rejoin the room', () async {
      // Regression test: _openAndJoin used to commit a reconnect attempt's
      // socket unconditionally once `_open()` resolved — even if close()/
      // dispose() had already run while that network round trip was in
      // flight. The late socket got assigned to `_socket`, subscribed to,
      // and actually joined into the room: a leaked, never-closed socket
      // and a stale server-side participant nobody asked for, exactly the
      // ordinary "leave while reconnecting" race, not a contrived one.
      final firstSocket = FakeSocket();
      final secondSocket = FakeSocket();
      final openGate = Completer<void>();
      var factoryCalls = 0;

      final client = SignalingClient(
        endpoint: 'ws://localhost:4000/v1/rtc',
        token: fakeToken({'rid': 'room-1', 'sub': 'alice'}),
        roomId: 'room-1',
        autoReconnect: true,
        socketFactory: (_) async {
          factoryCalls++;
          if (factoryCalls == 1) return firstSocket;
          await openGate.future;
          return secondSocket;
        },
      );

      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      firstSocket.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
      });
      await joining;

      firstSocket.drop(1006); // an ordinary, non-fatal drop
      // Covers the reconnect backoff (up to 300ms on the first attempt),
      // so `attempt()` has fired and is now blocked in the socket factory.
      await Future<void>.delayed(const Duration(milliseconds: 350));
      expect(factoryCalls, 2);

      await client.dispose();
      openGate.complete();
      await Future<void>.delayed(Duration.zero);

      expect(secondSocket.closeCalled, isTrue,
          reason: 'a socket that finishes connecting after dispose() must '
              'be closed immediately, not left orphaned');
      expect(secondSocket.sent, isEmpty,
          reason: 'the room must never be (re)joined on a socket that '
              'only arrived after the client was disposed');
    });
  });

  group('protocol parsing', () {
    test('a joined payload tolerates missing optional fields', () {
      // A newer or older server must not crash the client over a field it
      // did not send.
      final payload = JoinedPayload.fromJson({'roomId': 'room-1'});
      expect(payload.participants, isEmpty);
      expect(payload.rtcServer, isNull);
    });

    test('a track defaults to not-muted, not-simulcast', () {
      final track = ServerTrack.fromJson({'trackId': 't1', 'kind': 'video'});
      expect(track.muted, isFalse);
      expect(track.simulcast, isFalse);
      expect(track.layers, isEmpty);
      expect(track.source, 'unknown');
    });

    test('an unrecognised source maps to unknown rather than throwing', () {
      // Treating a source this version does not know as an error would
      // break an app on a server upgrade it did not ask for.
      expect(trackKindFromSource('hologram'), SwalvoTrackKind.unknown);
      expect(trackKindFromSource('screenShare'), SwalvoTrackKind.screenShare);
    });
  });
}
