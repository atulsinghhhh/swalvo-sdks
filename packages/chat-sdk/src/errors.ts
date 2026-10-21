/**
 * Every error `@swalvo/chat` raises is one of these. Nobody using it ever
 * sees a raw `CloseEvent`, a Postgres constraint name or a Redis timeout.
 * That's the infrastructure Swalvo is supposed to be hiding (Phase 12
 * spec §42).
 */
export type ChatErrorCode =
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'UNAUTHORIZED'
  | 'PERMISSION_DENIED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'ROOM_NOT_FOUND'
  | 'NOT_IN_ROOM'
  | 'NOT_A_MEMBER'
  | 'TOO_MANY_SUBSCRIPTIONS'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_DELETED'
  | 'INVALID_MESSAGE'
  | 'INVALID_MESSAGE_TYPE'
  | 'MESSAGE_TOO_LARGE'
  | 'INVALID_CURSOR'
  | 'RATE_LIMITED'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENTS_NOT_CONFIGURED'
  | 'ATTACHMENT_TOO_LARGE'
  | 'CONVERSATION_ARCHIVED'
  // Phase 3 moderation and catch-up codes (docs/architecture/phase3-chat-contracts.md §8).
  | 'MUTED'
  | 'BANNED'
  | 'BLOCKED'
  | 'SLOW_MODE'
  | 'MESSAGE_BLOCKED'
  | 'EVENTS_EXPIRED'
  /** Client-side only: a queued send was cancelled with `outbox.cancel()` before it went out. */
  | 'MESSAGE_CANCELLED'
  | 'CONNECTION_FAILED'
  | 'CONNECTION_CLOSED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INTERNAL_ERROR';

/** Base class for every Swalvo Chat error. Catch this to catch them all. */
export class SwalvoChatError extends Error {
  readonly code: ChatErrorCode;
  readonly cause?: unknown;
  /**
   * Set on a `sendMessage()` rejection when the message did not fail for
   * good: it is still in the outbox and will be re-sent, with the same
   * idempotency key, the next time the connection comes up. A UI that
   * shows an error on every rejection should check this first — the
   * message is pending, not lost.
   */
  queued?: boolean;
  /** The idempotency key of the send this error belongs to, when it came from `sendMessage()`. */
  clientMessageId?: string;

  constructor(code: ChatErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'SwalvoChatError';
    this.code = code;
    this.cause = cause;
  }
}

/** The socket could not be opened, was lost, or gave up reconnecting. */
export class SwalvoChatConnectionError extends SwalvoChatError {
  constructor(message: string, code: ChatErrorCode = 'CONNECTION_FAILED', cause?: unknown) {
    super(code, message, cause);
    this.name = 'SwalvoChatConnectionError';
  }
}

/** The chat token is missing, malformed, expired or revoked. Mint a new one. */
export class SwalvoChatAuthenticationError extends SwalvoChatError {
  constructor(message: string, code: ChatErrorCode = 'INVALID_TOKEN', cause?: unknown) {
    super(code, message, cause);
    this.name = 'SwalvoChatAuthenticationError';
  }
}

/** Authenticated, but not allowed to do this. Wrong scope, or not a member. */
export class SwalvoChatPermissionError extends SwalvoChatError {
  constructor(message: string, code: ChatErrorCode = 'PERMISSION_DENIED', cause?: unknown) {
    super(code, message, cause);
    this.name = 'SwalvoChatPermissionError';
  }
}

/** A message operation failed: too large, not found, already deleted. */
export class SwalvoMessageError extends SwalvoChatError {
  constructor(message: string, code: ChatErrorCode = 'INVALID_MESSAGE', cause?: unknown) {
    super(code, message, cause);
    this.name = 'SwalvoMessageError';
  }
}

/** Slow down. `retryAfterSeconds` is how long, when the server told us. */
export class SwalvoRateLimitError extends SwalvoChatError {
  readonly retryAfterSeconds?: number;
  /**
   * Which limit tripped, when the server says. `"conversation"` is the
   * per-conversation send cap (§6) — everybody in the room is being held
   * back, not just this user — as opposed to this user's own rate.
   */
  readonly scope?: string;

  constructor(message: string, retryAfterSeconds?: number, scope?: string) {
    super('RATE_LIMITED', message);
    this.name = 'SwalvoRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.scope = scope;
  }
}

