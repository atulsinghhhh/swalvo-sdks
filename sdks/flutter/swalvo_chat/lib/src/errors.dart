/// Stable error codes, identical to `@swalvo/chat`'s on the web.
///
/// A team shipping web and Flutter should be reading one vocabulary, and
/// a support conversation shouldn't depend on which platform the user was
/// on. `unknown` is the deliberate escape hatch: a code this version
/// predates becomes `unknown` with the original string preserved on
/// [SwalvoChatException.rawCode], rather than crashing an app that a
/// server upgrade moved underneath.
enum SwalvoChatErrorCode {
  invalidToken,
  tokenExpired,
  tokenRevoked,
  unauthorized,
  permissionDenied,
  notAMember,
  roomNotFound,
  notInRoom,
  conversationArchived,
  messageNotFound,
  messageDeleted,
  messageTooLarge,
  invalidMessage,
  invalidCursor,
  rateLimited,
  attachmentNotFound,

  /// A moderator muted this user in the conversation. They can still read.
  muted,

  /// Banned from the conversation, or app-wide.
  banned,

  /// A DIRECT conversation where one side has blocked the other.
  blocked,

  /// The conversation is in slow mode; see
  /// [SwalvoChatException.retryAfterSeconds].
  slowMode,

  /// The project's pre-send moderation hook refused the message; see
  /// [SwalvoChatException.reason].
  messageBlocked,

  /// The event log no longer reaches the resume point. The SDK handles
  /// this itself by re-reading history; you see it only if you call the
  /// events endpoint yourself.
  eventsExpired,

  /// Client-side only: a queued send was cancelled before it went out.
  messageCancelled,
  connectionFailed,
  connectionClosed,
  networkError,
  timeout,
  internalError,
  unknown,
}

/// The one error type this package throws.
///
/// Never a raw `WebSocketException`, a `SocketException`, or an HTTP
/// status: those are infrastructure Swalvo is meant to be hiding.
class SwalvoChatException implements Exception {
  const SwalvoChatException(
    this.code,
    this.message, {
    this.rawCode,
    this.retryAfterSeconds,
    this.reason,
    this.scope,
    this.queued = false,
    this.clientMessageId,
    this.cause,
  });

  /// Builds one from a server error payload: a WebSocket `error` frame or
  /// an HTTP error body.
  ///
  /// Over HTTP the API reports the canonical `RAVEN_*` code in `code` and
  /// the chat plane's own code in `legacyCode`. Reading `code` alone turned
  /// every REST failure into [SwalvoChatErrorCode.unknown], so the chat
  /// code wins when there is one, and a bare `RAVEN_` prefix is stripped
  /// as the fallback.
  factory SwalvoChatException.fromServer(Map<String, dynamic> json) {
    final legacy = json['legacyCode'] as String?;
    final code = json['code'] as String?;
    final raw = legacy ??
        (code != null && code.startsWith('RAVEN_')
            ? code.substring('RAVEN_'.length)
            : code);
    return SwalvoChatException(
      parseChatErrorCode(raw),
      json['message'] as String? ?? 'The chat request failed.',
      rawCode: raw,
      retryAfterSeconds: (json['retryAfterSeconds'] as num?)?.toInt(),
      reason: json['reason'] as String?,
      scope: json['scope'] as String?,
    );
  }

  /// A copy marked as belonging to a send that is still queued in the
  /// outbox. See [queued].
  SwalvoChatException asQueued(String clientMessageId) => SwalvoChatException(
        code,
        message,
        rawCode: rawCode,
        retryAfterSeconds: retryAfterSeconds,
        reason: reason,
        scope: scope,
        queued: true,
        clientMessageId: clientMessageId,
        cause: cause,
      );

  /// A copy tagged with the send it belongs to.
  SwalvoChatException forMessage(String clientMessageId) => SwalvoChatException(
        code,
        message,
        rawCode: rawCode,
        retryAfterSeconds: retryAfterSeconds,
        reason: reason,
        scope: scope,
        queued: queued,
        clientMessageId: clientMessageId,
        cause: cause,
      );

  final SwalvoChatErrorCode code;
  final String message;

  /// The server's original code string. Set when [code] is
  /// [SwalvoChatErrorCode.unknown], so a developer can still see what
  /// arrived.
  final String? rawCode;

  /// Set on [SwalvoChatErrorCode.rateLimited] and
  /// [SwalvoChatErrorCode.slowMode]: how long to wait.
  final int? retryAfterSeconds;

  /// Set on [SwalvoChatErrorCode.messageBlocked]: what the moderation hook
  /// said, or `moderation_unavailable` when it could not be reached and
  /// the project fails closed.
  final String? reason;

