import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'backoff.dart';
import 'errors.dart';
import 'event_sequencer.dart';
import 'inbox.dart';
import 'models.dart';
import 'outbox.dart';
import 'phase3_models.dart';
import 'recovery.dart';
import 'rest_client.dart';

/// Swalvo Chat for Flutter.
///
/// ```dart
/// final chat = SwalvoChat(token: token, apiUrl: apiUrl);
/// await chat.connect('room_123');
///
/// chat.messages.listen((message) => print(message.text));
/// await chat.send('Hello everyone!');
/// ```
///
/// The same guarantees as every other Swalvo Chat client, because it talks
/// to the same service over the same protocol (spec §9, no
/// mobile-specific chat backend):
///
/// * a message is only reported sent once it is durably stored;
/// * a retried send never creates a duplicate;
/// * a client that was offline catches up from history, not the socket;
/// * the socket is never the source of truth.
///
/// Extends [ChangeNotifier] so a widget can rebuild from it directly,
/// with typed streams for logic that lives outside the widget tree. That
/// dual surface is the idiomatic-Dart divergence the spec asks for (§6):
/// the concepts match the web SDK exactly, the subscription mechanism
/// follows the platform.
class SwalvoChat extends ChangeNotifier {
  SwalvoChat({
    required String token,
    String? apiUrl,
    String? chatUrl,
    this.maxReconnectAttempts = 10,
    this.requestTimeout = const Duration(seconds: 15),
    this.onTokenExpiring,
    SwalvoOutboxStorage? outboxStorage,
    bool enableOutbox = true,
    Duration gapFillDelay = const Duration(milliseconds: 300),
    @visibleForTesting WebSocketChannel Function(Uri uri)? connectChannel,
    @visibleForTesting SwalvoRestClient? restClient,
    @visibleForTesting Duration Function(int attempt)? reconnectDelay,
  })  : _token = token,
        _chatUrl = chatUrl ?? _deriveChatUrl(apiUrl),
        _connectChannel = connectChannel ?? WebSocketChannel.connect,
        _reconnectDelay = reconnectDelay ?? backoffDelay,
        _rest = restClient ??
            SwalvoRestClient(
              baseUrl: apiUrl ?? _deriveApiUrl(chatUrl),
              token: token,
            ) {
    final claims = _decodeClaims(token);
    _userId = claims['sub'] as String?;
    final audience = claims['aud_room'];
    _audienceRoom = audience is String && audience.isNotEmpty ? audience : null;

    _recovery = RecoveryTracker(
      listMessages: (room, after, limit) =>
          _historyRaw(room: room, after: after, limit: limit),
      deliver: (message) {
        _emit(_messageController, message);
        inbox.handleMessage(message);
      },
      isConnected: () => _state == SwalvoChatConnectionState.connected,
    );
    _sequencer = EventSequencer(
      fetchEvents: _fetchEvents,
      apply: _dispatchConversationEvent,
      onExpired: _resyncRoom,
      isConnected: () => _state == SwalvoChatConnectionState.connected,
      gapFillDelay: gapFillDelay,
    );
    _outbox = enableOutbox
        ? SwalvoOutbox(
            storage: outboxStorage ?? SwalvoMemoryOutboxStorage(),
            userId: () => _userId ?? '',
            transmit: _transmit,
            isConnected: () => _state == SwalvoChatConnectionState.connected,
          )
        : null;
    inbox = SwalvoInbox(
      query: ({int? limit, String? cursor}) =>
          queryMyConversations(limit: limit, cursor: cursor),
      userId: () => _userId,
      joinRoom: joinRoom,
    );
  }

  /// Give up after this many consecutive failures and report [failed].
  /// Unbounded retries against a server that is already struggling is an
  /// attack, not a feature.
  final int maxReconnectAttempts;

  /// How long to wait for a server ack before failing a send.
  final Duration requestTimeout;

  /// Called shortly before the token expires. Return a fresh one and the
  /// client reconnects transparently. Without it, the socket simply
  /// closes when the token runs out.
  final Future<String> Function()? onTokenExpiring;

  final WebSocketChannel Function(Uri uri) _connectChannel;
  final Duration Function(int attempt) _reconnectDelay;
  final SwalvoRestClient _rest;
  final String _chatUrl;

  /// This user's conversations with live unread counts. Call
  /// [SwalvoInbox.load] to start it.
  late final SwalvoInbox inbox;

  late final RecoveryTracker _recovery;
  late final EventSequencer _sequencer;
  SwalvoOutbox? _outbox;

  /// Read from the token, then confirmed by the server's hello.
  String? _userId;

  /// Set from an audience token's `aud_room` claim (Phase 3 §6).
  String? _audienceRoom;

  /// What the caller called a room -> the conversation's public id,
  /// learned from join responses. Frames and resume points are keyed on
  /// the `conv_…` id, and the two have to be matched to recover a room
  /// joined by name.
  final _roomAliases = <String, String>{};

  /// Live messages that arrived mid catch-up, held so they cannot overtake
  /// the older ones being replayed.
  final _pendingLive = <SwalvoMessage>[];
  bool _recovering = false;
  bool _hasConnectedBefore = false;

  /// This user's mute/ban state per room. See [myModerationState].
  final _moderation = <String, SwalvoModerationState>{};

  String _token;
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _socketSubscription;
  Timer? _reconnectTimer;
  Timer? _tokenRefreshTimer;

  final _messageController = StreamController<SwalvoMessage>.broadcast();
  final _messageUpdatedController = StreamController<SwalvoMessage>.broadcast();
  final _messageDeletedController = StreamController<String>.broadcast();
  final _typingController = StreamController<SwalvoTypingEvent>.broadcast();
  final _presenceController = StreamController<SwalvoPresence>.broadcast();
  final _reactionController = StreamController<SwalvoReactionEvent>.broadcast();
  final _readController = StreamController<SwalvoReadState>.broadcast();
  final _stateController =
      StreamController<SwalvoChatConnectionState>.broadcast();
  final _errorController = StreamController<SwalvoChatException>.broadcast();
  final _messageUpdateEventController =
      StreamController<SwalvoMessageUpdate>.broadcast();
  final _pinController = StreamController<SwalvoPinEvent>.broadcast();
  final _presenceCountController =
      StreamController<SwalvoPresenceCount>.broadcast();
  final _moderationController =
      StreamController<SwalvoMemberModerationEvent>.broadcast();
  final _removedController =
      StreamController<SwalvoRoomRemovedEvent>.broadcast();
  final _resyncController = StreamController<SwalvoResyncEvent>.broadcast();
  final _recoveredController =
      StreamController<SwalvoRecoverySummary>.broadcast();

  /// Requests awaiting a correlated ack, keyed by frame id.
  final _pending = <String, Completer<Map<String, dynamic>>>{};

  /// Rooms the caller asked to be in. Re-joined automatically after a
  /// reconnect, since the new socket knows nothing of the old one's
  /// subscriptions.
  final _desiredRooms = <String>{};

  /// When [startTyping] last actually sent a frame, per room. See its
  /// doc comment for why this is throttled at all.
  final _lastTypingSignal = <String, DateTime>{};

  /// The presence the caller last asked for, re-asserted after every
  /// (re)connect. See [setPresence].
  SwalvoPresenceStatus? _desiredPresence;

  SwalvoChatConnectionState _state = SwalvoChatConnectionState.idle;
  int _requestCounter = 0;
  int _reconnectAttempt = 0;
  bool _intentionallyClosed = false;
  bool _disposed = false;
  Completer<void>? _connected;

  // ---------------------------------------------------------------------
  // Streams
  // ---------------------------------------------------------------------

  /// Messages as they arrive, your own included, echoed back.
  ///
  /// Receiving your own message is deliberate: the sender renders the
  /// same canonical, server-ordered row as everyone else instead of a
  /// local optimistic copy that has to be reconciled later.
  Stream<SwalvoMessage> get messages => _messageController.stream;

