import 'dart:async';

import 'errors.dart';
import 'seq.dart';

/// How many events to ask for per catch-up request. The server caps it at
/// 500.
const eventPageSize = 500;

/// One page of the server's per-conversation event log:
/// `GET …/events?afterEventSeq=N` → `{ events, hasMore }`.
class EventPage {
  const EventPage(this.events, {this.hasMore = false});

  factory EventPage.fromJson(Map<String, dynamic> json) => EventPage(
        (json['events'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .toList(growable: false),
        hasMore: json['hasMore'] as bool? ?? false,
      );

  /// `{ eventSeq, type, payload, createdAt }` records.
  final List<Map<String, dynamic>> events;
  final bool hasMore;
}

class EventCatchUpResult {
  const EventCatchUpResult(
    this.room, {
    this.applied = 0,
    this.expired = false,
    this.error,
  });

  final String room;
  final int applied;

  /// The resume point had aged out of the log; history was re-read.
  final bool expired;
  final SwalvoChatException? error;
}

class _RoomSequence {
  BigInt? last;
  bool syncing = false;
  final held = <BigInt, Map<String, dynamic>>{};
  Timer? gapTimer;
  Future<EventCatchUpResult>? running;
}

/// Keeps every conversation's events in `eventSeq` order, and fills holes.
///
/// A port of `@swalvo/chat`'s `internal/event-sequencer.ts`. Message
/// replay recovers missed *messages*; this recovers everything else — an
/// edit, a delete, a reaction or a ban that happened while the socket was
/// down — from the server's 7-day event log (Phase 3 §1).
///
/// 1. **Orders.** A sequenced frame is applied only once every frame
///    before it has been. One that arrives early is held.
/// 2. **De-duplicates.** A frame at or below the high-water mark has
///    already been applied and is dropped.
/// 3. **Backfills.** A hole that does not close by itself within
///    [gapFillDelay] is filled from the log. Two API instances can publish
///    one conversation's events in the opposite order to their seqs, so a
///    short wait turns "one REST call per reorder" into "none".
///
/// Some holes stay holes: events from a user this user blocked are never
/// delivered to them. When the log has been read to its end, a remaining
/// hole is one of those and the mark moves past it.
class EventSequencer {
  EventSequencer({
    required this.fetchEvents,
    required this.apply,
    required this.onExpired,
    required this.isConnected,
    this.gapFillDelay = const Duration(milliseconds: 300),
    this.maxAttempts = 3,
    Duration Function(int attempt)? retryDelay,
  }) : retryDelay = retryDelay ??
            ((attempt) => Duration(
                milliseconds: (500 * (1 << (attempt - 1))).clamp(0, 5000)));

  final Future<EventPage> Function(String room, String afterEventSeq, int limit)
      fetchEvents;

  /// Hands a frame to the client's ordinary frame handling.
  final void Function(Map<String, dynamic> frame) apply;

  /// The log no longer reaches the resume point (`EVENTS_EXPIRED`).
  final Future<void> Function(String room) onExpired;
  final bool Function() isConnected;
  final Duration gapFillDelay;
  final int maxAttempts;
  final Duration Function(int attempt) retryDelay;

  final _rooms = <String, _RoomSequence>{};

  String? lastEventSeq(String room) => _rooms[room]?.last?.toString();

  /// Rooms with a resume point.
  List<String> knownRooms() => _rooms.entries
      .where((entry) => entry.value.last != null)
      .map((entry) => entry.key)
      .toList();

  /// Seeds a room's resume point from a join response, never moving one
  /// that already exists.
  void baseline(String room, Object? eventSeq) {
    final seq = parseSeq(eventSeq);
    if (seq == null) return;
    final state = _state(room);
    state.last ??= seq;
  }

  /// Feeds one live frame through: applies, holds, or drops it. A frame
  /// without an `eventSeq` (typing, presence, an older server) is applied
  /// as-is.
  void ingest(String room, Map<String, dynamic> frame) {
    final seq = parseSeq(frame['eventSeq']);
    if (seq == null) {
      apply(frame);
      return;
    }
    final state = _state(room);

    if (state.syncing) {
      state.held[seq] = frame;
      return;
    }

    final last = state.last;
    if (last == null) {
      state.last = seq;
      apply(frame);
      return;
    }
    if (seq <= last) return;
    if (seq == last + BigInt.one) {
      state.last = seq;
      apply(frame);
      _drainContiguous(state);
      if (state.held.isEmpty) _clearGapTimer(state);
      return;
    }

    state.held[seq] = frame;
    _armGapTimer(room, state);
  }

  /// Marks rooms syncing ahead of a reconnect's catch-up, so frames that
  /// arrive during the rejoin are held rather than applied ahead of the
  /// older events the catch-up is about to read.
  void beginSync(Iterable<String> rooms) {
    for (final room in rooms) {
      final state = _rooms[room];
      if (state != null && state.last != null) state.syncing = true;
    }
  }

  /// Reads everything after the room's resume point and applies it in
  /// order, then releases whatever was held. Concurrent calls share one
  /// run.
  Future<EventCatchUpResult> catchUp(String room) {
    final state = _state(room);
    final existing = state.running;
    if (existing != null) return existing;

    _clearGapTimer(state);
    state.syncing = true;
    final running = _run(room, state).whenComplete(() {
      state.syncing = false;
      state.running = null;
      _release(state);
    });
    state.running = running;
    return running;
  }

  void forget(String room) {
    final state = _rooms.remove(room);
    if (state != null) _clearGapTimer(state);
  }

  /// Stops timers; resume points survive.
  void pause() {
    for (final state in _rooms.values) {
      _clearGapTimer(state);
    }
  }

  Future<EventCatchUpResult> _run(String room, _RoomSequence state) async {
    if (state.last == null) return EventCatchUpResult(room);

    var applied = 0;
    var attempt = 0;

    for (;;) {
      if (!isConnected()) return EventCatchUpResult(room, applied: applied);

      final after = state.last ?? BigInt.zero;
      EventPage page;
      try {
        page = await fetchEvents(room, after.toString(), eventPageSize);
        attempt = 0;
      } on SwalvoChatException catch (error) {
        if (error.code == SwalvoChatErrorCode.eventsExpired) {
          // The resume point is useless now; whatever is held becomes the
          // new starting point when released.
          state.last = null;
          try {
            await onExpired(room);
          } on SwalvoChatException catch (resyncError) {
            return EventCatchUpResult(room,
                applied: applied, expired: true, error: resyncError);
          }
          return EventCatchUpResult(room, applied: applied, expired: true);
        }
        attempt += 1;
        if (attempt >= maxAttempts) {
          return EventCatchUpResult(room, applied: applied, error: error);
        }
        await Future<void>.delayed(retryDelay(attempt));
        continue;
      }

      final records = <(BigInt, Map<String, dynamic>)>[];
      for (final record in page.events) {
        final seq = parseSeq(record['eventSeq']);
        if (seq != null) records.add((seq, record));
      }
      records.sort((a, b) => a.$1.compareTo(b.$1));

      var advanced = false;
      for (final (seq, record) in records) {
        final last = state.last;
        if (last != null && seq <= last) continue;
        state.last = seq;
        advanced = true;
        state.held.remove(seq);
        apply(_toFrame(record));
        applied += 1;
      }

      if (!page.hasMore || !advanced) {
        return EventCatchUpResult(room, applied: applied);
      }
    }
  }

  /// Applies what was held, in seq order, stepping over holes the log has
  /// just confirmed it is never going to fill.
  void _release(_RoomSequence state) {
    if (state.held.isEmpty) return;
    final held = state.held.entries.toList()
      ..sort((a, b) => a.key.compareTo(b.key));
    state.held.clear();
    for (final entry in held) {
      final last = state.last;
      if (last != null && entry.key <= last) continue;
      state.last = entry.key;
      apply(entry.value);
    }
  }

  void _drainContiguous(_RoomSequence state) {
    for (;;) {
      final last = state.last;
      if (last == null) return;
      final next = last + BigInt.one;
      final frame = state.held.remove(next);
      if (frame == null) return;
      state.last = next;
      apply(frame);
    }
  }

  void _armGapTimer(String room, _RoomSequence state) {
    if (state.gapTimer != null) return;
    state.gapTimer = Timer(gapFillDelay, () {
      state.gapTimer = null;
      if (state.held.isEmpty) return;
      unawaited(catchUp(room));
    });
  }

  void _clearGapTimer(_RoomSequence state) {
    state.gapTimer?.cancel();
    state.gapTimer = null;
  }

  _RoomSequence _state(String room) =>
      _rooms.putIfAbsent(room, _RoomSequence.new);
}

/// An event-log record as the live frame it was: the log stores the
/// frame's body as `payload`, so this is a merge, not a translation.
Map<String, dynamic> _toFrame(Map<String, dynamic> record) => {
      ...?(record['payload'] as Map<String, dynamic>?),
      'type': record['type'],
      'eventSeq': '${record['eventSeq']}',
    };
