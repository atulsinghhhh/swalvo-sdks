// Models for the Phase 3 chat surface (docs/architecture/phase3-chat-contracts.md):
// inbox, moderation, push, pins, search, presence counts and recovery.
// Shapes match `@swalvo/chat`'s types one for one.

import 'errors.dart';
import 'models.dart';
import 'seq.dart';

// ---------------------------------------------------------------------------
// Inbox (§2)
// ---------------------------------------------------------------------------

/// Per-conversation push preference (§4.1). A muted conversation behaves
/// as [none].
enum SwalvoNotificationLevel { all, mentions, none }

/// The newest message in an inbox row: a summary, not the full message.
class SwalvoInboxLastMessage {
  const SwalvoInboxLastMessage({
    required this.id,
    required this.senderId,
    required this.type,
    required this.createdAt,
    this.seq,
    this.content,
  });

  factory SwalvoInboxLastMessage.fromJson(Map<String, dynamic> json) =>
      SwalvoInboxLastMessage(
        id: json['id'] as String? ?? '',
        seq: parseSeq(json['seq'])?.toString(),
        senderId: json['senderId'] as String? ?? '',
        content: json['content'] as String?,
        type: json['type'] as String? ?? 'TEXT',
        createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ??
            DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      );

  final String id;
  final String? seq;
  final String senderId;
  final String? content;
  final String type;
  final DateTime createdAt;
}

/// One conversation in this user's inbox.
class SwalvoInboxConversation {
  const SwalvoInboxConversation({
    required this.id,
    required this.type,
    required this.updatedAt,
    this.name,
    this.metadata = const {},
    this.role = 'MEMBER',
    this.muted = false,
    this.notifications = SwalvoNotificationLevel.all,
    this.lastMessage,
    this.unreadCount = 0,
    this.unreadMentions = 0,
    this.lastReadSeq,
  });

