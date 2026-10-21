import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_chat/swalvo_chat.dart';
// src-level import, on purpose: `LiveStreamRoomCleanup` and
// `connectChatOrCleanUp` are deliberately not re-exported from
// `package:swalvo_live/swalvo_live.dart` (see that barrel file's own
// comment) — this is a @visibleForTesting seam, not part of the real
// public surface, the same convention swalvo_rtc's own tests use to reach
// SignalingClient.
import 'package:swalvo_live/src/live_stream.dart';

/// A fake room handle a test can hand to
/// [SwalvoLiveStream.connectChatOrCleanUp] — see that function's own doc
/// for why a real `SwalvoRoom` can't be constructed here at all (its
/// constructor is private to swalvo_rtc, and there is no supported way to
/// join one without a real signaling round trip).
class _FakeRoomCleanup implements LiveStreamRoomCleanup {
  bool leaveCalled = false;
  bool disposeCalled = false;
  // Records the order the two calls happen in: leave() must complete
  // before dispose() is reached, matching SwalvoRoom's own documented
  // leave-then-dispose discipline everywhere else it's used.
  final order = <String>[];

  @override
  Future<void> leave() async {
    leaveCalled = true;
    order.add('leave');
  }

  @override
  void dispose() {
    disposeCalled = true;
    order.add('dispose');
  }
}

/// A `SwalvoChat` whose `connect()` fails deterministically and
/// immediately: `connectChannel` throwing synchronously is caught by
/// `_openSocket`'s own try/catch and rethrown as a `SwalvoChatException`
/// before any network, timer, or fake socket is ever needed — no
/// `FakeChatSocket` required (that helper lives in swalvo_chat's own
/// test/, which isn't importable from here, same package-privacy rule
/// this seam itself exists to work around on the swalvo_rtc side).
SwalvoChat _chatThatFailsToConnect() => SwalvoChat(
      token: 'test-token',
      apiUrl: 'https://api.example.test',
      connectChannel: (uri) => throw Exception('connection refused'),
    );

/// `ChangeNotifier.addListener` asserts the notifier hasn't been disposed
/// — the standard Flutter-test way to prove `dispose()` actually ran,
/// since `SwalvoChat` exposes no public `isDisposed` getter of its own.
void _expectDisposed(SwalvoChat chat) {
  expect(() => chat.addListener(() {}), throwsAssertionError);
}

void main() {
  group('SwalvoLiveStream.connectChatOrCleanUp', () {
    test(
        'REGRESSION: a chat connection that fails after the room already '
        'joined leaves and disposes the room, and disposes chat, before '
        'rethrowing', () async {
      // This is the exact shape of the bug: SwalvoLiveStream.join()'s
      // RTC+chat path used to leave+dispose the room on a chat-connect
      // failure (correct) but drop `chat` on the floor — a leaked
      // SwalvoRestClient and any timer connect() armed before failing.
      final room = _FakeRoomCleanup();
      final chat = _chatThatFailsToConnect();

      await expectLater(
        SwalvoLiveStream.connectChatOrCleanUp(
          chat: chat,
          conversation: 'conv_1',
          room: room,
        ),
        throwsA(isA<SwalvoChatException>()),
      );

      expect(room.leaveCalled, isTrue,
          reason: 'the joined room must still be left on a chat failure');
      expect(room.disposeCalled, isTrue,
          reason: 'the joined room must still be disposed on a chat failure');
      expect(room.order, ['leave', 'dispose'],
          reason: 'leave() must complete before dispose() — same order '
              'SwalvoRoom teardown uses everywhere else');
      _expectDisposed(chat);
    });

    test(
        'REGRESSION: a room-less (BROADCAST/HLS viewer) chat connection '
        'that fails disposes chat and touches no room, before rethrowing',
        () async {
      // The second site of the same bug: _connectChat (no SwalvoRoom at
      // all — a pure HLS viewer with a chat conversation attached) had no
      // try/catch whatsoever around chat.connect(), so this leak was
      // actually worse here: nothing even attempted cleanup.
      final chat = _chatThatFailsToConnect();

      await expectLater(
        SwalvoLiveStream.connectChatOrCleanUp(
          chat: chat,
          conversation: 'conv_1',
          room: null,
        ),
        throwsA(isA<SwalvoChatException>()),
      );

      _expectDisposed(chat);
    });
  });
}
