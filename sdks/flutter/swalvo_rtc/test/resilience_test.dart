// Phase 1 resilience on the signaling client: token refresh, session
// resume, and close codes (docs/architecture/phase1-contracts.md §1).
// Mirrors packages/sdk/test/resilience.spec.ts.

import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';
import 'package:swalvo_rtc/src/types.dart';

import 'helpers/fake_socket.dart';

void main() {
  late List<FakeSocket> sockets;

  FakeSocket latest() => sockets.last;

  String tokenFor([String jti = 'first']) => fakeToken({
        'rid': 'room-1',
        'sub': 'alice',
        'jti': jti,
        'exp': DateTime.now().millisecondsSinceEpoch ~/ 1000 + 600,
      });

  SignalingClient clientFor({
    bool autoReconnect = true,
    Future<String> Function()? refreshToken,
  }) {
    sockets = [];
    return SignalingClient(
      endpoint: 'ws://localhost:4000/v1/rtc',
      token: tokenFor(),
      roomId: 'room-1',
      autoReconnect: autoReconnect,
      refreshToken: refreshToken,
      // A fresh socket per attempt, like a real reconnect.
      socketFactory: (url) async {
        final socket = FakeSocket();
        sockets.add(socket);
        urls.add(url);
        return socket;
      },
    );
  }

  Future<void> joinWith(SignalingClient client,
      {String? resumeToken = 'resume-1'}) async {
    final joining = client.connect();
    await Future<void>.delayed(Duration.zero);
    latest().receive({
      'type': ServerMessageType.roomJoined,
      'roomId': 'room-1',
      'participants': [],
      if (resumeToken != null) 'resumeToken': resumeToken,
    });
    await joining;
  }

  Future<FakeSocket> nextSocket(int before,
      {Duration timeout = const Duration(seconds: 3)}) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      if (sockets.length > before) {
        await Future<void>.delayed(Duration.zero);
        return latest();
      }
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    throw StateError('never reconnected');
  }

  setUp(() => urls.clear());

  group('token refresh (§1.1)', () {
    test('answers token.expiring with token.refresh', () async {
      final fresh = tokenFor('fresh');
      final client = clientFor(refreshToken: () async => fresh);
      await joinWith(client);

      latest().receive({
        'type': ServerMessageType.tokenExpiring,
        'expiresAt': '2026-10-02T12:00:00.000Z',
      });
      await Future<void>.delayed(Duration.zero);

      expect(latest().lastSent(ClientMessageType.tokenRefresh),
          {'type': 'token.refresh', 'token': fresh});
      await client.dispose();
    });

    test('a refused refresh is a warning, not a failure', () async {
      final client = clientFor(refreshToken: () async => tokenFor('fresh'));
      await joinWith(client);
      final warnings = <SwalvoWarning>[];
      final lifecycle = <SignalingLifecycle>[];
      final w = client.warnings.listen(warnings.add);
      final l = client.lifecycle.listen(lifecycle.add);

      latest().receive({
        'type': ServerMessageType.error,
        'code': SignalingErrorCode.tokenInvalid,
        'message': 'mismatched token',
      });
      await Future<void>.delayed(Duration.zero);

      expect(warnings.single.code, SwalvoWarningCode.tokenRefreshFailed);
      expect(lifecycle, isEmpty);
      expect(client.isJoined, isTrue);
      await w.cancel();
      await l.cancel();
      await client.dispose();
    });

    test('warns when expiring with no refreshToken', () async {
      final client = clientFor();
      await joinWith(client);
      final warnings = <SwalvoWarning>[];
      final w = client.warnings.listen(warnings.add);

      latest().receive({
        'type': ServerMessageType.tokenExpiring,
        'expiresAt': '2026-10-02T12:00:00.000Z',
      });
      await Future<void>.delayed(Duration.zero);

      expect(warnings.single.code, SwalvoWarningCode.tokenExpiring);
      await w.cancel();
      await client.dispose();
    });
  });

  group('session resume (§1.2)', () {
    test('offers the resume token and reports resumed', () async {
      final client = clientFor();
      await joinWith(client, resumeToken: 'resume-1');
      latest().receive({
        'type': ServerMessageType.roomResumeToken,
        'resumeToken': 'resume-rotated',
      });
      final lifecycle = <SignalingLifecycle>[];
      final joins = <JoinedPayload>[];
      final l = client.lifecycle.listen(lifecycle.add);
      final j = client.joins.listen(joins.add);

      final before = sockets.length;
      latest().drop(1006);
      final next = await nextSocket(before);

      expect((lifecycle.first as SignalingReconnecting).resuming, isTrue);
      expect(next.lastSent(ClientMessageType.roomJoin)!['resume'],
          {'token': 'resume-rotated'});

      next.receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
        'resumed': true,
      });
      await Future<void>.delayed(Duration.zero);
      expect(joins.single.resumed, isTrue);

      await l.cancel();
      await j.cancel();
      await client.dispose();
    });

    test('a first join never claims to be resumed', () async {
      final client = clientFor();
      final joining = client.connect();
      await Future<void>.delayed(Duration.zero);
      expect(latest().lastSent(ClientMessageType.roomJoin)!['resume'], isNull);
      latest().receive({
        'type': ServerMessageType.roomJoined,
        'roomId': 'room-1',
        'participants': [],
        'resumed': true,
      });
      expect((await joining).resumed, isFalse);
      await client.dispose();
    });
  });

  group('close codes (§1.3, §1.5)', () {
    test('1012 reconnects within two seconds, with resume', () async {
      final client = clientFor();
      await joinWith(client, resumeToken: 'resume-1');

      final before = sockets.length;
      latest().drop(CloseCode.serviceRestart);
      final next =
          await nextSocket(before, timeout: const Duration(milliseconds: 2500));

      expect(next.lastSent(ClientMessageType.roomJoin)!['resume'],
          {'token': 'resume-1'});
      await client.dispose();
    });

    test('4003 ends the session and never reconnects', () async {
      final client = clientFor();
      await joinWith(client);
      final lifecycle = <SignalingLifecycle>[];
      final l = client.lifecycle.listen(lifecycle.add);

      final before = sockets.length;
      latest().drop(CloseCode.removed);
      await Future<void>.delayed(const Duration(milliseconds: 400));

      expect((lifecycle.single as SignalingEnded).reason,
          SwalvoDisconnectReason.removed);
      expect(sockets, hasLength(before));
      await l.cancel();
      await client.dispose();
    });

    test('room.left carries its reason through', () async {
      final client = clientFor();
      await joinWith(client);
      final lifecycle = <SignalingLifecycle>[];
      final l = client.lifecycle.listen(lifecycle.add);

      latest().receive(
          {'type': ServerMessageType.roomLeft, 'reason': 'ROOM_CLOSED'});
      await Future<void>.delayed(Duration.zero);

      expect((lifecycle.single as SignalingEnded).reason,
          SwalvoDisconnectReason.roomClosed);
      await l.cancel();
      await client.dispose();
    });

    test('4001 refreshes, then reconnects fresh', () async {
      final fresh = tokenFor('after-4001');
      var refreshes = 0;
      final client = clientFor(refreshToken: () async {
        refreshes++;
        return fresh;
      });
      await joinWith(client, resumeToken: 'resume-1');

      final before = sockets.length;
      latest().receive({
        'type': ServerMessageType.error,
        'code': SignalingErrorCode.tokenExpired,
        'message': 'expired',
      });
      latest().drop(CloseCode.authFailed);
      final next = await nextSocket(before);

      expect(refreshes, 1);
      expect(urls.last, contains(Uri.encodeQueryComponent(fresh)));
      expect(next.lastSent(ClientMessageType.roomJoin)!['resume'], isNull);
      await client.dispose();
    });

    test('4001 without a refresher fails with tokenExpired', () async {
      final client = clientFor();
      await joinWith(client);
      final lifecycle = <SignalingLifecycle>[];
      final l = client.lifecycle.listen(lifecycle.add);

      final before = sockets.length;
      latest().drop(CloseCode.authFailed);
      await Future<void>.delayed(const Duration(milliseconds: 400));

      final failed = lifecycle.single as SignalingFailed;
      expect(failed.reason, SwalvoDisconnectReason.tokenExpired);
      expect(failed.error.code.name, 'tokenExpired');
      expect(sockets, hasLength(before));
      await l.cancel();
      await client.dispose();
    });

    test('rejoin() abandons the session and joins without resume', () async {
      final client = clientFor();
      await joinWith(client, resumeToken: 'resume-1');
      final first = latest();

      final before = sockets.length;
      client.rejoin();
      final next = await nextSocket(before);

      expect(first.closeCalled, isTrue);
      expect(next.lastSent(ClientMessageType.roomJoin)!['resume'], isNull);
      await client.dispose();
    });
  });
}

final urls = <String>[];
