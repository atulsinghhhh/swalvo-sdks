import 'dart:async';
import 'dart:math';

import 'errors.dart';
import 'models.dart';

/// Where a queued send is in its life.
///
/// * [pending]: waiting for a connection. Sent automatically on
///   (re)connect.
/// * [sending]: on the wire right now.
/// * [failed]: the server refused it (muted, too large, blocked by the
///   moderation hook…). Nothing retries it by itself; [SwalvoOutbox.retry]
///   or [SwalvoOutbox.cancel] are the app's to choose.
///
/// A message that was stored leaves the outbox: from then on it is an
/// ordinary [SwalvoMessage] on the `messages` stream.
enum SwalvoOutboxStatus { pending, sending, failed }

/// A send that has not been confirmed stored yet. Plain JSON, so any
/// storage can hold it.
class SwalvoOutboxEntry {
  SwalvoOutboxEntry({
    required this.clientMessageId,
    required this.room,
    required this.userId,
    required this.createdAt,
    this.text,
    this.replyTo,
    this.attachmentId,
    this.metadata,
    this.mentions,
    this.status = SwalvoOutboxStatus.pending,
    this.attempts = 0,
    this.errorCode,
    this.errorMessage,
  });

  factory SwalvoOutboxEntry.fromJson(Map<String, dynamic> json) =>
      SwalvoOutboxEntry(
        clientMessageId: json['clientMessageId'] as String,
        room: json['room'] as String,
        userId: json['userId'] as String? ?? '',
        createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ??
            DateTime.now(),
        text: json['text'] as String?,
        replyTo: json['replyTo'] as String?,
        attachmentId: json['attachmentId'] as String?,
        metadata: json['metadata'] as Map<String, dynamic>?,
        mentions:
            (json['mentions'] as List<dynamic>?)?.whereType<String>().toList(),
        status: SwalvoOutboxStatus.values.firstWhere(
          (value) => value.name == json['status'],
          orElse: () => SwalvoOutboxStatus.pending,
        ),
        attempts: (json['attempts'] as num?)?.toInt() ?? 0,
        errorCode: json['errorCode'] as String?,
        errorMessage: json['errorMessage'] as String?,
      );

  /// The idempotency key, and this entry's id. However many times an entry
  /// goes out, the server stores it once.
  final String clientMessageId;
  final String room;

  /// Whose send this is, so storage shared by several accounts never
  /// replays one user's messages as another.
  final String userId;
  final DateTime createdAt;
  final String? text;
  final String? replyTo;
  final String? attachmentId;
  final Map<String, dynamic>? metadata;
  final List<String>? mentions;
  SwalvoOutboxStatus status;
  int attempts;

  /// The server's code for the last failure (`MUTED`, `NETWORK_ERROR`…).
  String? errorCode;
  String? errorMessage;

  Map<String, dynamic> toJson() => {
        'clientMessageId': clientMessageId,
        'room': room,
        'userId': userId,
        'createdAt': createdAt.toIso8601String(),
        if (text != null) 'text': text,
        if (replyTo != null) 'replyTo': replyTo,
        if (attachmentId != null) 'attachmentId': attachmentId,
        if (metadata != null) 'metadata': metadata,
        if (mentions != null) 'mentions': mentions,
        'status': status.name,
        'attempts': attempts,
        if (errorCode != null) 'errorCode': errorCode,
        if (errorMessage != null) 'errorMessage': errorMessage,
      };

  SwalvoOutboxEntry copy() => SwalvoOutboxEntry.fromJson(toJson());
}

/// Persistence for the outbox. Implement it — over shared_preferences,
/// Hive, sqflite, a file — to keep unsent messages across an app restart.
///
/// Two methods over the whole list on purpose: the outbox is small (only
/// what has not been sent yet), and load/save is something any key-value
/// store can do, with no schema or migrations.
abstract class SwalvoOutboxStorage {
  Future<List<SwalvoOutboxEntry>> load();
  Future<void> save(List<SwalvoOutboxEntry> entries);
}

/// The default: survives reconnects, not restarts.
class SwalvoMemoryOutboxStorage implements SwalvoOutboxStorage {
  List<Map<String, dynamic>> _entries = const [];

  @override
  Future<List<SwalvoOutboxEntry>> load() async =>
      _entries.map(SwalvoOutboxEntry.fromJson).toList();

