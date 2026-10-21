/** Message kinds Swalvo understands today. New ones widen this; they don't break it. */
export type ChatMessageType = 'text' | 'system' | 'event' | 'attachment';

export interface ChatAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
  status: 'pending' | 'uploaded' | 'expired';
}

/**
 * What the server unfurled from the first http(s) URL in a message (§5).
 *
 * Arrives after the message itself: the unfurl is asynchronous, so a
 * message is first delivered without one and then re-delivered through
 * `messageUpdated` with `reason: "link_preview"`.
 */
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
}

export interface ChatReaction {
  emoji: string;
  count: number;
  userIds: string[];
}

/**
 * A message, exactly as the server stored it.
 *
 * `id` and `createdAt` are always the server's. The SDK never invents
 * either, and that's what keeps ordering consistent across every client in
 * a room.
 */
export interface ChatMessage {
  /** Swalvo's canonical `msg_...` id. */
  id: string;
  /**
   * Opaque resume point. Pass it as `after` to `messages.list()` to fetch
   * everything that came after this message.
   *
   * You rarely need it: the SDK recovers missed messages by itself on
   * reconnect and this is what it uses. It is here for apps that persist
   * their own read position across page loads and want to resume from it.
   *
   * Treat it as opaque — it is a value pair, not an id, and the encoding is
   * ours to change.
   */
  cursor: string;
  /**
   * The message's position in its conversation: strictly increasing, with
   * no gaps among created messages. A decimal **string**, because it is a
   * 64-bit counter and a JS number stops being exact long before that.
   * Compare with `compareSeq()`, never with `<` on the strings.
   *
   * Absent from servers older than Phase 3.
   */
  seq?: string;
  /** The conversation's public id, the same value you passed to `connect({ room })`. */
  roomId: string;
  conversationId: string;
  senderId: string;
  type: ChatMessageType;
  /** `null` for messages that carry no text, and for deleted ones. */
  text: string | null;
  /** `msg_...` id of the message this replies to. */
  replyTo: string | null;
  /** The thread this message belongs to. Same as the root message's id. */
  threadRootId: string | null;
  /** Whatever you passed as `clientMessageId`, echoed back. */
  clientMessageId: string | null;
  metadata: Record<string, unknown> | null;
  attachment: ChatAttachment | null;
  reactions: ChatReaction[];
  /** userIds mentioned in this message, as the sender passed them to `sendMessage({ mentions })`. */
  mentions?: string[];
  /**
   * `metadata.linkPreview`, lifted out so a renderer does not have to know
   * where the server keeps it. `null` until the unfurl lands, and for
   * messages with no link.
   */
  linkPreview?: LinkPreview | null;
  /** Thread roots only: how many replies the thread has. */
  replyCount?: number;
  /** Thread roots only: when the newest reply was sent. */
  lastReplyAt?: string | null;
  edited: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export type PresenceStatus = 'online' | 'away' | 'offline';

export interface PresenceEvent {
  userId: string;
  status: PresenceStatus;
  roomId: string;
  at: string;
}

export interface TypingEvent {
  userId: string;
  roomId: string;
  /** `true` for typing.started, `false` for typing.stopped. */
  isTyping: boolean;
}

export interface ReadReceiptEvent {
  userId: string;
  roomId: string;
  messageId: string | null;
  at: string;
}

export interface ReactionEvent {
  messageId: string;
  roomId: string;
  userId: string;
  emoji: string;
  at: string;
}

export interface MessageDeletedEvent {
  messageId: string;
  roomId: string;
  deletedAt: string;
  deletedBy: string | null;
}

/**
 * Connection states, using `@swalvo/rtc`'s vocabulary so anyone on both
 * doesn't have to learn two.
 *
 * `failed` is terminal: either reconnect attempts ran out, or the failure
 * is one retrying can't fix, like a revoked token. `disconnected` means the
 * connection ended and nothing is being retried.
 */
export type ChatConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export interface ReadState {
  roomId: string;
  userId: string;
  lastReadMessageId: string | null;
  lastReadAt: string;
  unreadCount: number;
}

export interface MessagePage {
  data: ChatMessage[];
  /** Pass as `before` to fetch the next, older page. `null` once history runs out. */
  nextCursor: string | null;
  /** Pass as `after` to walk forward toward newer messages. */
  previousCursor: string | null;
  hasMore: boolean;
}

export interface SendMessageOptions {
  text?: string;
  type?: ChatMessageType;
  /** `msg_...` id to reply to. The reply joins that message's thread. */
  replyTo?: string;
  /**
   * Your own idempotency key. Retry a send with the same key and you get
   * the original message back instead of a duplicate. Set it if you retry
   * sends yourself; the SDK sets one automatically for its own retries.
   */
  clientMessageId?: string;
  /** `att_...` id from `chat.attachments.upload()`, already uploaded. */
  attachmentId?: string;
  metadata?: Record<string, unknown>;
  /**
   * userIds this message mentions, at most 50. Mentioned users are pushed
   * even when their notification level is `mentions`, and counted in the
   * inbox's `unreadMentions`. The text is yours to format; the server
   * does not parse `@names` out of it.
   */
  mentions?: string[];
  /** Which room to send to. Defaults to the room passed to `connect()`. */
  room?: string;
}

export interface ListMessagesOptions {
  room?: string;
  limit?: number;
  before?: string;
  after?: string;
  /** Only messages with a `seq` greater than this. An alternative to `after` when you hold a seq, not a cursor. */
  afterSeq?: string;
  /** Only messages with a `seq` less than this. */
  beforeSeq?: string;
  threadRootId?: string;
  senderId?: string;
  includeDeleted?: boolean;
}

/** What the server confirmed once a message was durably stored. */
export interface SendMessageResult extends ChatMessage {
  /** `true` when an idempotency key matched an existing message, so nothing new got written. */
  deduplicated?: boolean;
}

// ---------------------------------------------------------------------------
// Phase 3 (docs/architecture/phase3-chat-contracts.md)
// ---------------------------------------------------------------------------

/** Why a `messageUpdated` fired. `link_preview` is the server's asynchronous unfurl landing (§5). */
export type MessageUpdateReason = 'edit' | 'link_preview' | (string & {});

export interface MessageUpdatedInfo {
  /** Absent from servers that predate it, which only ever sent edits. */
  reason?: MessageUpdateReason;
}

export type ConversationType = 'DIRECT' | 'CHANNEL' | 'ROOM';
export type MemberRole = 'MEMBER' | 'MODERATOR' | 'ADMIN' | (string & {});
/** Per-conversation push preference (§4.1). `muted: true` behaves as `none`. */
export type NotificationLevel = 'all' | 'mentions' | 'none';

/** The newest message in an inbox row: a summary, not the full message. */
export interface InboxLastMessage {
  id: string;
  seq: string | null;
  senderId: string;
  content: string | null;
  type: string;
  createdAt: string;
}

/** One conversation in this user's inbox (§2). */
export interface InboxConversation {
  id: string;
  name: string | null;
  type: ConversationType;
  metadata: Record<string, unknown>;
  role: MemberRole;
  muted: boolean;
  /** Absent from servers that do not report it; treat that as `all`. */
  notifications?: NotificationLevel;
  lastMessage: InboxLastMessage | null;
  unreadCount: number;
  /** Unread messages that mention this user (§5). 0 when the server does not report it. */
  unreadMentions: number;
  lastReadSeq: string | null;
  updatedAt: string;
}

export interface InboxPage {
  conversations: InboxConversation[];
  /** Pass back as `cursor` for the next page. `null` once there are no more. */
  nextCursor: string | null;
}

export interface QueryConversationsOptions {
  /** At most 100. */
  limit?: number;
  cursor?: string | null;
}

/** A moderator action broadcast to the conversation (§3.3). */
export interface MemberModerationEvent {
  roomId: string;
  userId: string;
  /** Who did it. */
  by: string | null;
  /** When a timed ban or mute lifts. `null` for permanent ones, and for unban/unmute. */
  expiresAt: string | null;
}

export interface ModerationActionOptions {
  /** Omit for a permanent action. */
  durationSeconds?: number;
  reason?: string;
}

export type FlagReason = 'spam' | 'harassment' | 'hate' | 'sexual' | 'violence' | 'other';

export interface ChatBlock {
  userId: string;
  createdAt: string | null;
}

/** This user lost access to a room without asking to leave it. */
export interface RoomRemovedEvent {
  roomId: string;
  /** `BANNED` when a moderator banned them (§3.2). Other values may be added; treat unknown ones as "removed". */
  reason: 'BANNED' | (string & {});
}

export interface MessagePinEvent {
  roomId: string;
  messageId: string;
  /** The full message, when the server includes it. */
  message: ChatMessage | null;
  by: string | null;
  at: string | null;
}

/** §6: in a large room, the server sends a count instead of one frame per arrival. */
export interface PresenceCountEvent {
  roomId: string;
  online: number;
}

export interface PresenceEntry {
  userId: string;
  status: PresenceStatus;
}

export interface PresencePage {
  data: PresenceEntry[];
  nextCursor: string | null;
}

export interface SearchMessagesOptions {
  room?: string;
  q: string;
  /** At most 50. */
  limit?: number;
  cursor?: string | null;
}

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ThreadOptions {
  /** At most 100. */
  limit?: number;
  cursor?: string | null;
}

export type PushProvider = 'apns' | 'fcm';
export type DevicePlatform = 'ios' | 'android' | 'web';

export interface RegisterDeviceOptions {
  provider: PushProvider;
  /** The APNs device token or FCM registration token. */
  token: string;
  platform: DevicePlatform;
  /** iOS bundle id / Android package name, when the project has more than one app. */
  appBundleId?: string;
}

export interface ChatDevice {
  provider: PushProvider;
  token: string;
  platform: DevicePlatform;
  appBundleId: string | null;
  lastSeenAt: string | null;
  createdAt: string | null;
}

export interface NotificationPreferences {
  roomId: string;
  notifications: NotificationLevel;
  muted: boolean;
}
