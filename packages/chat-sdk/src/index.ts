export { ChatClient, createChatClient } from './client';
export type { ChatEventMap, ConnectOptions, RecoverySummary } from './client';

export { MessagesApi } from './messages-api';
export { AttachmentsApi } from './attachments-api';
export type { AttachmentUploadTicket } from './attachments-api';
export { ModerationApi } from './moderation-api';
export type { MyModerationState } from './moderation-api';
export { Inbox } from './inbox';
export type { InboxLoadOptions, InboxSnapshot } from './inbox';
export { LocalStorageOutboxStorage, MemoryOutboxStorage, Outbox } from './outbox';
export type { OutboxEntry, OutboxStatus, OutboxStorage } from './outbox';
export { compareSeq } from './internal/seq';

export type { ChatClientConfig } from './config';

export type {
  ChatAttachment,
  ChatBlock,
  ChatConnectionState,
  ChatDevice,
  ChatMessage,
  ChatMessageType,
  ChatReaction,
  ConversationType,
  CursorPage,
  DevicePlatform,
  FlagReason,
  InboxConversation,
  InboxLastMessage,
  InboxPage,
  LinkPreview,
  ListMessagesOptions,
  MemberModerationEvent,
  MemberRole,
  MessageDeletedEvent,
  MessagePage,
  MessagePinEvent,
  MessageUpdatedInfo,
  MessageUpdateReason,
  ModerationActionOptions,
  NotificationLevel,
  NotificationPreferences,
  PresenceCountEvent,
  PresenceEntry,
  PresenceEvent,
  PresencePage,
  PresenceStatus,
  PushProvider,
  QueryConversationsOptions,
  ReactionEvent,
  ReadReceiptEvent,
  ReadState,
  RegisterDeviceOptions,
  RoomRemovedEvent,
  SearchMessagesOptions,
  SendMessageOptions,
  SendMessageResult,
  ThreadOptions,
  TypingEvent,
} from './types';

export {
  SwalvoAttachmentError,
  SwalvoChatAuthenticationError,
  SwalvoChatConnectionError,
  SwalvoChatError,
  SwalvoChatPermissionError,
  SwalvoMessageBlockedError,
  SwalvoMessageError,
  SwalvoModerationError,
  SwalvoRateLimitError,
  SwalvoRoomError,
  SwalvoSlowModeError,
  isSwalvoChatError,
} from './errors';
export {
  RavenAttachmentError,
  RavenChatAuthenticationError,
  RavenChatConnectionError,
  RavenChatError,
  RavenChatPermissionError,
  RavenMessageBlockedError,
  RavenMessageError,
  RavenModerationError,
  RavenRateLimitError,
  RavenRoomError,
  RavenSlowModeError,
  isRavenChatError,
} from './errors';
export type { ChatErrorCode } from './errors';

export type { RoomRecoveryResult } from './internal/recovery';
export type { Unsubscribe } from './events';
export type { LogLevel } from './logger';
export { CHAT_SDK_VERSION } from './version';

// Pointedly not exported: SocketTransport, RestClient, the frame
// vocabulary, every other internal. Nobody using @swalvo/chat should ever
// need to know a WebSocket is involved (spec §57).