  factory SwalvoInboxConversation.fromJson(Map<String, dynamic> json) {
    final last = json['lastMessage'];
    return SwalvoInboxConversation(
      id: json['id'] as String,
      name: json['name'] as String?,
      type: json['type'] as String? ?? 'CHANNEL',
      metadata: json['metadata'] as Map<String, dynamic>? ?? const {},
      role: json['role'] as String? ?? 'MEMBER',
      muted: json['muted'] as bool? ?? false,
      notifications: parseNotificationLevel(json['notifications'] as String?),
      lastMessage: last is Map<String, dynamic>
          ? SwalvoInboxLastMessage.fromJson(last)
          : null,
      unreadCount: (json['unreadCount'] as num?)?.toInt() ?? 0,
      unreadMentions: (json['unreadMentions'] as num?)?.toInt() ?? 0,
      lastReadSeq: parseSeq(json['lastReadSeq'])?.toString(),
      updatedAt: DateTime.tryParse(json['updatedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    );
  }

  final String id;
  final String? name;

  /// `DIRECT`, `CHANNEL` or `ROOM`.
  final String type;
  final Map<String, dynamic> metadata;

  /// `MEMBER`, `MODERATOR` or `ADMIN`.
  final String role;
  final bool muted;
  final SwalvoNotificationLevel notifications;
  final SwalvoInboxLastMessage? lastMessage;
  final int unreadCount;

  /// Unread messages that mention this user.
  final int unreadMentions;
  final String? lastReadSeq;
  final DateTime updatedAt;

  /// Newest of the last message and the row's own update, which is what
  /// the inbox is sorted by.
  DateTime get lastActivity {
    final last = lastMessage?.createdAt;
    return last != null && last.isAfter(updatedAt) ? last : updatedAt;
  }

  SwalvoInboxConversation copyWith({
    bool? muted,
    SwalvoNotificationLevel? notifications,
    SwalvoInboxLastMessage? lastMessage,
    int? unreadCount,
    int? unreadMentions,
    String? lastReadSeq,
    DateTime? updatedAt,
  }) =>
      SwalvoInboxConversation(
        id: id,
        name: name,
        type: type,
        metadata: metadata,
        role: role,
        muted: muted ?? this.muted,
        notifications: notifications ?? this.notifications,
        lastMessage: lastMessage ?? this.lastMessage,
        unreadCount: unreadCount ?? this.unreadCount,
        unreadMentions: unreadMentions ?? this.unreadMentions,
        lastReadSeq: lastReadSeq ?? this.lastReadSeq,
        updatedAt: updatedAt ?? this.updatedAt,
      );
}

class SwalvoInboxPage {
  const SwalvoInboxPage({required this.conversations, this.nextCursor});

  factory SwalvoInboxPage.fromJson(Map<String, dynamic> json) =>
      SwalvoInboxPage(
        conversations: (json['conversations'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(SwalvoInboxConversation.fromJson)
            .toList(growable: false),
        nextCursor: json['nextCursor'] as String?,
      );

  final List<SwalvoInboxConversation> conversations;

  /// Pass back as `cursor` for the next page. Null once there are no more.
  final String? nextCursor;
}

// ---------------------------------------------------------------------------
// Moderation (§3)
// ---------------------------------------------------------------------------

enum SwalvoModerationKind { banned, unbanned, muted, unmuted }

/// A moderator action broadcast to the conversation.
class SwalvoMemberModerationEvent {
  const SwalvoMemberModerationEvent({
    required this.kind,
    required this.roomId,
    required this.userId,
    this.by,
    this.expiresAt,
  });

  final SwalvoModerationKind kind;
  final String roomId;
  final String userId;

  /// Who did it.
  final String? by;

  /// When a timed ban or mute lifts. Null for permanent ones.
  final DateTime? expiresAt;
}

/// This user lost access to a room they had not asked to leave.
class SwalvoRoomRemovedEvent {
  const SwalvoRoomRemovedEvent({required this.roomId, required this.reason});

  final String roomId;

  /// `BANNED` when a moderator banned them; `REMOVED` when their
  /// membership was revoked. Treat unknown values as "removed".
  final String reason;
}

/// This user's own standing in one conversation, as far as this client has
/// been told: a `member.*` event about them, or a refused send.
class SwalvoModerationState {
  const SwalvoModerationState({
    this.muted = false,
    this.mutedUntil,
    this.banned = false,
    this.bannedUntil,
  });

  final bool muted;
  final DateTime? mutedUntil;
  final bool banned;
  final DateTime? bannedUntil;
}

enum SwalvoFlagReason { spam, harassment, hate, sexual, violence, other }

class SwalvoBlock {
  const SwalvoBlock({required this.userId, this.createdAt});

  factory SwalvoBlock.fromJson(Map<String, dynamic> json) => SwalvoBlock(
        userId: (json['userId'] ?? json['blockedId'] ?? '') as String,
        createdAt: DateTime.tryParse(json['createdAt'] as String? ?? ''),
      );

  final String userId;
  final DateTime? createdAt;
}

// ---------------------------------------------------------------------------
// Push (§4)
// ---------------------------------------------------------------------------

enum SwalvoPushProvider { apns, fcm }

enum SwalvoDevicePlatform { ios, android, web }

class SwalvoDevice {
  const SwalvoDevice({
    required this.provider,
    required this.token,
    required this.platform,
    this.appBundleId,
    this.lastSeenAt,
    this.createdAt,
  });

  factory SwalvoDevice.fromJson(Map<String, dynamic> json) => SwalvoDevice(
        provider: json['provider'] == 'apns'
            ? SwalvoPushProvider.apns
            : SwalvoPushProvider.fcm,
        token: json['token'] as String? ?? '',
        platform: switch (json['platform']) {
          'ios' => SwalvoDevicePlatform.ios,
          'web' => SwalvoDevicePlatform.web,
          _ => SwalvoDevicePlatform.android,
        },
        appBundleId: json['appBundleId'] as String?,
        lastSeenAt: DateTime.tryParse(json['lastSeenAt'] as String? ?? ''),
        createdAt: DateTime.tryParse(json['createdAt'] as String? ?? ''),
      );

  final SwalvoPushProvider provider;
  final String token;
  final SwalvoDevicePlatform platform;
  final String? appBundleId;
  final DateTime? lastSeenAt;
  final DateTime? createdAt;
}

class SwalvoNotificationPreferences {
  const SwalvoNotificationPreferences({
    required this.roomId,
    required this.notifications,
    required this.muted,
  });

  final String roomId;
  final SwalvoNotificationLevel notifications;
  final bool muted;
}

SwalvoNotificationLevel parseNotificationLevel(String? value) {
  switch (value) {
    case 'mentions':
      return SwalvoNotificationLevel.mentions;
    case 'none':
      return SwalvoNotificationLevel.none;
    default:
      return SwalvoNotificationLevel.all;
  }
}

// ---------------------------------------------------------------------------
// Messages (§5)
// ---------------------------------------------------------------------------

/// A cursor-paginated list: search results, a thread, pins.
class SwalvoCursorPage<T> {
  const SwalvoCursorPage({
    required this.items,
    this.nextCursor,
    this.hasMore = false,
  });

  final List<T> items;

  /// Pass back as `cursor` for the next page.
  final String? nextCursor;
  final bool hasMore;
}

/// A `message.updated`, with why it happened.
class SwalvoMessageUpdate {
  const SwalvoMessageUpdate({required this.message, this.reason});

  final SwalvoMessage message;

  /// `link_preview` when the server's unfurl landed; usually absent for an
  /// edit (older servers only ever sent edits).
  final String? reason;
}

/// A message was pinned to, or unpinned from, its conversation.
class SwalvoPinEvent {
  const SwalvoPinEvent({
    required this.pinned,
    required this.roomId,
    required this.messageId,
    this.message,
    this.by,
    this.at,
  });

  final bool pinned;
  final String roomId;
  final String messageId;

  /// The full message, when the server includes it.
  final SwalvoMessage? message;
  final String? by;
  final DateTime? at;
}

// ---------------------------------------------------------------------------
// Presence (§6)
// ---------------------------------------------------------------------------

/// In a large room the server sends a count instead of one frame per
/// arrival, at most every five seconds.
class SwalvoPresenceCount {
  const SwalvoPresenceCount({required this.roomId, required this.online});

  final String roomId;
  final int online;
}

class SwalvoPresencePage {
  const SwalvoPresencePage({required this.presence, this.nextCursor});

  final List<SwalvoPresence> presence;
  final String? nextCursor;
}

// ---------------------------------------------------------------------------
// Recovery (§1)
// ---------------------------------------------------------------------------

/// The SDK could not catch up a room's edits and reactions — the client
/// was away longer than the server's 7-day event log — so it re-read the
/// newest page of history instead. A view holding its own copy of the
/// conversation should replace it with [page].
class SwalvoResyncEvent {
  const SwalvoResyncEvent({required this.roomId, required this.page});

  final String roomId;
  final SwalvoMessagePage page;
}

/// How one room's catch-up went.
class SwalvoRoomRecoveryResult {
  const SwalvoRoomRecoveryResult({
    required this.room,
    this.recovered = 0,
    this.gap = false,
    this.error,
  });

  final String room;
  final int recovered;

  /// The resume point was rejected and catch-up restarted from the
  /// newest page, so older missed messages were skipped.
  final bool gap;
  final SwalvoChatException? error;
}

/// Catch-up after a reconnect has finished. Anything recovered has already
/// been delivered through the usual streams.
class SwalvoRecoverySummary {
  const SwalvoRecoverySummary({
    this.recovered = 0,
    this.events = 0,
    this.resynced = const [],
    this.perRoom = const [],
    this.gap = false,
    this.errors = const [],
  });

  /// Missed messages delivered, across every room.
  final int recovered;

  /// Missed edits, deletes, reactions and moderation events applied from
  /// the event log.
  final int events;

  /// Rooms whose event log had expired, so history was re-read.
  final List<String> resynced;
  final List<SwalvoRoomRecoveryResult> perRoom;

  /// Some messages or events could not be recovered; reload the view.
  final bool gap;

  /// Rooms whose catch-up did not complete; retried on the next reconnect.
  final List<SwalvoRoomRecoveryResult> errors;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/// Step 1 of an upload: where to PUT the bytes.
class SwalvoAttachmentUploadTicket {
  const SwalvoAttachmentUploadTicket({
    required this.id,
    required this.filename,
    required this.mimeType,
    required this.size,
    required this.status,
    required this.uploadUrl,
    this.uploadMethod = 'PUT',
    this.uploadHeaders = const {},
    this.roomId,
    this.storageKey,
    this.expiresAt,
  });

  factory SwalvoAttachmentUploadTicket.fromJson(Map<String, dynamic> json) =>
      SwalvoAttachmentUploadTicket(
        id: json['id'] as String,
        roomId: json['roomId'] as String?,
        filename: json['filename'] as String? ?? 'upload',
        mimeType: json['mimeType'] as String? ?? 'application/octet-stream',
        size: (json['size'] as num?)?.toInt() ?? 0,
        storageKey: json['storageKey'] as String?,
        status: json['status'] as String? ?? 'pending',
        uploadUrl: json['uploadUrl'] as String? ?? '',
        uploadMethod: json['uploadMethod'] as String? ?? 'PUT',
        uploadHeaders:
            (json['uploadHeaders'] as Map<String, dynamic>? ?? const {})
                .map((key, value) => MapEntry(key, '$value')),
        expiresAt: DateTime.tryParse(json['expiresAt'] as String? ?? ''),
      );

  /// The `att_…` id to pass as `send(attachmentId: …)` once uploaded.
  final String id;
  final String? roomId;
  final String filename;
  final String mimeType;
  final int size;
  final String? storageKey;
  final String status;
  final String uploadUrl;
  final String uploadMethod;
  final Map<String, String> uploadHeaders;
  final DateTime? expiresAt;

  SwalvoAttachmentUploadTicket withStatus(String value) =>
      SwalvoAttachmentUploadTicket(
        id: id,
        roomId: roomId,
        filename: filename,
        mimeType: mimeType,
        size: size,
        storageKey: storageKey,
        status: value,
        uploadUrl: uploadUrl,
        uploadMethod: uploadMethod,
        uploadHeaders: uploadHeaders,
        expiresAt: expiresAt,
      );
}

/// Reads a list out of a response that may be a bare array or wrapped
/// under one of [keys].
List<Map<String, dynamic>> listOf(Object? response, List<String> keys) {
  if (response is List) {
    return response.whereType<Map<String, dynamic>>().toList();
  }
  if (response is Map<String, dynamic>) {
    for (final key in keys) {
      final value = response[key];
      if (value is List) {
        return value.whereType<Map<String, dynamic>>().toList();
      }
    }
  }
  return const [];
}
