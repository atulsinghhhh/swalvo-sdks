import 'seq.dart';

/// Message kinds Swalvo understands. `unknown` exists so a newer server
/// sending a type this version predates widens the model instead of
/// throwing on an app the developer didn't change.
enum SwalvoMessageType { text, system, event, attachment, unknown }

enum SwalvoPresenceStatus { online, away, offline }

/// Connection lifecycle, matching `@swalvo/chat`'s vocabulary exactly.
///
/// `failed` is terminal: reconnect attempts are exhausted, or the
/// failure is one retrying cannot fix, like a revoked token.
/// `disconnected` means the connection ended and nothing is being
/// retried.
enum SwalvoChatConnectionState {
  idle,
  connecting,
  connected,
  reconnecting,
  disconnected,
  failed,
}

/// A reaction, already grouped per emoji.
///
/// Grouping happens server-side so every client renders "👍 ×3" the same
/// way instead of each one regrouping raw rows.
class SwalvoReaction {
  const SwalvoReaction({
    required this.emoji,
    required this.count,
    required this.userIds,
  });

  factory SwalvoReaction.fromJson(Map<String, dynamic> json) => SwalvoReaction(
        emoji: json['emoji'] as String? ?? '',
        count: (json['count'] as num?)?.toInt() ?? 0,
        userIds: (json['userIds'] as List<dynamic>? ?? const [])
            .map((value) => value as String)
            .toList(growable: false),
      );

  final String emoji;
  final int count;

  /// Who reacted. Lets a UI show "you reacted" and a hover list without a
  /// second request.
  final List<String> userIds;
}

/// File metadata attached to a message. The bytes live in object storage
/// and are reached through a short-lived signed URL, never through this
/// object.
class SwalvoAttachment {
  const SwalvoAttachment({
    required this.id,
    required this.filename,
    required this.mimeType,
    required this.size,
    required this.status,
  });

  factory SwalvoAttachment.fromJson(Map<String, dynamic> json) =>
      SwalvoAttachment(
        id: json['id'] as String,
        filename: json['filename'] as String? ?? 'file',
        mimeType: json['mimeType'] as String? ?? 'application/octet-stream',
        size: (json['size'] as num?)?.toInt() ?? 0,
        status: json['status'] as String? ?? 'pending',
      );

  final String id;
  final String filename;
  final String mimeType;
  final int size;
  final String status;
}

/// What the server unfurled from the first http(s) URL in a message
/// (Phase 3 §5).
///
/// Arrives after the message itself: the unfurl is asynchronous, so a
/// message is first delivered without one and then re-delivered through
/// `messageUpdateEvents` with reason `link_preview`.
class SwalvoLinkPreview {
  const SwalvoLinkPreview({
    required this.url,
    this.title,
    this.description,
    this.imageUrl,
    this.siteName,
  });

  /// Reads `metadata.linkPreview`, or null when there is none.
  static SwalvoLinkPreview? fromMetadata(Map<String, dynamic>? metadata) {
    final preview = metadata?['linkPreview'];
    if (preview is! Map<String, dynamic>) return null;
    final url = preview['url'];
    if (url is! String || url.isEmpty) return null;
    String? pick(String key) {
      final value = preview[key];
      return value is String ? value : null;
    }

    return SwalvoLinkPreview(
      url: url,
      title: pick('title'),
      description: pick('description'),
      imageUrl: pick('imageUrl'),
      siteName: pick('siteName'),
    );
  }

  final String url;
  final String? title;
  final String? description;
  final String? imageUrl;
  final String? siteName;
}

/// A message, exactly as the server stored it.
///
/// [id] and [createdAt] are always the server's: the SDK never invents
/// either, which is what keeps ordering consistent across every client in
/// a room.
class SwalvoMessage {
  const SwalvoMessage({
    required this.id,
    required this.roomId,
    required this.senderId,
    required this.type,
    required this.text,
    required this.createdAt,
    this.replyTo,
    this.threadRootId,
    this.clientMessageId,
    this.metadata,
    this.attachment,
    this.reactions = const [],
    this.edited = false,
    this.deleted = false,
    this.editedAt,
    this.deletedAt,
    this.cursor,
    this.seq,
    this.mentions = const [],
    this.linkPreview,
    this.replyCount,
    this.lastReplyAt,
  });

