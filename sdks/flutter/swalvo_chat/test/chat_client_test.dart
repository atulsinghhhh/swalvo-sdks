import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_chat/swalvo_chat.dart';

import 'helpers/fake_chat_socket.dart';

/// Protocol-level tests for the two things a real integration gets wrong
/// first: typing signals refused by the server's rate limit, and presence
/// quietly lost the moment the socket blinks.
void main() {
  late List<FakeChatSocket> sockets;

  /// A connected client, plus the socket it is holding.
  Future<({SwalvoChat chat, FakeChatSocket socket})> connected({
    String room = 'conv_1',
  }) async {
    sockets = [];
    final chat = SwalvoChat(
      token: 'test-token',
      apiUrl: 'https://api.example.test',
      connectChannel: (uri) {
        final socket = FakeChatSocket();
        sockets.add(socket);
        // The server's hello has to land after the client has subscribed,
        // which happens synchronously just after this factory returns.
        scheduleMicrotask(socket.acceptConnection);
        return socket;
      },
    );

    final connecting = chat.connect(room);
    // `connect()` awaits the hello, then the room join's ack.
    await Future<void>.delayed(Duration.zero);
    sockets.last.ackPending();
    await connecting;

    return (chat: chat, socket: sockets.last);
  }

  group('startTyping is throttled to what the server will accept', () {
    test(
        'REGRESSION: a burst of keystrokes sends one frame, not one per keystroke',
        () async {
      final context = await connected();

      // What "safe to call on every keystroke" actually looks like. Sent
      // unthrottled, this is 10 of the 20 frames per 10s the server
      // allows, and a real sentence blows straight through it.
      for (var i = 0; i < 10; i++) {
        await context.chat.startTyping();
      }

      expect(context.socket.ofType('typing.start'), hasLength(1));

      context.chat.dispose();
    });

    test('stopping and starting again signals immediately', () async {
      final context = await connected();

      await context.chat.startTyping();
      await context.chat.stopTyping();
      await context.chat.startTyping();

      // The throttle must not swallow a genuine new transition: the
      // indicator has already been cleared, so this one carries
      // information the previous window's frames did not.
      expect(context.socket.ofType('typing.start'), hasLength(2));
      expect(context.socket.ofType('typing.stop'), hasLength(1));

      context.chat.dispose();
    });

    test('each room is throttled on its own', () async {
      final context = await connected();

      await context.chat.startTyping(room: 'conv_1');
      await context.chat.startTyping(room: 'conv_2');

      // Two different conversations, two different indicators. Sharing
      // one window between them would hide the second entirely.
      expect(context.socket.ofType('typing.start'), hasLength(2));

      context.chat.dispose();
    });
  });

  group('presence survives a reconnect', () {
    test(
        'REGRESSION: presence set before a drop is re-asserted on the new socket',
        () async {
      final context = await connected();
      await context.chat.setPresence(SwalvoPresenceStatus.online);
      expect(context.socket.ofType('presence.set'), hasLength(1));

      // The network drops. The client reconnects onto a brand new socket,
      // which knows nothing about what was set on the old one — so
      // without re-asserting, this user is invisible to everybody else
      // for the rest of the session while still reading `connected`.
      context.socket.drop(1006);
      await Future<void>.delayed(const Duration(milliseconds: 700));
      expect(sockets, hasLength(2),
          reason: 'the client should have reconnected by now');

      final reconnected = sockets.last;
      reconnected.ackPending();
      await Future<void>.delayed(Duration.zero);

      expect(reconnected.ofType('presence.set'), hasLength(1));
      expect(
        reconnected.ofType('presence.set').single['status'],
        SwalvoPresenceStatus.online.name,
      );

      // Ahead of the rejoin, so the server never processes a join for
      // somebody it currently believes is absent.
      final types = reconnected.sent.map((frame) => frame['type']).toList();
      expect(
          types.indexOf('presence.set'), lessThan(types.indexOf('room.join')));

      context.chat.dispose();
    });

    test('a client that never set presence stays silent about it', () async {
      final context = await connected();

      context.socket.drop(1006);
      await Future<void>.delayed(const Duration(milliseconds: 700));
      expect(sockets, hasLength(2));

      // Announcing a status nobody chose would invent one — and would
      // make a deliberately invisible client (a moderation view, a bot)
      // impossible to build.
      expect(sockets.last.ofType('presence.set'), isEmpty);

      context.chat.dispose();
    });
  });

  group('dispose() lifecycle races', () {
    test(
        'REGRESSION: dispose() while connect() is still awaiting the '
        "server's hello fails that connect() instead of hanging forever",
        () async {
      // _teardownSocket cancels the socket subscription before closing it,
      // on purpose, so the close it triggers doesn't drive a reconnect.
      // That also skipped the only other code that completes/fails the
      // `_connected` completer connect() is awaiting — so a dispose() (or
      // disconnect()) arriving before the server's hello ever used to
      // leave that await parked forever: no error, no success.
      final chat = SwalvoChat(
        token: 'test-token',
        apiUrl: 'https://api.example.test',
        // Never calls acceptConnection: the hello never arrives.
        connectChannel: (uri) => FakeChatSocket(),
      );

      final connecting = chat.connect('conv_1');
      await Future<void>.delayed(Duration.zero);

      chat.dispose();

      await expectLater(
        connecting.timeout(const Duration(milliseconds: 500)),
        throwsA(isA<SwalvoChatException>()),
      );
    });

    test(
        'REGRESSION: dispose() fails a pending request immediately rather '
        'than waiting out requestTimeout', () async {
      final context = await connected();

      // Never acked: this request is left pending exactly as it would be
      // if dispose() arrived mid-flight.
      final pending = context.chat.markAsRead('msg_1');
      await Future<void>.delayed(Duration.zero);

      context.chat.dispose();

      // requestTimeout defaults to 15s; a `connected()`-sized client was
      // given no override. Succeeding well inside that window proves
      // dispose() actively failed the request rather than this just being
      // the natural timeout arriving early.
      await expectLater(
        pending.timeout(const Duration(milliseconds: 500)),
        throwsA(isA<SwalvoChatException>()),
      );
    });
  });

  group('connection-failure handling', () {
    test(
        'REGRESSION: connecting reads channel.ready, so a failed attempt '
        "has somewhere to attach an error handler", () async {
      // web_socket_channel's real `WebSocketChannel.connect` (the default
      // `connectChannel`) completes `channel.ready` with an error when the
      // underlying connection attempt fails — a completer on a *separate*
      // Future from `stream`, which is the only thing this client used to
      // listen to. Confirmed live on a real device: every failed
      // connection attempt (connection refused, a dropped network, a
      // server restart — all ordinary, frequent events) surfaced as a
      // top-level "Unhandled Exception" in the Flutter log, because
      // nothing in this class ever read `ready`. An app wiring its crash
      // reporter to the zone's uncaught-error handler — the normal setup —
      // would count every one of those as a crash.
      //
      // Whether the attached handler actually suppresses Dart's unhandled-
      // error report isn't something this test asserts directly: that
      // report is a best-effort, timing-dependent diagnostic (observed
      // experimentally to sometimes land on whichever test happens to be
      // running when Dart gets around to emitting it, not necessarily this
      // one), not a deterministic language guarantee a unit test can key
      // on. What *is* deterministic, and what regressed, is whether
      // `_openSocket` reads `ready` at all — before this fix, it never
      // did, so no handler ever had anywhere to go.
      final socket = FakeChatSocket()
        ..readyError = Exception('connection refused');
      final chat = SwalvoChat(
        token: 'test-token',
        apiUrl: 'https://api.example.test',
        connectChannel: (uri) => socket,
      );

      // dispose() below will correctly fail this still-pending connect()
      // (the fix in the "dispose() lifecycle races" group above) — caught
      // here so that expected failure doesn't itself surface as this
      // test's own unhandled error.
      unawaited(chat.connect('conv_1').catchError((_) {}));
      // _openSocket reads `channel.ready` synchronously, before its first
      // await — no delay needed for this to already be true.
      expect(socket.readyAccessed, isTrue);

      chat.dispose();
    });
  });
}