  Stream<SwalvoMessage> get messageUpdates => _messageUpdatedController.stream;

  /// Ids of messages that were deleted.
  Stream<String> get messageDeletions => _messageDeletedController.stream;

  Stream<SwalvoTypingEvent> get typing => _typingController.stream;
  Stream<SwalvoPresence> get presence => _presenceController.stream;
  Stream<SwalvoReactionEvent> get reactions => _reactionController.stream;
  Stream<SwalvoReadState> get readReceipts => _readController.stream;
  Stream<SwalvoChatConnectionState> get connectionStateChanges =>
      _stateController.stream;

  /// Errors that weren't tied to a call you made, a reconnect giving up for
  /// instance. An error from a specific call rejects that call's future.
  Stream<SwalvoChatException> get errors => _errorController.stream;

  /// Edits and link-preview unfurls, with the reason the server gave.
  /// The same messages as [messageUpdates], plus why.
  Stream<SwalvoMessageUpdate> get messageUpdateEvents =>
      _messageUpdateEventController.stream;

  /// Messages pinned to or unpinned from a conversation.
  Stream<SwalvoPinEvent> get pins => _pinController.stream;

  /// Online counts for large rooms, which stop sending one presence frame
  /// per arrival.
  Stream<SwalvoPresenceCount> get presenceCounts =>
      _presenceCountController.stream;

  /// Bans, unbans, mutes and unmutes in joined rooms.
  Stream<SwalvoMemberModerationEvent> get memberModeration =>
      _moderationController.stream;

  /// This user lost access to a room without asking to leave: banned, or
  /// removed as a member. The SDK stops re-joining it.
  Stream<SwalvoRoomRemovedEvent> get removedFromRoom =>
      _removedController.stream;

  /// A room's event log had expired, so history was re-read. Replace your
  /// copy of that conversation with the page.
  Stream<SwalvoResyncEvent> get resyncs => _resyncController.stream;

  /// Catch-up after a reconnect has finished.
  Stream<SwalvoRecoverySummary> get recovered => _recoveredController.stream;

  /// Sends not yet confirmed stored. Throws if the outbox was disabled.
  SwalvoOutbox get outbox {
    final outbox = _outbox;
    if (outbox == null) {
      throw StateError('The outbox is disabled (enableOutbox: false).');
    }
    return outbox;
  }

  /// Who this client speaks as: from the server's hello, or the token.
  String? get userId => _userId;

  /// True for a live-stream audience token: a viewer of one
  /// `broadcast_audience` conversation, not a member. Viewers read and
  /// post; member-only features (inbox, read receipts, push) are refused.
  bool get isAudienceViewer => _audienceRoom != null;

  SwalvoChatConnectionState get connectionState => _state;

  /// Rooms currently joined.
  Set<String> get rooms => Set.unmodifiable(_desiredRooms);

  // ---------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------

  /// Connects and joins [room].
  ///
  /// Completes once the server has authenticated the socket, not merely once
  /// the TCP connection opened, so a completed future genuinely means you
  /// can send.
  ///
  /// **Joining is not the same as being present.** This opens the socket
  /// and joins the conversation; it does not announce the user, so two
  /// clients that have both connected will each still see only
  /// themselves in [getPresence] until they say otherwise:
  ///
  /// ```dart
  /// await chat.connect(conversationId);
  /// await chat.setPresence(SwalvoPresenceStatus.online);
  /// ```
  ///
  /// Deliberate, and the same in every Swalvo Chat SDK: a client that
  /// reads a conversation without appearing in it — a moderation view, a
  /// bot, a support agent watching a queue — is an ordinary thing to
  /// build, and it could not be built if connecting announced you. Once
  /// set, presence is re-asserted for you across reconnects.
  ///
  /// With an audience token, [room] can be omitted: the token names its
  /// one conversation.
  Future<void> connect([String? room]) async {
    final target = room ?? _audienceRoom;
    if (target == null) {
      throw const SwalvoChatException(
        SwalvoChatErrorCode.notInRoom,
        'connect() needs a room.',
      );
    }
    _desiredRooms.add(target);

    if (_state == SwalvoChatConnectionState.connected) {
      await _joinRoom(target);
      return;
    }

    _intentionallyClosed = false;
    if (_hasConnectedBefore) {
      // A connect after an explicit disconnect: resume points survived it,
      // so catch up exactly as a reconnect would.
      await _reconnectAndRecover();
      return;
    }
    await _openSocket();
    _hasConnectedBefore = true;
    // Read whatever a previous session left queued before anything is
    // sent, so the first send of this session goes straight to the wire.
    await _outbox?.ready();
    await _syncRooms();
    unawaited(_outbox?.flush());
  }

  /// Joins another room on the open connection (or on the next one).
  ///
  /// A room this client is already in is not joined twice.
  Future<void> joinRoom(String room) async {
    final already =
        _desiredRooms.contains(room) || _roomAliases.values.contains(room);
    _desiredRooms.add(room);
    if (already) return;
    if (_state == SwalvoChatConnectionState.connected) {
      await _joinRoom(room);
    }
  }

  /// Closes the connection. Does not reconnect; call [connect] again.
  Future<void> disconnect() async {
    _intentionallyClosed = true;
    _reconnectTimer?.cancel();
    _tokenRefreshTimer?.cancel();

    await _teardownSocket();
    _failPending(
      const SwalvoChatException(
        SwalvoChatErrorCode.connectionClosed,
        'The connection was closed before the server replied.',
      ),
    );
    _sequencer.pause();
    _pendingLive.clear();
    _recovering = false;
    _setState(SwalvoChatConnectionState.disconnected);
  }

