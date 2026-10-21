import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/swalvo_rtc.dart';

import 'helpers/fake_socket.dart';

/// `Swalvo.join()`'s client-side room/token precheck (spec: matches the
/// web SDK's `assertTokenMatchesRoom` exactly).
///
/// A token names its room by *two* claims: `rid` (an internal id) and
/// `rnm` (a human name) — a live stream's RTC token, for instance, is
/// minted against its underlying room's internal id, but the value an
/// application actually has in hand to join with is the stream's own
/// public id, which is what the room's `name` was set to. Checking `rid`
/// alone (the bug this regression-tests) rejected that case outright:
/// every live stream, always, since a stream's public id is never its
/// underlying room's internal id. `port 1` is used for the "not
/// rejected" cases so a real (fast, ECONNREFUSED) connection failure
/// distinguishes itself from the precheck without waiting out the real
/// 10s open timeout.
void main() {
  const unreachableEndpoint = 'ws://127.0.0.1:1/v1/rtc';

  Matcher isRoomNotFound() => isA<SwalvoException>()
      .having((e) => e.code, 'code', SwalvoErrorCode.roomNotFound);

  group('Swalvo.join room/token precheck', () {
    test(
        'accepts a roomId matching the token\'s room name (rnm), not only its internal id (rid)',
        () async {
      final token = fakeToken({
        'rid': 'room-internal-uuid',
        'rnm': 'stream_public_id',
        'sub': 'alice'
      });
      final swalvo = Swalvo(token: token, endpoint: unreachableEndpoint);

      await expectLater(
          swalvo.join('stream_public_id'), throwsA(isNot(isRoomNotFound())));
    });

    test('accepts a roomId matching the internal id (rid) too', () async {
      final token = fakeToken({
        'rid': 'room-internal-uuid',
        'rnm': 'stream_public_id',
        'sub': 'alice'
      });
      final swalvo = Swalvo(token: token, endpoint: unreachableEndpoint);

      await expectLater(
          swalvo.join('room-internal-uuid'), throwsA(isNot(isRoomNotFound())));
    });

    test('rejects a roomId matching neither claim', () async {
      final token = fakeToken({
        'rid': 'room-internal-uuid',
        'rnm': 'stream_public_id',
        'sub': 'alice'
      });
      final swalvo = Swalvo(token: token, endpoint: unreachableEndpoint);

      await expectLater(
          swalvo.join('totally-different-room'), throwsA(isRoomNotFound()));
    });

    test(
        'skips the room-match check entirely for a token carrying neither claim',
        () async {
      final token = fakeToken({'sub': 'alice'});
      final swalvo = Swalvo(token: token, endpoint: unreachableEndpoint);

      // Not rejected as roomNotFound — but such a token names no room at
      // all, so it still can't actually join one; see the next test.
      await expectLater(
          swalvo.join('whatever-room'), throwsA(isNot(isRoomNotFound())));
    });

    test(
        'a token with no rid cannot join at all, even if the caller-supplied roomId matches rnm',
        () async {
      // A token naming no internal id has nothing this SDK can put on
      // the wire: the room.join message's roomId is always the token's
      // own rid (see join()'s doc comment), never the caller's string,
      // exactly like the web SDK's roomIdFromToken().
      final token = fakeToken({'rnm': 'stream_public_id', 'sub': 'alice'});
      final swalvo = Swalvo(token: token, endpoint: unreachableEndpoint);

      await expectLater(
        swalvo.join('stream_public_id'),
        throwsA(isA<SwalvoException>()
            .having((e) => e.code, 'code', SwalvoErrorCode.invalidToken)),
      );
    });

    test(
        'join() with no roomId defaults to the token\'s own room (matches web SDK\'s client.join())',
        () async {
      // A live-stream viewer's credential never names the edge room it
      // actually lands on (agora-parity-audit.md §D) — the SDK has to be
      // able to join with nothing but the token, exactly like the web
      // SDK's roomFromToken() default.
      final token = fakeToken({
        'rid': 'edge-room-uuid',
        'rnm': 'stream_abc123__e2',
        'sub': 'alice'
      });
      final swalvo = Swalvo(token: token, endpoint: unreachableEndpoint);

      await expectLater(swalvo.join(), throwsA(isNot(isRoomNotFound())));
    });

    test('join() with no roomId and no rid in the token cannot join at all',
        () async {
      final token = fakeToken({'rnm': 'stream_public_id', 'sub': 'alice'});
      final swalvo = Swalvo(token: token, endpoint: unreachableEndpoint);

      await expectLater(
        swalvo.join(),
        throwsA(isA<SwalvoException>()
            .having((e) => e.code, 'code', SwalvoErrorCode.invalidToken)),
      );
    });
  });
}
