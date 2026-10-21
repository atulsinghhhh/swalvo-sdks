import 'dart:collection';

import 'errors.dart';
import 'models.dart';
import 'phase3_models.dart';

/// How many messages to pull per catch-up request.
const _recoveryPageSize = 100;

/// How many message ids to remember per room for de-duplication.
///
/// Only has to cover the overlap between what arrived live and what a
/// catch-up re-reads, which is bounded by one outage, not by history. The
/// cap is what stops a long-lived client growing a set forever.
const _seenIdsPerRoom = 1000;

/// Remembers where each room got to, and replays what was missed.
///
/// A straight port of `@swalvo/chat`'s `internal/recovery.ts`, and for
/// the same reasons:
///
/// * **A cursor per room**, not one per connection: rooms advance at
///   different rates, and one shared resume point would be pinned to the
///   quietest, re-reading the busy ones from far too early.
/// * **The server's cursor**, not a local timestamp: `createdAt` is not
///   unique, and resuming from a bare timestamp either skips or repeats a
///   message that landed in the same millisecond. The cursor is the
///   `(createdAt, publicId)` pair the history endpoint paginates on.
/// * **Client state only.** The server keeps no per-client position and
///   behaves identically whether anybody ever reconnects.
class RecoveryTracker {
  RecoveryTracker({
    required this.listMessages,
    required this.deliver,
    required this.isConnected,
    this.maxAttempts = 3,
    Duration Function(int attempt)? retryDelay,
  }) : retryDelay = retryDelay ??
            ((attempt) => Duration(
                milliseconds: (500 * (1 << (attempt - 1))).clamp(0, 5000)));

  /// The same authorized history call a developer would make.
  final Future<SwalvoMessagePage> Function(String room, String after, int limit)
      listMessages;

  /// Delivers a recovered message exactly like a live one.
  final void Function(SwalvoMessage message) deliver;
  final bool Function() isConnected;
  final int maxAttempts;
  final Duration Function(int attempt) retryDelay;

  final _cursors = <String, _ResumePoint>{};
  final _seen = <String, LinkedHashSet<String>>{};

  /// Records a delivered message and reports whether it is new. Every
  /// delivery path goes through here, so "have I already shown this?" has
  /// one answer.
  bool accept(SwalvoMessage message) {
    final ids = _seen.putIfAbsent(message.roomId, LinkedHashSet<String>.new);
    if (ids.contains(message.id)) return false;
    ids.add(message.id);
    if (ids.length > _seenIdsPerRoom) ids.remove(ids.first);
    _advance(message);
    return true;
  }

  /// Notes how far a history page reached, without claiming its messages
  /// were delivered — so a quiet room has a resume point too.
  void observeHistory(Iterable<SwalvoMessage> messages) {
    for (final message in messages) {
      _advance(message);
    }
  }

  bool has(String room) => _cursors.containsKey(room);

  void forget(String room) {
    _cursors.remove(room);
    _seen.remove(room);
  }

  /// Moves a room's resume point forward, never backwards. "Newer" is
  /// decided on `createdAt` then `id` — the server keyset's order — not on
  /// the opaque cursor string.
  void _advance(SwalvoMessage message) {
    final cursor = message.cursor;
    if (cursor == null || cursor.isEmpty) return;
    final next = _ResumePoint(cursor, message.createdAt, message.id);
    final current = _cursors[message.roomId];
    if (current == null || next.isNewerThan(current)) {
      _cursors[message.roomId] = next;
    }
  }

  /// Replays everything a room missed, oldest first, paging forward until
  /// the server says there is no more.
  Future<SwalvoRoomRecoveryResult> recoverRoom(String room) async {
    var cursor = _cursors[room]?.cursor;
    if (cursor == null) return SwalvoRoomRecoveryResult(room: room);

    var recovered = 0;
    var attempt = 0;

    for (;;) {
      if (!isConnected()) {
        return SwalvoRoomRecoveryResult(room: room, recovered: recovered);
      }

      SwalvoMessagePage page;
      try {
        page = await listMessages(room, cursor!, _recoveryPageSize);
        attempt = 0;
      } on SwalvoChatException catch (error) {
        if (error.code == SwalvoChatErrorCode.invalidCursor) {
          // Unusable resume point. Say plainly that there is a hole rather
          // than risk an unbounded "replay everything".
          _cursors.remove(room);
          return SwalvoRoomRecoveryResult(
              room: room, recovered: recovered, gap: true, error: error);
        }
        attempt += 1;
        if (attempt >= maxAttempts) {
          return SwalvoRoomRecoveryResult(
              room: room, recovered: recovered, error: error);
        }
        await Future<void>.delayed(retryDelay(attempt));
        continue;
      }

      if (page.messages.isEmpty) {
        return SwalvoRoomRecoveryResult(room: room, recovered: recovered);
      }

      // History comes back newest-first; deliver oldest-first.
      for (final message in page.messages.reversed) {
        if (accept(message)) {
          deliver(message);
          recovered += 1;
        }
      }

      final next = page.previousCursor;
      if (!page.hasMore || next == null || next == cursor) {
        return SwalvoRoomRecoveryResult(room: room, recovered: recovered);
      }
      cursor = next;
    }
  }
}

class _ResumePoint {
  const _ResumePoint(this.cursor, this.createdAt, this.id);

  final String cursor;
  final DateTime createdAt;
  final String id;

  bool isNewerThan(_ResumePoint other) {
    if (createdAt != other.createdAt) return createdAt.isAfter(other.createdAt);
    return id.compareTo(other.id) > 0;
  }
}