  /// Leaves a room but keeps the connection open.
  ///
  /// Leaving on purpose is not an outage: the resume point is dropped, so
  /// re-joining later starts fresh rather than replaying what was said
  /// while the caller deliberately was not listening.
  Future<void> leaveRoom(String room) async {
    _desiredRooms.remove(room);
    final resolved = _resolveRoom(room);
    _recovery.forget(resolved);
    _sequencer.forget(resolved);
    _roomAliases.remove(room);
    if (_state == SwalvoChatConnectionState.connected) {
      await _request('room.leave', {'room': room});
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    // Not via _setState: it early-returns once _disposed is true (so nothing
    // emits to a controller this method is about to close), but that also
    // meant _state could never actually leave `connected` here — and
    // RecoveryTracker/SwalvoOutbox's own `isConnected` guards read _state
    // directly, not this instance's disposed flag, so a recovery or outbox
    // flush loop already mid-iteration would not see itself as safe to stop.
    _state = SwalvoChatConnectionState.disconnected;

    _intentionallyClosed = true;
    _reconnectTimer?.cancel();
    _tokenRefreshTimer?.cancel();
    _sequencer.pause();
    unawaited(_teardownSocket());
    _failPending(
      const SwalvoChatException(
        SwalvoChatErrorCode.connectionClosed,
        'The chat client was disposed.',
      ),
    );
    unawaited(_rest.close());
    unawaited(_outbox?.close());
    inbox.dispose();
    _messageUpdateEventController.close();
    _pinController.close();
    _presenceCountController.close();
    _moderationController.close();
    _removedController.close();
    _resyncController.close();
    _recoveredController.close();

    _messageController.close();
    _messageUpdatedController.close();
    _messageDeletedController.close();
    _typingController.close();
    _presenceController.close();
    _reactionController.close();
    _readController.close();
    _stateController.close();
    _errorController.close();

    super.dispose();
  }

  // ---------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------

  /// Sends a message and completes with the stored message.
  ///
  /// Completes only after Swalvo has durably stored it, so a completed
  /// future really does mean "saved". The returned message carries the
  /// server's canonical id and timestamp.
  ///
  /// A [clientMessageId] is attached automatically when you don't supply
  /// one, which is what makes a retry after a reconnect safe: the same key
  /// returns the original message instead of posting a duplicate.
  ///
  /// Every send goes through the [outbox]. A send the *connection* drops
  /// fails with `queued: true` on the exception and goes out again by
  /// itself on reconnect, with the same key. A send the *server* refuses
  /// (muted, slow mode, too large…) is marked failed and left for
  /// [SwalvoOutbox.retry] or [SwalvoOutbox.cancel].
  ///
  /// [mentions] are userIds (at most 50); mentioned users are pushed even
  /// with notifications set to `mentions`. [attachmentId] is an uploaded
  /// attachment from [uploadAttachment].
  Future<SwalvoMessage> send(
    String text, {
    String? room,
    String? replyTo,
    String? clientMessageId,
    Map<String, dynamic>? metadata,
    List<String>? mentions,
    String? attachmentId,
  }) async {
    final target = room ?? _defaultRoom();
    if (mentions != null && mentions.length > _maxMentions) {
      throw const SwalvoChatException(
        SwalvoChatErrorCode.invalidMessage,
        'A message can mention at most $_maxMentions users.',
      );
    }
    final entry = SwalvoOutboxEntry(
      clientMessageId: clientMessageId ?? _generateClientMessageId(),
      room: target,
      userId: _userId ?? '',
      createdAt: DateTime.now(),
      text: text,
      replyTo: replyTo,
      attachmentId: attachmentId,
      metadata: metadata,
      mentions: mentions,
    );

    final outbox = _outbox;
    if (outbox == null) return _transmit(entry);
    try {
      return await outbox.enqueueAndSend(entry);
    } on SwalvoChatException catch (error) {
      _observeRefusal(_resolveRoom(target), error.code);
      rethrow;
    }
  }

  /// One attempt at putting a message on the wire: the socket when it is
  /// up, HTTP when it is not — the message still stores and fans out, and
  /// losing connectivity shouldn't silently lose what the user typed.
  Future<SwalvoMessage> _transmit(SwalvoOutboxEntry entry) async {
    final body = <String, dynamic>{
      'text': entry.text,
      if (entry.replyTo != null) 'replyTo': entry.replyTo,
      'clientMessageId': entry.clientMessageId,
      if (entry.metadata != null) 'metadata': entry.metadata,
      if (entry.mentions != null) 'mentions': entry.mentions,
      if (entry.attachmentId != null) 'attachmentId': entry.attachmentId,
    };

    if (_state != SwalvoChatConnectionState.connected) {
      final response = await _rest.post(
        '/v1/chat/conversations/${Uri.encodeComponent(entry.room)}/messages',
        body: body,
      );
      return SwalvoMessage.fromJson(response);
    }

    final ack = await _request('message.send', {
      'room': entry.room,
      ...body,
      'clientSentAt': DateTime.now().millisecondsSinceEpoch,
    });

    return SwalvoMessage.fromJson(ack['message'] as Map<String, dynamic>);
  }

  /// Message history, newest first.
  ///
  /// Pass [before] (a previous page's `nextCursor`) to page back through
  /// history, or [after] (its `previousCursor`) to catch up on what
  /// arrived while disconnected. Cursors are opaque, so pass back exactly
  /// what you were given.
  ///
  /// [afterSeq] / [beforeSeq] page by message `seq` instead of cursor.
  Future<SwalvoMessagePage> history({
    String? room,
    int limit = 50,
    String? before,
    String? after,
    String? afterSeq,
    String? beforeSeq,
    String? threadRootId,
  }) async {
    final page = await _historyRaw(
      room: room ?? _defaultRoom(),
      limit: limit,
      before: before,
      after: after,
      afterSeq: afterSeq,
      beforeSeq: beforeSeq,
      threadRootId: threadRootId,
    );
    // Gives a quiet room a resume point, without claiming its messages
    // were delivered.
    _recovery.observeHistory(page.messages);
    return page;
  }

  /// [history] without the bookkeeping, for the SDK's own catch-up.
  Future<SwalvoMessagePage> _historyRaw({
    required String room,
    int limit = 50,
    String? before,
    String? after,
    String? afterSeq,
    String? beforeSeq,
    String? threadRootId,
  }) async {
    final response = await _rest.get(
      '/v1/chat/conversations/${Uri.encodeComponent(room)}/messages',
      query: {
        'limit': '$limit',
        if (before != null) 'before': before,
        if (after != null) 'after': after,
        if (afterSeq != null) 'afterSeq': afterSeq,
        if (beforeSeq != null) 'beforeSeq': beforeSeq,
        if (threadRootId != null) 'threadRootId': threadRootId,
      },
    );
    return SwalvoMessagePage.fromJson(response);
  }

  /// The first page of a thread, oldest first: the root plus its replies.
  ///
  /// Works from any message in the thread, not just the root. Long threads
  /// are paginated; use [threadPage] for the rest.
  Future<List<SwalvoMessage>> thread(String messageId) async =>
      (await threadPage(messageId)).items;

  /// One page of a thread. Pass the previous page's `nextCursor` as
  /// [cursor]. Older servers return the whole thread as one page.
  Future<SwalvoCursorPage<SwalvoMessage>> threadPage(
    String messageId, {
    int? limit,
    String? cursor,
  }) async {
    final response = await _rest.requestAny(
      'GET',
      '/v1/chat/messages/${Uri.encodeComponent(messageId)}/thread',
      query: {
        if (limit != null) 'limit': '$limit',
        if (cursor != null) 'cursor': cursor,
      },
    );
    return _messagePage(response, const ['data', 'messages', 'replies']);
  }

  /// Full-text search over one conversation (members only), newest
  /// matches first. Word-based, not substring.
  Future<SwalvoCursorPage<SwalvoMessage>> search(
    String q, {
    String? room,
    int? limit,
    String? cursor,
  }) async {
    final target = room ?? _defaultRoom();
    final response = await _rest.requestAny(
      'GET',
      '/v1/chat/conversations/${Uri.encodeComponent(target)}/search',
      query: {
        'q': q,
        if (limit != null) 'limit': '$limit',
        if (cursor != null) 'cursor': cursor,
      },
    );
    return _messagePage(response, const ['data', 'messages', 'results']);
  }

  /// Pins a message to its conversation (MODERATOR or ADMIN).
  Future<void> pin(String messageId) async {
    await _rest.requestAny(
        'POST', '/v1/chat/messages/${Uri.encodeComponent(messageId)}/pin');
  }

  Future<void> unpin(String messageId) async {
    await _rest.requestAny(
        'DELETE', '/v1/chat/messages/${Uri.encodeComponent(messageId)}/pin');
  }

  /// The conversation's pinned messages.
  Future<List<SwalvoMessage>> listPins({String? room}) async {
    final target = room ?? _defaultRoom();
    final response = await _rest.requestAny(
        'GET', '/v1/chat/conversations/${Uri.encodeComponent(target)}/pins');
    return listOf(response, const ['data', 'pins', 'messages'])
        .map((entry) => SwalvoMessage.fromJson(
            entry['message'] is Map<String, dynamic>
                ? entry['message'] as Map<String, dynamic>
                : entry))
        .toList(growable: false);
  }

  /// Edits a message. The result carries `edited: true` and an
  /// `editedAt`. Swalvo never quietly rewrites history.
  Future<SwalvoMessage> edit(String messageId, String text) async {
    final response = await _rest.patch(
      '/v1/chat/messages/${Uri.encodeComponent(messageId)}',
      body: {'text': text},
    );
    return SwalvoMessage.fromJson(response);
  }

  /// Soft-deletes a message. It keeps its position and id but loses its
  /// body, so a client can render a placeholder instead of leaving a hole
  /// in the conversation.
  Future<SwalvoMessage> delete(String messageId) async {
    final response = await _rest
        .delete('/v1/chat/messages/${Uri.encodeComponent(messageId)}');
    return SwalvoMessage.fromJson(response);
  }

  /// Adds a reaction. Adding the same one twice is a no-op, not a
  /// duplicate.
  Future<void> addReaction(String messageId, String emoji) async {
    await _rest.post(
      '/v1/chat/messages/${Uri.encodeComponent(messageId)}/reactions',
      body: {'emoji': emoji},
    );
  }

  Future<void> removeReaction(String messageId, String emoji) async {
    await _rest.delete(
      '/v1/chat/messages/${Uri.encodeComponent(messageId)}/reactions/${Uri.encodeComponent(emoji)}',
    );
  }

  // ---------------------------------------------------------------------
  // Presence, typing, read state
  // ---------------------------------------------------------------------

  /// Signals that the user is typing.
  ///
  /// Genuinely safe to call on every keystroke. The server only
  /// broadcasts on the transition into typing, and its state expires on a
  /// TTL so a client that vanishes mid-sentence doesn't leave a stuck
  /// indicator — but it also rate-limits typing frames (20 per 10s) and
  /// answers the 21st with an error, which a fast typist reaches inside a
  /// sentence. So the repeats are dropped here rather than sent and
  /// refused: at most one frame per [_typingInterval] per room, which is
  /// well inside the limit and still far shorter than the indicator's own
  /// TTL.
  ///
  /// [stopTyping] clears the throttle, so "type, stop, type again" is
  /// signalled promptly rather than swallowed by a window the first burst
  /// opened.
  Future<void> startTyping({String? room}) async {
    final target = room ?? _defaultRoom();

    final last = _lastTypingSignal[target];
    final now = DateTime.now();
    if (last != null && now.difference(last) < _typingInterval) return;
    _lastTypingSignal[target] = now;

    _sendFrame({'type': 'typing.start', 'room': target});
  }

  Future<void> stopTyping({String? room}) async {
    final target = room ?? _defaultRoom();
    _lastTypingSignal.remove(target);
    _sendFrame({'type': 'typing.stop', 'room': target});
  }

  /// Marks this message, and everything before it, as read.
  Future<void> markAsRead(String messageId) async {
    _assertMember('Read receipts');
    final Map<String, dynamic> state;
    if (_state == SwalvoChatConnectionState.connected) {
      state = await _request('read.mark', {'messageId': messageId});
    } else {
      state = await _rest
          .post('/v1/chat/messages/${Uri.encodeComponent(messageId)}/read');
    }
    if (state['roomId'] is String) {
      inbox.applyReadState(SwalvoReadState.fromJson(state));
    }
  }

  /// Who's present in a room right now. Ephemeral; never durable state.
  ///
  /// In a large room this is the first page of the roster only; use
  /// [listPresence] for the rest.
  Future<List<SwalvoPresence>> getPresence({String? room}) async =>
      (await listPresence(room: room)).presence;

  /// One page of a room's presence roster, at most 200 per page.
  Future<SwalvoPresencePage> listPresence({
    String? room,
    String? cursor,
    int? limit,
  }) async {
    final target = room ?? _defaultRoom();
    final response = await _rest.requestAny(
      'GET',
      '/v1/chat/conversations/${Uri.encodeComponent(target)}/presence',
      query: {
        if (cursor != null) 'cursor': cursor,
        if (limit != null) 'limit': '$limit',
      },
    );
    return SwalvoPresencePage(
      presence: listOf(response, const ['data', 'presence'])
          .map(SwalvoPresence.fromJson)
          .toList(growable: false),
      nextCursor: response is Map<String, dynamic>
          ? response['nextCursor'] as String?
          : null,
    );
  }

  // ---------------------------------------------------------------------
  // Inbox (Phase 3 §2)
  // ---------------------------------------------------------------------

  /// One page of this user's conversations, newest activity first, each
  /// with its unread count and last message. For a list that keeps itself
  /// current, use [inbox] — it is built on this.
  Future<SwalvoInboxPage> queryMyConversations({
    int? limit,
    String? cursor,
  }) async {
    _assertMember('The inbox');
    final response = await _rest.get(
      '/v1/chat/me/conversations',
      query: {
        if (limit != null) 'limit': '$limit',
        if (cursor != null) 'cursor': cursor,
      },
    );
    return SwalvoInboxPage.fromJson(response);
  }

  // ---------------------------------------------------------------------
  // Moderation (Phase 3 §3)
  // ---------------------------------------------------------------------

  /// Stops this user receiving anything from [userId]: messages,
  /// reactions, typing and presence. In a DIRECT conversation, sends
  /// either way fail with `blocked`. The other user is not told.
  Future<void> block(String userId) async {
    await _rest.requestAny(
        'POST', '/v1/chat/me/blocks/${Uri.encodeComponent(userId)}');
  }

  Future<void> unblock(String userId) async {
    await _rest.requestAny(
        'DELETE', '/v1/chat/me/blocks/${Uri.encodeComponent(userId)}');
  }

  Future<List<SwalvoBlock>> listBlocks() async {
    final response = await _rest.requestAny('GET', '/v1/chat/me/blocks');
    return listOf(response, const ['blocks', 'data'])
        .map(SwalvoBlock.fromJson)
        .toList(growable: false);
  }

  /// Reports a message to the project's review queue. It stays visible
  /// until somebody acts on the report.
  Future<void> flagMessage(
    String messageId,
    SwalvoFlagReason reason, {
    String? note,
  }) async {
    await _rest.post(
      '/v1/chat/messages/${Uri.encodeComponent(messageId)}/flags',
      body: {'reason': reason.name, if (note != null) 'note': note},
    );
  }

  /// Bans [userId] from a conversation (MODERATOR or ADMIN). They are
  /// disconnected from it at once. Omit [duration] for a permanent ban.
  Future<void> ban(
    String userId, {
    String? room,
    Duration? duration,
    String? reason,
  }) =>
      _moderate('moderation.ban', userId, room, duration, reason);

  Future<void> unban(String userId, {String? room}) =>
      _moderate('moderation.unban', userId, room, null, null);

  /// Lets [userId] keep reading but not send, react or edit.
  Future<void> mute(
    String userId, {
    String? room,
    Duration? duration,
    String? reason,
  }) =>
      _moderate('moderation.mute', userId, room, duration, reason);

  Future<void> unmute(String userId, {String? room}) =>
      _moderate('moderation.unmute', userId, room, null, null);

  /// Whether this user is muted or banned in [room], from what this
  /// client has seen: a `member.*` event about them, or a refused send.
  /// There is no "am I muted" query in the protocol, so a client that
  /// connects while already muted finds out on its first refused send.
  /// Timed states clear themselves once their expiry has passed.
  SwalvoModerationState myModerationState(String room) {
    final state = _moderation[_resolveRoom(room)];
    if (state == null) return const SwalvoModerationState();
    final now = DateTime.now();
    bool active(bool flag, DateTime? until) =>
        flag && (until == null || until.isAfter(now));
    final muted = active(state.muted, state.mutedUntil);
    final banned = active(state.banned, state.bannedUntil);
    return SwalvoModerationState(
      muted: muted,
      mutedUntil: muted ? state.mutedUntil : null,
      banned: banned,
      bannedUntil: banned ? state.bannedUntil : null,
    );
  }

  Future<void> _moderate(
    String type,
    String userId,
    String? room,
    Duration? duration,
    String? reason,
  ) async {
    await _request(type, {
      'room': room ?? _defaultRoom(),
      'userId': userId,
      if (duration != null) 'durationSeconds': duration.inSeconds,
      if (reason != null) 'reason': reason,
    });
  }

  void _observeModeration(SwalvoMemberModerationEvent event) {
    final current = _moderation[event.roomId] ?? const SwalvoModerationState();
    _moderation[event.roomId] = switch (event.kind) {
      SwalvoModerationKind.banned => SwalvoModerationState(
          muted: current.muted,
          mutedUntil: current.mutedUntil,
          banned: true,
          bannedUntil: event.expiresAt),
      SwalvoModerationKind.unbanned => SwalvoModerationState(
          muted: current.muted, mutedUntil: current.mutedUntil),
      SwalvoModerationKind.muted => SwalvoModerationState(
          muted: true,
          mutedUntil: event.expiresAt,
          banned: current.banned,
          bannedUntil: current.bannedUntil),
      SwalvoModerationKind.unmuted => SwalvoModerationState(
          banned: current.banned, bannedUntil: current.bannedUntil),
    };
  }

  /// A refused send tells us our state even with no event.
  void _observeRefusal(String room, SwalvoChatErrorCode code) {
    final current = _moderation[room];
    if (code == SwalvoChatErrorCode.muted && !(current?.muted ?? false)) {
      _observeModeration(SwalvoMemberModerationEvent(
          kind: SwalvoModerationKind.muted, roomId: room, userId: ''));
    } else if (code == SwalvoChatErrorCode.banned &&
        !(current?.banned ?? false)) {
      _observeModeration(SwalvoMemberModerationEvent(
          kind: SwalvoModerationKind.banned, roomId: room, userId: ''));
    }
  }

  // ---------------------------------------------------------------------
  // Push (Phase 3 §4)
  // ---------------------------------------------------------------------

  /// Registers this device for push. Safe on every app start: an upsert
  /// keyed on the token, re-binding a token that last belonged to another
  /// user on this device to this one.
  Future<SwalvoDevice> registerDevice({
    required SwalvoPushProvider provider,
    required String token,
    required SwalvoDevicePlatform platform,
    String? appBundleId,
  }) async {
    _assertMember('Push notifications');
    final response = await _rest.post('/v1/chat/me/devices', body: {
      'provider': provider.name,
      'token': token,
      'platform': platform.name,
      if (appBundleId != null) 'appBundleId': appBundleId,
    });
    return SwalvoDevice.fromJson(response.isEmpty
        ? {
            'provider': provider.name,
            'token': token,
            'platform': platform.name,
            'appBundleId': appBundleId,
          }
        : response);
  }

  /// Stops pushes to [token]. Call it on sign-out.
  Future<void> unregisterDevice(String token) async {
    await _rest.requestAny(
        'DELETE', '/v1/chat/me/devices/${Uri.encodeComponent(token)}');
  }

  Future<List<SwalvoDevice>> listDevices() async {
    final response = await _rest.requestAny('GET', '/v1/chat/me/devices');
    return listOf(response, const ['devices', 'data'])
        .map(SwalvoDevice.fromJson)
        .toList(growable: false);
  }

  /// Which messages in [room] push this user.
  Future<SwalvoNotificationPreferences> setNotificationLevel(
    String room,
    SwalvoNotificationLevel level,
  ) =>
      _updatePreferences(room, {'notifications': level.name});

  /// Mutes a conversation for this user: no pushes, and its unread count
  /// leaves the inbox badge. Not a moderator mute — they can still post.
  Future<SwalvoNotificationPreferences> muteConversation(
    String room, {
    bool muted = true,
  }) =>
      _updatePreferences(room, {'muted': muted});

  Future<SwalvoNotificationPreferences> _updatePreferences(
    String room,
    Map<String, dynamic> changes,
  ) async {
    _assertMember('Notification preferences');
    final response = await _rest.patch(
      '/v1/chat/me/conversations/${Uri.encodeComponent(room)}',
      body: changes,
    );
    final muted =
        response['muted'] as bool? ?? changes['muted'] as bool? ?? false;
    final level = response['notifications'] as String? ??
        changes['notifications'] as String? ??
        (muted ? 'none' : 'all');
    final preferences = SwalvoNotificationPreferences(
      roomId: response['roomId'] as String? ??
          response['id'] as String? ??
          _resolveRoom(room),
      notifications: parseNotificationLevel(level),
      muted: muted,
    );
    inbox.applyPreferences(preferences);
    return preferences;
  }

  // ---------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------

  /// Step 1 on its own, for callers driving the upload themselves.
  Future<SwalvoAttachmentUploadTicket> createUploadTicket({
    required String filename,
    required String mimeType,
    required int size,
    String? room,
    Map<String, dynamic>? metadata,
  }) async {
    final target = room ?? _defaultRoom();
    final response = await _rest.post(
      '/v1/chat/conversations/${Uri.encodeComponent(target)}/attachments',
      body: {
        'filename': filename,
        'mimeType': mimeType,
        'size': size,
        if (metadata != null) 'metadata': metadata,
      },
    );
    return SwalvoAttachmentUploadTicket.fromJson(response);
  }

  /// Uploads a file and returns the ticket whose `id` goes in
  /// `send(attachmentId: …)`.
  ///
  /// Bytes go straight to object storage over a short-lived signed URL;
  /// they never pass through Swalvo's API or the socket. Ticket → PUT →
  /// confirm, folded into one call.
  Future<SwalvoAttachmentUploadTicket> uploadAttachment(
    Uint8List bytes, {
    required String filename,
    required String mimeType,
    String? room,
    Map<String, dynamic>? metadata,
  }) async {
    final ticket = await createUploadTicket(
      filename: filename,
      mimeType: mimeType,
      size: bytes.length,
      room: room,
      metadata: metadata,
    );
    final status = await _rest.putBytes(
      Uri.parse(ticket.uploadUrl),
      bytes,
      headers: ticket.uploadHeaders,
    );
    if (status < 200 || status >= 300) {
      // Never confirm an upload that did not happen. The attachment stays
      // pending and can never be attached to a message.
      throw SwalvoChatException(
        SwalvoChatErrorCode.attachmentNotFound,
        'Object storage rejected the upload (status $status).',
      );
    }
    await _rest.post(
        '/v1/chat/attachments/${Uri.encodeComponent(ticket.id)}/complete');
    return ticket.withStatus('uploaded');
  }

  /// A short-lived signed download URL. Mint one when the user taps;
  /// don't cache it.
  Future<Uri> getAttachmentDownloadUrl(String attachmentId) async {
    final response = await _rest.get(
        '/v1/chat/attachments/${Uri.encodeComponent(attachmentId)}/download-url');
    return Uri.parse(response['url'] as String? ?? '');
  }

  /// Sets presence across every room this connection holds.
  ///
  /// Remembered and re-asserted on every reconnect. Presence is socket
  /// state, so the new socket the reconnect opened knows nothing of what
  /// was set on the old one — without this, a client that survived a
  /// blip stayed silently invisible to everybody else for the rest of
  /// the session.
  Future<void> setPresence(SwalvoPresenceStatus status) async {
    _desiredPresence = status;
    _sendFrame({'type': 'presence.set', 'status': status.name});
  }

  // ---------------------------------------------------------------------
  // Socket plumbing
  // ---------------------------------------------------------------------

  Future<void> _openSocket() async {
    _setState(_reconnectAttempt > 0
        ? SwalvoChatConnectionState.reconnecting
        : SwalvoChatConnectionState.connecting);

    final uri = Uri.parse(
      '$_chatUrl?token=${Uri.encodeQueryComponent(_token)}&sdkVersion=$_sdkVersion&platform=flutter',
    );

    final connected = Completer<void>();
    _connected = connected;

    try {
      final channel = _connectChannel(uri);
      _channel = channel;
      // web_socket_channel's `WebSocketChannel.connect` (the default
      // `_connectChannel`) completes `channel.ready` with an error when the
      // underlying connection attempt fails — a *separate* Future from the
      // stream this class actually listens to below. The real failure is
      // already handled through that stream's `onDone`/`onError` (which is
      // what actually drives reconnection); nothing here ever reads
      // `ready`. An unobserved `Completer.completeError` is reported by the
      // Dart runtime as a top-level "Unhandled Exception" — confirmed live
      // on a real device, one for every failed connection attempt (a
      // refused connection, a dropped network, a server restart — all
      // ordinary, frequent events, not edge cases), which is exactly the
      // kind of thing a crash reporter in a real app would wrongly count
      // as a crash. Marking it observed here changes nothing about actual
      // error handling, which stays on the stream.
      unawaited(channel.ready.catchError((_) {}));

      _socketSubscription = channel.stream.listen(
        _handleFrame,
        onDone: _handleSocketClosed,
        onError: (Object error) {
          // Errors are informational here; the close that follows is what
          // actually drives reconnection.
          debugPrint('[swalvo_chat] socket error: $error');
        },
        cancelOnError: false,
      );
    } catch (error) {
      _connected = null;
      _scheduleReconnect();
      throw SwalvoChatException(
        SwalvoChatErrorCode.connectionFailed,
        'Could not open a chat connection.',
        cause: error,
      );
    }

    return connected.future;
  }

  Future<void> _teardownSocket() async {
    // Cancelling the subscription before closing (so the close doesn't
    // drive the reconnect path we're by design leaving here) also means
    // _handleSocketClosed — the only other place that completes/fails
    // `_connected` — never runs on this path. Without this, a connect()
    // still awaiting the server's "connected" frame when disconnect()/
    // dispose() runs would hang on that await forever: no error, no
    // success. Harmless to call when there's no connect() in flight
    // (the ordinary case): `_connected` is already null by then, set so
    // by _handleServerHello the moment the earlier connect succeeded.
    final connected = _connected;
    if (connected != null && !connected.isCompleted) {
      connected.completeError(const SwalvoChatException(
        SwalvoChatErrorCode.connectionClosed,
        'The connection was closed before the server replied.',
      ));
    }
    _connected = null;

    await _socketSubscription?.cancel();
    _socketSubscription = null;

    await _channel?.sink.close();
    _channel = null;
  }

  void _handleFrame(dynamic raw) {
    Map<String, dynamic> frame;
    try {
      frame = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      debugPrint('[swalvo_chat] discarded a malformed frame');
      return;
    }

    final type = frame['type'] as String?;

    switch (type) {
      case 'connected':
        _handleServerHello(frame);
        return;

      case 'ack':
        _resolvePending(frame['id'] as String?, frame['data']);
        return;

      case 'error':
        _handleErrorFrame(frame);
        return;

      case 'room.joined':
      case 'room.left':
        final id = frame['id'] as String?;
        if (id != null && _pending.containsKey(id)) {
          _resolvePending(id, frame);
          return;
        }
        // A `room.left` nobody asked for: the server took this user out —
        // banned, most likely.
        final room = frame['room'] as String?;
        if (type == 'room.left' && room != null) {
          _onRemovedFromRoom(room, frame['reason'] as String? ?? 'REMOVED');
        }
        return;

      case 'presence.count':
        _emit(
          _presenceCountController,
          SwalvoPresenceCount(
            roomId: (frame['room'] ?? frame['roomId'] ?? '') as String,
            online: (frame['online'] as num?)?.toInt() ?? 0,
          ),
        );
        return;

      case 'message':
      case 'message.updated':
      case 'message.deleted':
      case 'message.pinned':
      case 'message.unpinned':
      case 'reaction.added':
      case 'reaction.removed':
      case 'member.banned':
      case 'member.unbanned':
      case 'member.muted':
      case 'member.unmuted':
        // Conversation events carry an eventSeq. The sequencer applies them
        // in order, drops ones already applied, and backfills holes; a
        // frame without one goes straight through.
        _sequencer.ingest(_roomOf(frame), frame);
        return;

      case 'typing.started':
      case 'typing.stopped':
        _emit(
          _typingController,
          SwalvoTypingEvent(
            roomId: frame['roomId'] as String? ?? '',
            userId: frame['userId'] as String? ?? '',
            isTyping: type == 'typing.started',
          ),
        );
        return;

      case 'presence':
        _emit(_presenceController, SwalvoPresence.fromJson(frame));
        return;

      case 'read':
        final state = SwalvoReadState.fromJson(frame);
        _emit(_readController, state);
        inbox.handleRead(state.roomId, state.userId, state.lastReadMessageId);
        return;

      case 'pong':
        return;

      default:
        // Forward compatibility: a newer server may send frames this
        // version predates. Ignoring beats throwing on an upgrade the
        // developer didn't ask for.
        debugPrint('[swalvo_chat] ignoring unknown frame "$type"');
    }
  }

  /// Applies one conversation event, live or replayed from the event log.
  /// The sequencer has already decided it is new and in order.
  void _dispatchConversationEvent(Map<String, dynamic> frame) {
    final type = frame['type'] as String?;
    switch (type) {
      case 'message':
        final message = frame['message'];
        if (message is Map<String, dynamic>) {
          _onLiveMessage(SwalvoMessage.fromJson(message));
        }
        return;

      case 'message.updated':
        final raw = frame['message'];
        if (raw is! Map<String, dynamic>) return;
        final message = SwalvoMessage.fromJson(raw);
        _emit(_messageUpdatedController, message);
        _emit(
          _messageUpdateEventController,
          SwalvoMessageUpdate(
              message: message, reason: frame['reason'] as String?),
        );
        return;

      case 'message.deleted':
        _emit(_messageDeletedController, frame['messageId'] as String);
        return;

      case 'message.pinned':
      case 'message.unpinned':
        final raw = frame['message'];
        final message =
            raw is Map<String, dynamic> ? SwalvoMessage.fromJson(raw) : null;
        _emit(
          _pinController,
          SwalvoPinEvent(
            pinned: type == 'message.pinned',
            roomId: _roomOf(frame),
            messageId: (frame['messageId'] as String?) ?? message?.id ?? '',
            message: message,
            by: (frame['by'] ?? frame['pinnedBy']) as String?,
            at: DateTime.tryParse(
                (frame['at'] ?? frame['pinnedAt']) as String? ?? ''),
          ),
        );
        return;

      case 'reaction.added':
      case 'reaction.removed':
        _emit(
          _reactionController,
          SwalvoReactionEvent(
            messageId: frame['messageId'] as String,
            roomId: (frame['roomId'] ?? frame['room'] ?? '') as String,
            userId: frame['userId'] as String? ?? '',
            emoji: frame['emoji'] as String? ?? '',
            added: type == 'reaction.added',
          ),
        );
        return;

      case 'member.banned':
      case 'member.unbanned':
      case 'member.muted':
      case 'member.unmuted':
        final kind = switch (type) {
          'member.banned' => SwalvoModerationKind.banned,
          'member.unbanned' => SwalvoModerationKind.unbanned,
          'member.muted' => SwalvoModerationKind.muted,
          _ => SwalvoModerationKind.unmuted,
        };
        final event = SwalvoMemberModerationEvent(
          kind: kind,
          roomId: _roomOf(frame),
          userId: frame['userId'] as String? ?? '',
          by: frame['by'] as String?,
          expiresAt: DateTime.tryParse(frame['expiresAt'] as String? ?? ''),
        );
        if (event.userId == _userId) _observeModeration(event);
        _emit(_moderationController, event);
        return;

      default:
        debugPrint('[swalvo_chat] ignoring unknown conversation event "$type"');
    }
  }

  /// De-duplicates, and holds live messages back while a catch-up is
  /// replaying older ones so a sender's messages never arrive out of order.
  void _onLiveMessage(SwalvoMessage message) {
    if (_recovering) {
      _pendingLive.add(message);
      return;
    }
    if (_recovery.accept(message)) {
      _emit(_messageController, message);
      inbox.handleMessage(message);
    }
  }

  void _flushPendingLive() {
    final buffered = List.of(_pendingLive);
    _pendingLive.clear();
    for (final message in buffered) {
      if (_recovery.accept(message)) {
        _emit(_messageController, message);
        inbox.handleMessage(message);
      }
    }
  }

  /// The server removed this user from a room. Forget it entirely:
  /// re-joining on the next reconnect would only be refused.
  void _onRemovedFromRoom(String room, String reason) {
    for (final alias in List.of(_desiredRooms)) {
      if (alias == room || _roomAliases[alias] == room) {
        _desiredRooms.remove(alias);
        _roomAliases.remove(alias);
      }
    }
    _recovery.forget(room);
    _sequencer.forget(room);
    if (reason == 'BANNED') {
      _observeModeration(SwalvoMemberModerationEvent(
          kind: SwalvoModerationKind.banned,
          roomId: room,
          userId: _userId ?? ''));
    }
    inbox.handleRemoved(room);
    _emit(_removedController,
        SwalvoRoomRemovedEvent(roomId: room, reason: reason));
  }

  Future<EventPage> _fetchEvents(
      String room, String afterEventSeq, int limit) async {
    final response = await _rest.get(
      '/v1/chat/conversations/${Uri.encodeComponent(room)}/events',
      query: {'afterEventSeq': afterEventSeq, 'limit': '$limit'},
    );
    return EventPage.fromJson(response);
  }

  /// The event log no longer reaches this room's resume point: re-read the
  /// newest history page and hand it to the app as the new truth.
  Future<void> _resyncRoom(String room) async {
    final page = await _historyRaw(room: room, limit: _resyncPageSize);
    _recovery.observeHistory(page.messages);
    _emit(_resyncController, SwalvoResyncEvent(roomId: room, page: page));
  }

  /// Replays messages, then the edits, deletes, reactions and moderation
  /// events around them — messages first, so an edit always finds the
  /// message it edits already delivered.
  Future<void> _recoverMissed(List<String> sequencedRooms) async {
    final rooms = _desiredRooms.map(_resolveRoom).toSet().where(_recovery.has);
    final perRoom = <SwalvoRoomRecoveryResult>[];
    _recovering = true;
    try {
      perRoom.addAll(await Future.wait(rooms.map(_recovery.recoverRoom)));
    } finally {
      // Always release the buffer: holding live messages back forever is
      // far worse than delivering them slightly out of order.
      _recovering = false;
      _flushPendingLive();
    }

    final events = await Future.wait(sequencedRooms.map(_sequencer.catchUp));
    for (final result in events.where((result) => result.error != null)) {
      final index = perRoom.indexWhere((entry) => entry.room == result.room);
      if (index == -1) {
        perRoom.add(
            SwalvoRoomRecoveryResult(room: result.room, error: result.error));
      } else if (perRoom[index].error == null) {
        final existing = perRoom[index];
        perRoom[index] = SwalvoRoomRecoveryResult(
          room: existing.room,
          recovered: existing.recovered,
          gap: existing.gap,
          error: result.error,
        );
      }
    }

    _emit(
      _recoveredController,
      SwalvoRecoverySummary(
        recovered: perRoom.fold(0, (total, entry) => total + entry.recovered),
        events: events.fold(0, (total, entry) => total + entry.applied),
        resynced: [
          for (final result in events)
            if (result.expired) result.room
        ],
        perRoom: perRoom,
        gap: perRoom.any((entry) => entry.gap) ||
            events.any((entry) => entry.expired),
        errors: perRoom.where((entry) => entry.error != null).toList(),
      ),
    );
  }

  List<String> _sequencedRoomsToSync() {
    final wanted = _desiredRooms.map(_resolveRoom).toSet();
    return _sequencer.knownRooms().where(wanted.contains).toList();
  }

  /// Opens a fresh socket and recovers everything missed on the old one.
  Future<void> _reconnectAndRecover() async {
    // Decided before the rejoins: the first live frames arrive the moment
    // a join is processed.
    final sequenced = _sequencedRoomsToSync();
    _sequencer.beginSync(sequenced);
    try {
      await _openSocket();
      await _syncRooms();
      inbox.handleReconnected();
      await _recoverMissed(sequenced);
    } catch (error) {
      // Never leave frames held behind a catch-up that is not coming.
      for (final room in sequenced) {
        unawaited(_sequencer.catchUp(room));
      }
      rethrow;
    } finally {
      unawaited(_outbox?.flush());
    }
  }

  String _resolveRoom(String room) => _roomAliases[room] ?? room;

  void _assertMember(String feature) {
    if (_audienceRoom != null) {
      throw SwalvoChatException(
        SwalvoChatErrorCode.notAMember,
        '$feature are for conversation members; this is a live-stream '
        'audience token.',
      );
    }
  }

  void _handleServerHello(Map<String, dynamic> frame) {
    final helloUser = frame['userId'];
    if (helloUser is String && helloUser.isNotEmpty) _userId = helloUser;
    _reconnectAttempt = 0;
    _setState(SwalvoChatConnectionState.connected);
    _scheduleTokenRefresh(frame['expiresAt'] as String?);

    _connected?.complete();
    _connected = null;
  }

  void _handleErrorFrame(Map<String, dynamic> frame) {
    final error = SwalvoChatException.fromServer(frame);
    final id = frame['id'] as String?;

    // This correlates to a call the developer made, so reject that future
    // rather than fire a global error they can't tie back to anything.
    final pending = id == null ? null : _pending.remove(id);
    if (pending != null) {
      pending.completeError(error);
      return;
    }

    // The gateway's "you were removed from this conversation": an
    // uncorrelated NOT_A_MEMBER naming the room.
    final room = frame['room'];
    if (error.code == SwalvoChatErrorCode.notAMember && room is String) {
      _onRemovedFromRoom(room, 'REMOVED');
    }
    _emit(_errorController, error);
  }

  void _handleSocketClosed() {
    // Read the close code *before* dropping the channel, because reading it
    // afterwards always yields null, which would silently turn a
    // terminal auth rejection into an endless reconnect loop.
    final closeCode = _channel?.closeCode;
    _channel = null;

    _failPending(
      const SwalvoChatException(
        SwalvoChatErrorCode.connectionClosed,
        'The connection closed before the server replied.',
      ),
    );

    if (_intentionallyClosed) {
      _setState(SwalvoChatConnectionState.disconnected);
      return;
    }

    // 4401 (auth failed) and 4403 (origin rejected) are refusals retrying
    // cannot fix. Reconnecting on a revoked token is a polite
    // denial-of-service against ourselves.
    if (closeCode == 4401 || closeCode == 4403) {
      _setState(SwalvoChatConnectionState.failed);
      _emit(
        _errorController,
        const SwalvoChatException(
          SwalvoChatErrorCode.unauthorized,
          'The chat connection was rejected. Mint a new token.',
        ),
      );
      return;
    }

    _connected?.completeError(
      const SwalvoChatException(
        SwalvoChatErrorCode.connectionClosed,
        'The chat connection closed.',
      ),
    );
    _connected = null;

    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_intentionallyClosed || _disposed) return;

    if (_reconnectAttempt >= maxReconnectAttempts) {
      _setState(SwalvoChatConnectionState.failed);
      _emit(
        _errorController,
        SwalvoChatException(
          SwalvoChatErrorCode.connectionFailed,
          'Could not reconnect after $maxReconnectAttempts attempts.',
        ),
      );
      return;
    }

    _reconnectAttempt += 1;
    _setState(SwalvoChatConnectionState.reconnecting);

    final delay = _reconnectDelay(_reconnectAttempt);
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () async {
      try {
        await _reconnectAndRecover();
      } catch (_) {
        // _openSocket already scheduled the next attempt.
      }
    });
  }

  Future<void> _syncRooms() async {
    // Presence belongs to the socket, and this is a new socket. Re-sent
    // before the rooms rather than after, so the server has this
    // connection's status in hand for the joins it is about to process
    // instead of briefly listing the user as absent from a room they are
    // demonstrably in. A no-op until something has actually called
    // setPresence: re-asserting a status nobody chose would be inventing
    // one.
    final presence = _desiredPresence;
    if (presence != null) {
      _sendFrame({'type': 'presence.set', 'status': presence.name});
    }

    for (final room in List.of(_desiredRooms)) {
      try {
        await _joinRoom(room);
      } catch (error) {
        // One unauthorized room must not stop the others joining.
        if (error is SwalvoChatException) {
          _emit(_errorController, error);
        }
      }
    }
  }

  Future<void> _joinRoom(String room) async {
    final response = await _request('room.join', {'room': room});
    // What the join told us: the room's public id, and (when the server
    // says) its event head.
    final publicId = response['room'];
    if (publicId is String && publicId.isNotEmpty) {
      _roomAliases[room] = publicId;
      _sequencer.baseline(
          publicId, response['lastEventSeq'] ?? response['eventSeq']);
    }
  }

  Future<Map<String, dynamic>> _request(
    String type,
    Map<String, dynamic> payload,
  ) async {
    final channel = _channel;
    if (channel == null) {
      throw const SwalvoChatException(
        SwalvoChatErrorCode.connectionClosed,
        'Not connected — call connect() first.',
      );
    }

    final id = 'r${++_requestCounter}';
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;

    channel.sink.add(jsonEncode({'type': type, 'id': id, ...payload}));

    return completer.future.timeout(
      requestTimeout,
      onTimeout: () {
        _pending.remove(id);
        throw const SwalvoChatException(
          SwalvoChatErrorCode.timeout,
          'The server did not respond in time.',
        );
      },
    );
  }

  /// Fire-and-forget frames: typing and presence.
  ///
  /// Dropped instead of queued when disconnected. Both are ephemeral by
  /// nature, and replaying them after a reconnect would deliver signals
  /// that were true a minute ago.
  void _sendFrame(Map<String, dynamic> frame) {
    final channel = _channel;
    if (channel == null || _state != SwalvoChatConnectionState.connected) {
      return;
    }
    channel.sink.add(jsonEncode(frame));
  }

  void _resolvePending(String? id, Object? data) {
    if (id == null) return;
    final completer = _pending.remove(id);
    completer?.complete(
      data is Map<String, dynamic> ? data : <String, dynamic>{},
    );
  }

  void _failPending(SwalvoChatException error) {
    for (final completer in _pending.values) {
      if (!completer.isCompleted) {
        completer.completeError(error);
      }
    }
    _pending.clear();
  }

  void _scheduleTokenRefresh(String? expiresAt) {
    _tokenRefreshTimer?.cancel();

    final refresh = onTokenExpiring;
    if (refresh == null || expiresAt == null) return;

    final expiry = DateTime.tryParse(expiresAt);
    if (expiry == null) return;

    // A minute of headroom, never less than five seconds out, so a
    // short-lived token can't schedule its refresh in the past.
    final target = expiry.subtract(const Duration(minutes: 1));
    final delay = target.difference(DateTime.now());
    final wait =
        delay < const Duration(seconds: 5) ? const Duration(seconds: 5) : delay;

    _tokenRefreshTimer = Timer(wait, () async {
      try {
        final fresh = await refresh();
        _token = fresh;
        _rest.token = fresh;

        // Reconnect with the new token. The socket authenticated with the
        // old one stays valid until it expires, so this is a clean swap
        // rather than a race.
        await _teardownSocket();
        await _reconnectAndRecover();
      } catch (error) {
        _emit(
          _errorController,
          SwalvoChatException(
            SwalvoChatErrorCode.tokenExpired,
            'Could not refresh the chat token.',
            cause: error,
          ),
        );
      }
    });
  }

  String _defaultRoom() {
    if (_desiredRooms.isEmpty) {
      throw const SwalvoChatException(
        SwalvoChatErrorCode.notInRoom,
        'No room selected — pass a room, or call connect(room) first.',
      );
    }
    return _desiredRooms.first;
  }

  void _setState(SwalvoChatConnectionState next) {
    if (_state == next || _disposed) return;
    _state = next;
    _emit(_stateController, next);
    notifyListeners();
  }

  void _emit<T>(StreamController<T> controller, T value) {
    if (_disposed || controller.isClosed) return;
    controller.add(value);
  }

  String _generateClientMessageId() {
    final random = Random();
    final suffix =
        List.generate(8, (_) => random.nextInt(36).toRadixString(36)).join();
    return 'cm_${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}$suffix';
  }
}

