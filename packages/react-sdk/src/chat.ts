// Chat-only entry point (`@swalvo/react/chat`).
//
// `src/chat/*` depends on `react` and `@swalvo/chat` and nothing else. No
// coupling to RTC or live.
//
// This file exists so anyone who only wants Chat, a text-channel feature
// with no video or voice say, never needs `@swalvo/rtc`
// or `@swalvo/live` to be resolvable. That's what
// `package.json`'s `peerDependenciesMeta` already promises, and the single
// `index.ts` barrel breaks it: it re-exports from all three integrations
// unconditionally, so a bundler demands every peer be installed just to
// import anything from it.
//
// If that ever changes, keep this file's re-exports in sync with index.ts's
// Chat section.
export { SwalvoChat } from './chat/swalvo-chat';
export type { SwalvoChatProps } from './chat/swalvo-chat';

export {
  useChat,
  useChatClient,
  useChatConnectionState,
  useChatError,
  useMessages,
  usePresence,
  useReactions,
  useReadReceipts,
  useTyping,
} from './chat/chat-hooks';
export type {
  UseChatResult,
  UseMessagesResult,
  UseReactionsResult,
  UseReadReceiptsResult,
  UseTypingResult,
} from './chat/chat-hooks';

export type { SwalvoChatSnapshot } from './chat/chat-store';

// Phase 3: inbox, per-room conversations, moderation, and the headless UI kit.
export { useConversation, useInbox, useModeration, usePresenceCount, useUnreadCount } from './chat/conversation-hooks';
export type { UseConversationResult, UseInboxResult, UseModerationResult } from './chat/conversation-hooks';

export { ConversationStore } from './chat/conversation-store';
export type { ConversationMessage, ConversationSendInput, ConversationSnapshot } from './chat/conversation-store';

export { ChatProvider } from './chat/ui/chat-provider';
export type { ChatProviderClientProps, ChatProviderProps } from './chat/ui/chat-provider';
export { ChannelList } from './chat/ui/channel-list';
export type { ChannelListProps } from './chat/ui/channel-list';
export { MessageList } from './chat/ui/message-list';
export type { MessageListProps, MessageRenderState } from './chat/ui/message-list';
export { MessageComposer } from './chat/ui/message-composer';
export type { MentionCandidate, MessageComposerProps } from './chat/ui/message-composer';
export { Thread } from './chat/ui/thread';
export type { ThreadProps } from './chat/ui/thread';

export type {
  ChatAttachment,
  ChatClientConfig,
  ChatConnectionState,
  ChatMessage,
  ChatMessageType,
  ChatReaction,
  MessagePage,
  PresenceStatus,
  ReadState,
  SendMessageOptions,
  // Phase 3
  ChatBlock,
  FlagReason,
  InboxConversation,
  InboxSnapshot,
  LinkPreview,
  MemberModerationEvent,
  MyModerationState,
  NotificationLevel,
  OutboxEntry,
  OutboxStatus,
  OutboxStorage,
} from '@swalvo/chat';
export { isSwalvoChatError, SwalvoChatError } from '@swalvo/chat';

// Deprecated Raven* aliases (renamed to Swalvo*).
export * from './chat/legacy-aliases';