/**
 * A moderation rule refused this. `MUTED`: a moderator muted this user in
 * the conversation (they can still read). `BANNED`: banned from it, or
 * app-wide. `BLOCKED`: a DIRECT conversation where one side has blocked
 * the other.
 *
 * Retrying will not help until a moderator (or the other user) changes
 * their mind, which is why the outbox marks these sends `failed` rather
 * than queueing them.
 */
export class SwalvoModerationError extends SwalvoChatError {
  constructor(message: string, code: 'MUTED' | 'BANNED' | 'BLOCKED' = 'MUTED', cause?: unknown) {
    super(code, message, cause);
    this.name = 'SwalvoModerationError';
  }
}

/**
 * The conversation is in slow mode and this user sent too recently.
 *
 * Separate from `SwalvoRateLimitError` on purpose: a rate limit is the
 * platform protecting itself, slow mode is a moderator's choice the UI
 * usually shows as a countdown on the send button.
 */
export class SwalvoSlowModeError extends SwalvoChatError {
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super('SLOW_MODE', message);
    this.name = 'SwalvoSlowModeError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The project's pre-send moderation hook (or the built-in profanity
 * filter) refused the message. `reason` is whatever the hook said, or
 * `"moderation_unavailable"` when the hook could not be reached and the
 * project is configured to fail closed.
 */
export class SwalvoMessageBlockedError extends SwalvoChatError {
  readonly reason?: string;