const String _sdkVersion = '0.2.0';

/// The server refuses more, so refuse locally rather than queue a send
/// that can never succeed.
const _maxMentions = 50;

/// How much history to re-read when a room's event log has expired.
const _resyncPageSize = 50;

/// The conversation a frame belongs to, wherever this frame type keeps it.
String _roomOf(Map<String, dynamic> frame) {
  final message = frame['message'];
  return (frame['roomId'] ??
      frame['room'] ??
      (message is Map<String, dynamic> ? message['roomId'] : null) ??
      '') as String;
}

/// Reads a token's claims without verifying it — the server's opinion is
/// the only one that counts. Never throws: a token this cannot decode
/// simply has no claims here.
Map<String, dynamic> _decodeClaims(String token) {
  final parts = token.split('.');
  if (parts.length != 3) return const {};
  try {
    final decoded = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
    return decoded is Map<String, dynamic> ? decoded : const {};
  } catch (_) {
    return const {};
  }
}

/// Reads a paginated list of messages, tolerating a bare array.
SwalvoCursorPage<SwalvoMessage> _messagePage(
    Object? response, List<String> keys) {
  final items = listOf(response, keys)
      .map(SwalvoMessage.fromJson)
      .toList(growable: false);
  final wrapper = response is Map<String, dynamic> ? response : const {};
  final next = wrapper['nextCursor'];
  final nextCursor = next is String ? next : null;
  final hasMore = wrapper['hasMore'];
  return SwalvoCursorPage(
    items: items,
    nextCursor: nextCursor,
    hasMore: hasMore is bool ? hasMore : nextCursor != null,
  );
}