  @override
  Future<void> save(List<SwalvoOutboxEntry> entries) async {
    _entries = entries.map((entry) => entry.toJson()).toList();
  }
}

/// How many times a flush waits out a rate limit on one entry.
const _maxRateLimitWaits = 3;

/// `chat.outbox`: sends that have not been confirmed stored yet.
///
/// Every `send()` goes through here. Most entries live for one round trip
/// and nobody sees them; the outbox matters when the round trip fails
/// because the connection did. Then the entry stays `pending` and is sent
/// again — with the same `clientMessageId`, so the server stores it once
/// — as soon as the client reconnects.
///
/// What it does not do is guess. A send the server *refused* goes to
/// `failed` and stays there until the app calls [retry] or [cancel].
class SwalvoOutbox {
  SwalvoOutbox({
    required SwalvoOutboxStorage storage,
    required String Function() userId,
    required Future<SwalvoMessage> Function(SwalvoOutboxEntry entry) transmit,
    required bool Function() isConnected,
    Future<void> Function(Duration delay)? sleep,
  })  : _storage = storage,
        _userId = userId,
        _transmit = transmit,
        _isConnected = isConnected,
        _sleep = sleep ?? Future<void>.delayed;

  final SwalvoOutboxStorage _storage;
  final String Function() _userId;
  final Future<SwalvoMessage> Function(SwalvoOutboxEntry entry) _transmit;
  final bool Function() _isConnected;
  final Future<void> Function(Duration delay) _sleep;

  final _changes = StreamController<List<SwalvoOutboxEntry>>.broadcast();
  final List<SwalvoOutboxEntry> _entries = [];
  Future<void>? _loaded;
  bool _isLoaded = false;
  Future<void>? _flushing;

  /// Saves are chained, not awaited by the send path: a send should reach
  /// the socket without a storage hop first, and two un-chained writes to
  /// an async store can land out of order and resurrect a sent entry.
  Future<void> _saveChain = Future<void>.value();

  /// Every change: queued, sent, failed, confirmed. This user's entries,
  /// oldest first.
  Stream<List<SwalvoOutboxEntry>> get changes => _changes.stream;

  /// This user's queued sends, oldest first. Optionally for one room.
  List<SwalvoOutboxEntry> entries({String? room}) {
    final me = _userId();
    return _entries
        .where((entry) =>
            entry.userId == me && (room == null || entry.room == room))
        .map((entry) => entry.copy())
        .toList(growable: false);
  }

  /// Loads whatever a previous session left behind. Idempotent.
  Future<void> ready() => _loaded ??= _load();

  Future<void> _load() async {
    try {
      final stored = await _storage.load();
      final known = _entries.map((entry) => entry.clientMessageId).toSet();
      for (final entry in stored) {
        if (known.contains(entry.clientMessageId)) continue;
        // `sending` in storage means the last session died mid-send. Maybe
        // stored, maybe not; resending with the same key finds out safely.
        if (entry.status == SwalvoOutboxStatus.sending) {
          entry.status = SwalvoOutboxStatus.pending;
        }
        _entries.add(entry);
      }
      _entries.sort((a, b) => a.createdAt.compareTo(b.createdAt));
    } catch (_) {
      // Unreadable storage costs persistence, never the send.
    }
    _isLoaded = true;
  }

  /// Re-sends a `failed` (or still `pending`) entry now, with its original
  /// key. Completes with the stored message, like `send()`.
  Future<SwalvoMessage> retry(String clientMessageId) async {
    await ready();
    final entry = _find(clientMessageId);
    if (entry == null) {
      throw SwalvoChatException(
        SwalvoChatErrorCode.messageNotFound,
        'No queued message with clientMessageId "$clientMessageId".',
      );
    }
    if (entry.status == SwalvoOutboxStatus.sending) {
      throw const SwalvoChatException(
        SwalvoChatErrorCode.invalidMessage,
        'That message is already being sent.',
      );
    }
    entry
      ..status = SwalvoOutboxStatus.pending
      ..errorCode = null
      ..errorMessage = null;
    _persist();
    return _deliver(entry, flushing: false);
  }