  factory SwalvoMessage.fromJson(Map<String, dynamic> json) {
    final metadata = json['metadata'] as Map<String, dynamic>?;
    return SwalvoMessage(
      id: json['id'] as String,
      roomId: json['roomId'] as String? ?? '',
      senderId: json['senderId'] as String? ?? '',
      type: _parseType(json['type'] as String?),
      // Null for a deleted message: the server withholds the body
      // rather than sending it with a flag, so it can't be recovered
      // from the payload.
      text: json['text'] as String?,
      replyTo: json['replyTo'] as String?,
      threadRootId: json['threadRootId'] as String?,
      clientMessageId: json['clientMessageId'] as String?,
      metadata: metadata,
      attachment: json['attachment'] == null
          ? null
          : SwalvoAttachment.fromJson(
              json['attachment'] as Map<String, dynamic>),
      reactions: (json['reactions'] as List<dynamic>? ?? const [])
          .map(
              (value) => SwalvoReaction.fromJson(value as Map<String, dynamic>))
          .toList(growable: false),
      edited: json['edited'] as bool? ?? false,
      deleted: json['deleted'] as bool? ?? false,
      createdAt: DateTime.parse(json['createdAt'] as String),
      editedAt: _parseDate(json['editedAt']),
      deletedAt: _parseDate(json['deletedAt']),
      cursor: json['cursor'] as String?,
      seq: parseSeq(json['seq'])?.toString(),
      mentions: (json['mentions'] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toList(growable: false),
      linkPreview: SwalvoLinkPreview.fromMetadata(metadata),
      replyCount: (json['replyCount'] as num?)?.toInt(),
      lastReplyAt: _parseDate(json['lastReplyAt']),
    );
  }

  /// Swalvo's canonical `msg_…` id.
  final String id;

  /// The conversation's public id: the same string passed to `connect`.
  final String roomId;
  final String senderId;
  final SwalvoMessageType type;

  /// Null for messages with no text, and for deleted ones.
  final String? text;

  /// The message this replies to, if any.
  final String? replyTo;

  /// The thread this belongs to. Equals the root message's id.
  final String? threadRootId;

  /// Whatever was passed as an idempotency key, echoed back.
  final String? clientMessageId;
  final Map<String, dynamic>? metadata;
  final SwalvoAttachment? attachment;
  final List<SwalvoReaction> reactions;
  final bool edited;
  final bool deleted;
  final DateTime createdAt;
  final DateTime? editedAt;
  final DateTime? deletedAt;

  /// Opaque resume point: pass it as `after` to [SwalvoChat.history] to
  /// fetch everything after this message. The SDK's own catch-up uses it;
  /// you rarely need to. Null from servers that predate it.
  final String? cursor;

  /// The message's position in its conversation: strictly increasing,
  /// with no gaps among created messages. A decimal string because it is
  /// a 64-bit counter; compare with [compareSeq], never with `<` on the
  /// strings. Null from servers older than Phase 3.
  final String? seq;

  /// userIds this message mentions.
  final List<String> mentions;

  /// `metadata.linkPreview`, lifted out. Null until the unfurl lands.
  final SwalvoLinkPreview? linkPreview;

  /// Thread roots only: how many replies the thread has.
  final int? replyCount;

  /// Thread roots only: when the newest reply was sent.
  final DateTime? lastReplyAt;

  /// A copy with the given fields replaced. Used by the store to fold an
  /// edit or a deletion into an existing list without rebuilding it.
  SwalvoMessage copyWith({
    String? text,
    bool? edited,
    bool? deleted,
    DateTime? editedAt,
    DateTime? deletedAt,
    List<SwalvoReaction>? reactions,
  }) =>
      SwalvoMessage(
        id: id,
        roomId: roomId,
        senderId: senderId,
        type: type,
        text: text ?? this.text,
        replyTo: replyTo,
        threadRootId: threadRootId,
        clientMessageId: clientMessageId,
        metadata: metadata,
        attachment: attachment,
        reactions: reactions ?? this.reactions,
        edited: edited ?? this.edited,
        deleted: deleted ?? this.deleted,
        createdAt: createdAt,
        editedAt: editedAt ?? this.editedAt,
        deletedAt: deletedAt ?? this.deletedAt,
        cursor: cursor,
        seq: seq,
        mentions: mentions,
        linkPreview: linkPreview,
        replyCount: replyCount,
        lastReplyAt: lastReplyAt,
      );

  @override
  bool operator ==(Object other) => other is SwalvoMessage && other.id == id;

  @override
  int get hashCode => id.hashCode;
}

/// One page of history.
///
/// Pagination is cursor-based, never offset-based: pass [nextCursor] as
/// `before` to walk back through history, or [previousCursor] as `after`
/// to catch up on what arrived while disconnected.
class SwalvoMessagePage {
  const SwalvoMessagePage({
    required this.messages,
    this.nextCursor,
    this.previousCursor,
    this.hasMore = false,
  });