/// `https://api.example.com` -> `wss://api.example.com/v1/chat/ws`
String _deriveChatUrl(String? apiUrl) {
  if (apiUrl == null) {
    throw ArgumentError(
      'SwalvoChat needs either apiUrl or chatUrl — both come from your '
      'backend\'s token-mint response.',
    );
  }
  final ws = apiUrl
      .replaceFirst(RegExp(r'^http:'), 'ws:')
      .replaceFirst(RegExp(r'^https:'), 'wss:')
      .replaceAll(RegExp(r'/$'), '');
  return '$ws/v1/chat/ws';
}

/// The inverse, so passing only `chatUrl` still gives working REST calls.
String _deriveApiUrl(String? chatUrl) {
  if (chatUrl == null) {
    throw ArgumentError(
      'SwalvoChat needs either apiUrl or chatUrl — both come from your '
      'backend\'s token-mint response.',
    );
  }
  return chatUrl
      .replaceFirst(RegExp(r'^ws:'), 'http:')
      .replaceFirst(RegExp(r'^wss:'), 'https:')
      .replaceFirst(RegExp(r'/v1/chat/ws$'), '');
}

/// Shortest gap between two `typing.start` frames for the same room.
///
/// Chosen against both ends of the problem: the server allows 20 typing
/// frames per 10 seconds, and the indicator it drives expires on a TTL of
/// several seconds. Two seconds is comfortably inside the first and
/// comfortably shorter than the second, so nothing is refused and no
/// indicator lapses while somebody is still typing.
const _typingInterval = Duration(seconds: 2);
