import 'dart:async';

import 'package:flutter/foundation.dart';

import 'errors.dart';
import 'models.dart';
import 'phase3_models.dart';
import 'seq.dart';

/// `chat.inbox`: the signed-in user's conversations, kept current.
///
/// Built on `queryMyConversations()` (`GET /v1/chat/me/conversations`).
/// The first page arrives with unread counts the server computed; after
/// that the inbox folds in what the socket delivers — a new message moves
/// its conversation to the top and bumps its unread count, a read mark
/// clears it — without another round trip.
///
/// **No double counting.** The server's page and the live messages
/// overlap: a message can be counted in a row's `unreadCount` *and*
/// arrive over the socket a moment later. Every row carries its
/// `lastMessage.seq`, and a live message at or below it is already
/// counted. That is the job `seq` exists for.
///
/// **Watching.** A connection only hears about conversations it has
/// joined — there is no per-user inbox channel — so `load(watch: true)`
/// joins up to `watchLimit` listed conversations. The server allows 20
/// subscriptions per connection and marks the user present in each room
/// joined; unwatched rows update on [refresh], which runs by itself after
/// a reconnect.
class SwalvoInbox extends ChangeNotifier {
  SwalvoInbox({
    required Future<SwalvoInboxPage> Function({int? limit, String? cursor})
        query,
    required String? Function() userId,
    required Future<void> Function(String room) joinRoom,
    Duration refreshDebounce = const Duration(milliseconds: 250),
  })  : _query = query,
        _userId = userId,
        _joinRoom = joinRoom,
        _refreshDebounce = refreshDebounce;

  final Future<SwalvoInboxPage> Function({int? limit, String? cursor}) _query;
  final String? Function() _userId;
  final Future<void> Function(String room) _joinRoom;
  final Duration _refreshDebounce;

  List<SwalvoInboxConversation> _conversations = const [];
  String? _nextCursor;
  bool _loading = false;
  bool _listening = false;
  SwalvoChatException? _error;
  int _limit = 30;
  bool _watch = true;
  int _watchLimit = 15;
  final _watched = <String>{};
  Timer? _refreshTimer;

  /// Newest activity first, the order an inbox renders in.
  List<SwalvoInboxConversation> get conversations =>
      List.unmodifiable(_conversations);

  /// Sum of every loaded conversation's unread count, muted ones excluded.
  /// What a badge shows.
  int get totalUnread => _conversations.fold(
      0,
      (total, row) =>
          total +
          (row.muted || row.notifications == SwalvoNotificationLevel.none
              ? 0
              : row.unreadCount));

  bool get hasMore => _nextCursor != null;
  bool get loading => _loading;
  SwalvoChatException? get error => _error;

  /// The first page. Replaces whatever was loaded, and starts following
  /// live updates.
  Future<void> load({
    int limit = 30,
    bool watch = true,
    int watchLimit = 15,
  }) async {
    _limit = limit;
    _watch = watch;
    _watchLimit = watchLimit;
    _listening = true;
    _setLoading(true);
    try {
      final page = await _query(limit: _limit);
      _nextCursor = page.nextCursor;
      _conversations = _sorted(page.conversations);
      _error = null;
      _setLoading(false);
      await _watchVisible();
    } on SwalvoChatException catch (error) {
      _error = error;
      _setLoading(false);
    }
  }

  /// The next page, appended. A no-op once there are no more.
  Future<void> loadMore() async {
    final cursor = _nextCursor;
    if (cursor == null || _loading) return;
    _setLoading(true);
    try {
      final page = await _query(limit: _limit, cursor: cursor);
      _nextCursor = page.nextCursor;
      _conversations = _merge(_conversations, page.conversations);
      _setLoading(false);
    } on SwalvoChatException catch (error) {
      _error = error;
      _setLoading(false);
    }
  }

  /// Re-reads the first page and merges it in. Call it when the app
  /// returns to the foreground.
  Future<void> refresh() async {
    if (!_listening) return;
    try {
      final page = await _query(limit: _limit);
      _conversations = _merge(_conversations, page.conversations);
      if (_conversations.length <= page.conversations.length) {
        _nextCursor = page.nextCursor;
      }
      _notify();
      await _watchVisible();
    } on SwalvoChatException {
      // Stale beats broken; the next refresh tries again.
    }
  }

  // -------------------------------------------------------------------
  // Fed by SwalvoChat
  // -------------------------------------------------------------------