  /// Drops a queued send so it never goes out. `false` when there was
  /// nothing to cancel, or it is already on the wire — a send in flight
  /// may already be stored, and pretending otherwise would be a lie the
  /// next history load exposes.
  Future<bool> cancel(String clientMessageId) async {
    await ready();
    final entry = _find(clientMessageId);
    if (entry == null || entry.status == SwalvoOutboxStatus.sending) {
      return false;
    }
    _entries.remove(entry);
    _persist();
    return true;
  }

  /// Queues a send and attempts it once. Used by `SwalvoChat.send()`.
  Future<SwalvoMessage> enqueueAndSend(SwalvoOutboxEntry entry) async {
    if (!_isLoaded) await ready();
    final existing = _find(entry.clientMessageId);
    if (existing != null) {
      if (existing.status == SwalvoOutboxStatus.sending) {
        throw const SwalvoChatException(
          SwalvoChatErrorCode.invalidMessage,
          'A message with that clientMessageId is already being sent.',
        );
      }
      return retry(existing.clientMessageId);
    }
    _entries.add(entry);
    _persist();
    return _deliver(entry, flushing: false);
  }

  /// Sends every `pending` entry, oldest first, one at a time — order
  /// matters, and the server's send rate would refuse a burst anyway.
  /// Stops at the first connectivity failure.
  Future<void> flush() => _flushing ??= _flush().whenComplete(() {
        _flushing = null;
      });

  Future<void> _flush() async {
    await ready();
    final me = _userId();
    for (;;) {
      if (!_isConnected()) return;
      SwalvoOutboxEntry? next;
      for (final entry in _entries) {
        if (entry.userId == me && entry.status == SwalvoOutboxStatus.pending) {
          next = entry;
          break;
        }
      }
      if (next == null) return;
      try {
        await _deliver(next, flushing: true);
      } catch (error) {
        if (isConnectivityError(error)) return;
        // Refused: it is `failed` now, move on to the next.
      }
    }
  }

  Future<SwalvoMessage> _deliver(SwalvoOutboxEntry entry,
      {required bool flushing}) async {
    var rateLimitWaits = 0;
    for (;;) {
      entry
        ..status = SwalvoOutboxStatus.sending
        ..attempts += 1;
      _persist();

      try {
        final result = await _transmit(entry);
        _entries.remove(entry);
        _persist();
        return result;
      } catch (error) {
        final chatError = error is SwalvoChatException
            ? error
            : SwalvoChatException(
                SwalvoChatErrorCode.internalError,
                '$error',
                cause: error,
              );
        entry
          ..errorCode = chatError.rawCode ?? chatError.code.name
          ..errorMessage = chatError.message;

        // A flush draining a backlog is exactly when the per-user rate
        // limit bites, and none of those messages did anything wrong.
        if (flushing &&
            chatError.code == SwalvoChatErrorCode.rateLimited &&
            rateLimitWaits < _maxRateLimitWaits) {
          rateLimitWaits += 1;
          entry.status = SwalvoOutboxStatus.pending;
          _persist();
          final seconds = chatError.retryAfterSeconds ?? 1;
          await _sleep(Duration(seconds: min(seconds, 30)));
          if (!_isConnected()) throw chatError.asQueued(entry.clientMessageId);
          continue;
        }

        if (isConnectivityError(chatError)) {
          entry.status = SwalvoOutboxStatus.pending;
          _persist();
          throw chatError.asQueued(entry.clientMessageId);
        }

        entry.status = SwalvoOutboxStatus.failed;
        _persist();
        throw chatError.forMessage(entry.clientMessageId);
      }
    }
  }

  SwalvoOutboxEntry? _find(String clientMessageId) {
    final me = _userId();
    for (final entry in _entries) {
      if (entry.clientMessageId == clientMessageId && entry.userId == me) {
        return entry;
      }
    }
    return null;
  }

  /// Completes once every save queued so far has reached storage.
  Future<void> settled() => _saveChain;

  void _persist() {
    final snapshot = _entries.map((entry) => entry.copy()).toList();
    _saveChain = _saveChain.then((_) async {
      try {
        await _storage.save(snapshot);
      } catch (_) {
        // Quota, a locked file. The in-memory copy still works.
      }
    });
    if (!_changes.isClosed) _changes.add(entries());
  }

  Future<void> close() => _changes.close();
}