  factory SwalvoMessagePage.fromJson(Map<String, dynamic> json) =>
      SwalvoMessagePage(
        messages: (json['data'] as List<dynamic>? ?? const [])
            .map((value) =>
                SwalvoMessage.fromJson(value as Map<String, dynamic>))
            .toList(growable: false),
        nextCursor: json['nextCursor'] as String?,
        previousCursor: json['previousCursor'] as String?,
        hasMore: json['hasMore'] as bool? ?? false,
      );

  final List<SwalvoMessage> messages;
  final String? nextCursor;
  final String? previousCursor;
  final bool hasMore;
}

/// Someone's presence in a conversation. Ephemeral by design: this is
/// never read from durable storage.
class SwalvoPresence {
  const SwalvoPresence({required this.userId, required this.status});

  factory SwalvoPresence.fromJson(Map<String, dynamic> json) => SwalvoPresence(
        userId: json['userId'] as String,
        status: _parsePresence(json['status'] as String?),
      );

  final String userId;
  final SwalvoPresenceStatus status;
}

/// A user's read position in a conversation.
class SwalvoReadState {
  const SwalvoReadState({
    required this.roomId,
    required this.userId,
    required this.lastReadMessageId,
    required this.unreadCount,
  });

  factory SwalvoReadState.fromJson(Map<String, dynamic> json) =>
      SwalvoReadState(
        roomId: json['roomId'] as String? ?? '',
        userId: json['userId'] as String? ?? '',
        // A `read` frame names the message as `messageId`; the REST read
        // state calls it `lastReadMessageId`. Same fact, either spelling.
        lastReadMessageId: json['lastReadMessageId'] as String? ??
            json['messageId'] as String?,
        unreadCount: (json['unreadCount'] as num?)?.toInt() ?? 0,
      );

  final String roomId;
  final String userId;
  final String? lastReadMessageId;
  final int unreadCount;
}

/// Someone started or stopped typing.
class SwalvoTypingEvent {
  const SwalvoTypingEvent({
    required this.roomId,
    required this.userId,
    required this.isTyping,
  });

  final String roomId;
  final String userId;
  final bool isTyping;
}

/// A reaction was added or removed.
class SwalvoReactionEvent {
  const SwalvoReactionEvent({
    required this.messageId,
    required this.roomId,
    required this.userId,
    required this.emoji,
    required this.added,
  });

  final String messageId;
  final String roomId;
  final String userId;
  final String emoji;
  final bool added;
}

SwalvoMessageType _parseType(String? value) {
  switch (value) {
    case 'text':
      return SwalvoMessageType.text;
    case 'system':
      return SwalvoMessageType.system;
    case 'event':
      return SwalvoMessageType.event;
    case 'attachment':
      return SwalvoMessageType.attachment;
    default:
      return SwalvoMessageType.unknown;
  }
}

SwalvoPresenceStatus _parsePresence(String? value) {
  switch (value) {
    case 'online':
      return SwalvoPresenceStatus.online;
    case 'away':
      return SwalvoPresenceStatus.away;
    default:
      return SwalvoPresenceStatus.offline;
  }
}

DateTime? _parseDate(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;