  /// A live (or recovered) message.
  void handleMessage(SwalvoMessage message) {
    if (!_listening) return;
    final index = _conversations.indexWhere((row) => row.id == message.roomId);
    if (index == -1) {
      // Not on the loaded pages. Only the server's row is trustworthy.
      _scheduleRefresh();
      return;
    }
    final row = _conversations[index];
    final lastSeq = row.lastMessage?.seq;
    if (lastSeq != null &&
        message.seq != null &&
        compareSeq(message.seq, lastSeq) <= 0) {
      return;
    }

    final me = _userId();
    final fromSomeoneElse = message.senderId != me;
    final unreadByMark = row.lastReadSeq == null ||
        message.seq == null ||
        compareSeq(message.seq, row.lastReadSeq) > 0;
    final countIt = fromSomeoneElse && unreadByMark && !message.deleted;
    final mentionsMe = countIt && me != null && message.mentions.contains(me);

    final next = row.copyWith(
      lastMessage: SwalvoInboxLastMessage(
        id: message.id,
        seq: message.seq,
        senderId: message.senderId,
        content: message.text,
        type: message.type.name.toUpperCase(),
        createdAt: message.createdAt,
      ),
      // Sending is reading, as far as the server's count is concerned.
      unreadCount: fromSomeoneElse ? row.unreadCount + (countIt ? 1 : 0) : 0,
      unreadMentions:
          fromSomeoneElse ? row.unreadMentions + (mentionsMe ? 1 : 0) : 0,
      lastReadSeq: fromSomeoneElse ? row.lastReadSeq : message.seq,
      updatedAt: message.createdAt.isAfter(row.updatedAt)
          ? message.createdAt
          : row.updatedAt,
    );
    final rows = [..._conversations]..[index] = next;
    _conversations = _sorted(rows);
    _notify();
  }

  /// Someone read up to [messageId]. Only this user's own marks matter.
  void handleRead(String roomId, String userId, String? messageId) {
    if (!_listening || userId != _userId()) return;
    final index = _conversations.indexWhere((row) => row.id == roomId);
    if (index == -1) return;
    final row = _conversations[index];
    if (messageId != null && row.lastMessage?.id == messageId) {
      _replace(
          index,
          row.copyWith(
            unreadCount: 0,
            unreadMentions: 0,
            lastReadSeq: row.lastMessage?.seq,
          ));
      return;
    }
    // Read up to somewhere in the middle, on another device: only the
    // server knows how many are left.
    _scheduleRefresh();
  }

  /// The server's answer to a read mark: authoritative.
  void applyReadState(SwalvoReadState state) {
    final index = _conversations.indexWhere((row) => row.id == state.roomId);
    if (index == -1) return;
    final row = _conversations[index];
    _replace(
        index,
        row.copyWith(
          unreadCount: state.unreadCount,
          unreadMentions: state.unreadCount == 0 ? 0 : row.unreadMentions,
          lastReadSeq: state.unreadCount == 0 ? row.lastMessage?.seq : null,
        ));
  }

  void applyPreferences(SwalvoNotificationPreferences preferences) {
    final index =
        _conversations.indexWhere((row) => row.id == preferences.roomId);
    if (index == -1) return;
    _replace(
        index,
        _conversations[index].copyWith(
          muted: preferences.muted,
          notifications: preferences.notifications,
        ));
  }

  void handleRemoved(String roomId) {
    _watched.remove(roomId);
    final before = _conversations.length;
    _conversations = _conversations.where((row) => row.id != roomId).toList();
    if (_conversations.length != before) _notify();
  }

  void handleReconnected() {
    if (_listening) unawaited(refresh());
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _listening = false;
    _disposed = true;
    super.dispose();
  }

  // -------------------------------------------------------------------

  Future<void> _watchVisible() async {
    if (!_watch) return;
    for (final row in List.of(_conversations)) {
      if (_watched.length >= _watchLimit) return;
      if (_watched.contains(row.id)) continue;
      _watched.add(row.id);
      try {
        await _joinRoom(row.id);
      } on SwalvoChatException {
        // One refused join must not stop the others being watched.
        _watched.remove(row.id);
      }
    }
  }

  void _scheduleRefresh() {
    if (_refreshTimer != null) return;
    _refreshTimer = Timer(_refreshDebounce, () {
      _refreshTimer = null;
      unawaited(refresh());
    });
  }

  void _replace(int index, SwalvoInboxConversation row) {
    final rows = [..._conversations]..[index] = row;
    _conversations = rows;
    _notify();
  }

  void _setLoading(bool value) {
    _loading = value;
    _notify();
  }

  bool _disposed = false;

  void _notify() {
    if (_disposed) return;
    notifyListeners();
  }

  static List<SwalvoInboxConversation> _sorted(
          Iterable<SwalvoInboxConversation> rows) =>
      rows.toList()..sort((a, b) => b.lastActivity.compareTo(a.lastActivity));

  static List<SwalvoInboxConversation> _merge(
    List<SwalvoInboxConversation> current,
    List<SwalvoInboxConversation> incoming,
  ) {
    final byId = {for (final row in current) row.id: row};
    for (final row in incoming) {
      byId[row.id] = row;
    }
    return _sorted(byId.values);
  }
}