  /// Set on [SwalvoChatErrorCode.rateLimited] when the server says which
  /// limit tripped. `conversation` is the per-conversation send cap.
  final String? scope;

  /// True on a `send()` failure that did not fail for good: the message is
  /// still in the outbox and goes out again, with the same idempotency
  /// key, when the connection comes back. Check this before showing an
  /// error — the message is pending, not lost.
  final bool queued;

  /// The idempotency key of the send this error belongs to, when it came
  /// from `send()`.
  final String? clientMessageId;

  final Object? cause;

  /// True when retrying could plausibly succeed. A rejected token or a
  /// message that's too large will fail identically forever.
  bool get isRetryable =>
      code == SwalvoChatErrorCode.networkError ||
      code == SwalvoChatErrorCode.timeout ||
      code == SwalvoChatErrorCode.connectionClosed ||
      code == SwalvoChatErrorCode.rateLimited ||
      code == SwalvoChatErrorCode.internalError;

  @override
  String toString() => 'SwalvoChatException(${rawCode ?? code.name}): $message';
}

/// Maps a server code string onto the enum.
SwalvoChatErrorCode parseChatErrorCode(String? raw) {
  switch (raw) {
    case 'INVALID_TOKEN':
      return SwalvoChatErrorCode.invalidToken;
    case 'TOKEN_EXPIRED':
      return SwalvoChatErrorCode.tokenExpired;
    case 'TOKEN_REVOKED':
      return SwalvoChatErrorCode.tokenRevoked;
    case 'UNAUTHORIZED':
      return SwalvoChatErrorCode.unauthorized;
    case 'PERMISSION_DENIED':
      return SwalvoChatErrorCode.permissionDenied;
    case 'NOT_A_MEMBER':
      return SwalvoChatErrorCode.notAMember;
    case 'ROOM_NOT_FOUND':
      return SwalvoChatErrorCode.roomNotFound;
    case 'NOT_IN_ROOM':
      return SwalvoChatErrorCode.notInRoom;
    case 'CONVERSATION_ARCHIVED':
      return SwalvoChatErrorCode.conversationArchived;
    case 'MESSAGE_NOT_FOUND':
      return SwalvoChatErrorCode.messageNotFound;
    case 'MESSAGE_DELETED':
      return SwalvoChatErrorCode.messageDeleted;
    case 'MESSAGE_TOO_LARGE':
      return SwalvoChatErrorCode.messageTooLarge;
    case 'INVALID_MESSAGE':
    case 'INVALID_MESSAGE_TYPE':
      return SwalvoChatErrorCode.invalidMessage;
    case 'INVALID_CURSOR':
      return SwalvoChatErrorCode.invalidCursor;
    case 'RATE_LIMITED':
      return SwalvoChatErrorCode.rateLimited;
    case 'MUTED':
      return SwalvoChatErrorCode.muted;
    case 'BANNED':
      return SwalvoChatErrorCode.banned;
    case 'BLOCKED':
      return SwalvoChatErrorCode.blocked;
    case 'SLOW_MODE':
      return SwalvoChatErrorCode.slowMode;
    case 'MESSAGE_BLOCKED':
      return SwalvoChatErrorCode.messageBlocked;
    case 'EVENTS_EXPIRED':
      return SwalvoChatErrorCode.eventsExpired;
    case 'MESSAGE_CANCELLED':
      return SwalvoChatErrorCode.messageCancelled;
    case 'ATTACHMENT_NOT_FOUND':
    case 'ATTACHMENTS_NOT_CONFIGURED':
    case 'ATTACHMENT_TOO_LARGE':
      return SwalvoChatErrorCode.attachmentNotFound;
    case 'CONNECTION_FAILED':
      return SwalvoChatErrorCode.connectionFailed;
    case 'CONNECTION_CLOSED':
      return SwalvoChatErrorCode.connectionClosed;
    case 'NETWORK_ERROR':
      return SwalvoChatErrorCode.networkError;
    case 'TIMEOUT':
      return SwalvoChatErrorCode.timeout;
    case 'INTERNAL_ERROR':
      return SwalvoChatErrorCode.internalError;
    default:
      return SwalvoChatErrorCode.unknown;
  }
}

/// Failures a retry can fix by itself: the connection, not the request,
/// was the problem. These are the ones the outbox keeps a send queued for;
/// any other code means the server looked at the message and said no.
///
/// `internalError` is deliberately not here: replaying the same frame at a
/// server bug on every reconnect turns one bad deploy into a retry storm.
bool isConnectivityError(Object error) =>
    error is SwalvoChatException &&
    (error.code == SwalvoChatErrorCode.connectionClosed ||
        error.code == SwalvoChatErrorCode.connectionFailed ||
        error.code == SwalvoChatErrorCode.networkError ||
        error.code == SwalvoChatErrorCode.timeout);