  constructor(message: string, reason?: string) {
    super('MESSAGE_BLOCKED', message);
    this.name = 'SwalvoMessageBlockedError';
    this.reason = reason;
  }
}

/** The room/conversation doesn't exist, or this connection isn't in it. */
export class SwalvoRoomError extends SwalvoChatError {
  constructor(message: string, code: ChatErrorCode = 'ROOM_NOT_FOUND', cause?: unknown) {
    super(code, message, cause);
    this.name = 'SwalvoRoomError';
  }
}

/** An attachment upload, download, or reference failed. */
export class SwalvoAttachmentError extends SwalvoChatError {
  constructor(message: string, code: ChatErrorCode = 'ATTACHMENT_NOT_FOUND', cause?: unknown) {
    super(code, message, cause);
    this.name = 'SwalvoAttachmentError';
  }
}

export function isSwalvoChatError(value: unknown): value is SwalvoChatError {
  return value instanceof SwalvoChatError;
}

/**
 * Turns a server error code into the most specific class we have.
 *
 * One mapping, shared by the WebSocket and REST paths, so
 * `catch (e) { if (e instanceof SwalvoRateLimitError) ... }` behaves the same
 * no matter how the call was made.
 */
export function toSwalvoChatError(
  code: string | undefined,
  message: string,
  extra: { retryAfterSeconds?: number; reason?: string; scope?: string } = {},
): SwalvoChatError {
  const chatCode = (code ?? 'INTERNAL_ERROR') as ChatErrorCode;

  switch (chatCode) {
    case 'INVALID_TOKEN':
    case 'TOKEN_EXPIRED':
    case 'TOKEN_REVOKED':
    case 'UNAUTHORIZED':
      return new SwalvoChatAuthenticationError(message, chatCode);

    case 'PERMISSION_DENIED':
    case 'NOT_A_MEMBER':
    case 'ORIGIN_NOT_ALLOWED':
      return new SwalvoChatPermissionError(message, chatCode);

    case 'ROOM_NOT_FOUND':
    case 'NOT_IN_ROOM':
    case 'TOO_MANY_SUBSCRIPTIONS':
    case 'CONVERSATION_ARCHIVED':
      return new SwalvoRoomError(message, chatCode);

    case 'RATE_LIMITED':
      return new SwalvoRateLimitError(message, extra.retryAfterSeconds, extra.scope);

    case 'MUTED':
    case 'BANNED':
    case 'BLOCKED':
      return new SwalvoModerationError(message, chatCode);

    case 'SLOW_MODE':
      return new SwalvoSlowModeError(message, extra.retryAfterSeconds);

    case 'MESSAGE_BLOCKED':
      return new SwalvoMessageBlockedError(message, extra.reason);

    case 'ATTACHMENT_NOT_FOUND':
    case 'ATTACHMENTS_NOT_CONFIGURED':
    case 'ATTACHMENT_TOO_LARGE':
      return new SwalvoAttachmentError(message, chatCode);

    case 'MESSAGE_NOT_FOUND':
    case 'MESSAGE_DELETED':
    case 'MESSAGE_TOO_LARGE':
    case 'INVALID_MESSAGE':
    case 'INVALID_MESSAGE_TYPE':
    case 'INVALID_CURSOR':
    case 'MESSAGE_CANCELLED':
    case 'EVENTS_EXPIRED':
      return new SwalvoMessageError(message, chatCode);

    case 'CONNECTION_FAILED':
    case 'CONNECTION_CLOSED':
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
      return new SwalvoChatConnectionError(message, chatCode);

    default:
      return new SwalvoChatError(chatCode, message);
  }
}

/**
 * Errors a retry can fix by itself: the connection, not the request, was
 * the problem. These are the ones the outbox keeps a send queued for; any
 * other code means the server looked at the message and said no.
 *
 * `INTERNAL_ERROR` is deliberately not here. It is a server bug, and
 * replaying the same frame at it on every reconnect is how a client turns
 * one bad deploy into a retry storm.
 */
export function isConnectivityError(error: unknown): boolean {
  if (!(error instanceof SwalvoChatError)) return false;
  return (
    error.code === 'CONNECTION_CLOSED' ||
    error.code === 'CONNECTION_FAILED' ||
    error.code === 'NETWORK_ERROR' ||
    error.code === 'TIMEOUT'
  );
}

// --- Deprecated Raven* aliases (renamed to Swalvo*). Same classes, so `instanceof` keeps working. ---
/** @deprecated Renamed to {@link SwalvoChatError}. */
export const RavenChatError = SwalvoChatError;
/** @deprecated Renamed to {@link SwalvoChatError}. */
export type RavenChatError = SwalvoChatError;
/** @deprecated Renamed to {@link SwalvoChatConnectionError}. */
export const RavenChatConnectionError = SwalvoChatConnectionError;
/** @deprecated Renamed to {@link SwalvoChatConnectionError}. */
export type RavenChatConnectionError = SwalvoChatConnectionError;
/** @deprecated Renamed to {@link SwalvoChatAuthenticationError}. */
export const RavenChatAuthenticationError = SwalvoChatAuthenticationError;
/** @deprecated Renamed to {@link SwalvoChatAuthenticationError}. */
export type RavenChatAuthenticationError = SwalvoChatAuthenticationError;
/** @deprecated Renamed to {@link SwalvoChatPermissionError}. */
export const RavenChatPermissionError = SwalvoChatPermissionError;
/** @deprecated Renamed to {@link SwalvoChatPermissionError}. */
export type RavenChatPermissionError = SwalvoChatPermissionError;
/** @deprecated Renamed to {@link SwalvoMessageError}. */
export const RavenMessageError = SwalvoMessageError;
/** @deprecated Renamed to {@link SwalvoMessageError}. */
export type RavenMessageError = SwalvoMessageError;
/** @deprecated Renamed to {@link SwalvoRateLimitError}. */
export const RavenRateLimitError = SwalvoRateLimitError;
/** @deprecated Renamed to {@link SwalvoRateLimitError}. */
export type RavenRateLimitError = SwalvoRateLimitError;
/** @deprecated Renamed to {@link SwalvoModerationError}. */
export const RavenModerationError = SwalvoModerationError;
/** @deprecated Renamed to {@link SwalvoModerationError}. */
export type RavenModerationError = SwalvoModerationError;
/** @deprecated Renamed to {@link SwalvoSlowModeError}. */
export const RavenSlowModeError = SwalvoSlowModeError;
/** @deprecated Renamed to {@link SwalvoSlowModeError}. */
export type RavenSlowModeError = SwalvoSlowModeError;
/** @deprecated Renamed to {@link SwalvoMessageBlockedError}. */
export const RavenMessageBlockedError = SwalvoMessageBlockedError;
/** @deprecated Renamed to {@link SwalvoMessageBlockedError}. */
export type RavenMessageBlockedError = SwalvoMessageBlockedError;
/** @deprecated Renamed to {@link SwalvoRoomError}. */
export const RavenRoomError = SwalvoRoomError;
/** @deprecated Renamed to {@link SwalvoRoomError}. */
export type RavenRoomError = SwalvoRoomError;
/** @deprecated Renamed to {@link SwalvoAttachmentError}. */
export const RavenAttachmentError = SwalvoAttachmentError;
/** @deprecated Renamed to {@link SwalvoAttachmentError}. */
export type RavenAttachmentError = SwalvoAttachmentError;
/** @deprecated Renamed to {@link isSwalvoChatError}. */
export const isRavenChatError = isSwalvoChatError;
/** @deprecated Renamed to {@link toSwalvoChatError}. */
export const toRavenChatError = toSwalvoChatError;
