export { SwalvoRoom } from './swalvo-room';
export type { SwalvoRoomProps } from './swalvo-room';

export {
  useActiveSpeakers,
  useCamera,
  useConnectionQuality,
  useConnectionState,
  useE2EEState,
  useIsSpeaking,
  useLocalParticipant,
  useMicrophone,
  useParticipants,
  useSwalvo,
  useSwalvoClient,
  useSwalvoError,
  useRemoteParticipants,
  useRoom,
  useTrackSubscriptionState,
  useTranscription,
  useAgentState,
} from './hooks';
export type { TrackSubscriptionInfo, UseSwalvoResult, UseTranscriptionOptions, UseTranscriptionResult } from './hooks';

export { LocalParticipantView, ParticipantView, SwalvoAudio, SwalvoVideo } from './components';
export type { ParticipantViewProps, SwalvoAudioProps, SwalvoVideoProps } from './components';

export type { SwalvoConnectionState, SwalvoSnapshot } from './store';

// ---------------------------------------------------------------------------
// Video UI kit: prebuilt call components (<VideoConference>, <PreJoin>,
// <ParticipantTile>, layouts, controls) and the hooks they are built from.
// Unstyled by default, with `swalvo-*` classes and data attributes; the
// optional stylesheet is `@swalvo/react/video/styles.css`. Every export
// is side-effect free, so an app that imports only hooks bundles none of
// the components.
//
// There is deliberately no separate `@swalvo/react/video` JS entry: these
// components read the same React context as <SwalvoRoom>, and a second CJS
// bundle would carry a second copy of that context.
// ---------------------------------------------------------------------------
export { VideoConference } from './video/video-conference';
export type { VideoConferenceProps } from './video/video-conference';
export { GridLayout, FocusLayout } from './video/layouts';
export type { GridLayoutProps, FocusLayoutProps } from './video/layouts';
export { ParticipantTile } from './video/participant-tile';
export type { ParticipantTileProps } from './video/participant-tile';
export { ConnectionQualityIndicator, CONNECTION_QUALITY_LABELS } from './video/connection-quality-indicator';
export type { ConnectionQualityIndicatorProps } from './video/connection-quality-indicator';
export { ControlBar, TrackToggle, DisconnectButton, ChatToggle } from './video/controls';
export type {
  ControlBarControls,
  ControlBarProps,
  TrackToggleProps,
  DisconnectButtonProps,
  ChatToggleProps,
} from './video/controls';
export { Captions, CaptionsToggle, AgentVisualizer } from './video/captions';
export type { CaptionsProps, CaptionsToggleProps, AgentVisualizerProps } from './video/captions';
export { MediaDeviceMenu } from './video/media-device-menu';
export type { MediaDeviceMenuProps } from './video/media-device-menu';
export { PreJoin } from './video/pre-join';
export type { PreJoinProps } from './video/pre-join';
export { RoomAudioRenderer, StartAudio } from './video/audio';
export type { RoomAudioRendererProps, StartAudioProps } from './video/audio';
export { Toast, ConnectionStateToast, DISCONNECT_REASON_MESSAGES } from './video/toast';
export type { ToastProps, ConnectionStateToastProps } from './video/toast';
export { LayoutContextProvider, useLayoutContext, usePinnedTracks, useChatToggle } from './video/layout-context';
export type { LayoutContextProviderProps, LayoutContextValue } from './video/layout-context';

export {
  useTracks,
  useIsMuted,
  useParticipantTrack,
  useRoomConnectionState,
  useMediaDevices,
  useMediaDeviceSelect,
  useTrackToggle,
  useScreenShare,
  useDisconnectButton,
  useAudioPlayback,
  useAudioLevel,
  usePagination,
  useGridLayout,
  gridColumns,
  supportsAudioOutputSelection,
  supportsScreenShare,
} from './video/video-hooks';
export type {
  GridLayoutInfo,
  RoomConnectionInfo,
  ToggleSource,
  UseDisconnectButtonResult,
  UseMediaDeviceSelectOptions,
  UseMediaDeviceSelectResult,
  UsePaginationResult,
  UseScreenShareResult,
  UseTrackToggleOptions,
  UseTrackToggleResult,
  UseTracksOptions,
} from './video/video-hooks';

export { participantDisplayName, trackReferenceKey, isSameTrackReference } from './video/types';
export type { LocalUserChoices, TrackReference, TrackSource, TrackSourceWithOptions } from './video/types';

// Re-exported for convenience, so anyone building on @swalvo/react
// doesn't need a direct @swalvo/rtc import just to name a common type.
//
// No media-plane type is ever re-exported (Phase 11 spec §27). Everything
// here is Swalvo's own vocabulary, which is exactly what let the SFU
// underneath get replaced without touching this file.
export type {
  ConnectionQuality,
  ConnectionState,
  DeviceInfo,
  E2EEOptions,
  E2EEState,
  KeyProviderOptions,
  VideoCodec,
  ForwardedLayer,
  TrackSubscriptionState,
  DeviceKind,
  LocalParticipant,
  LocalTrack,
  MediaKind,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RTCClientConfig,
  RTCError,
  RTCErrorCode,
  Track,
  TrackKind,
  DisconnectReason,
  ConnectionTestOptions,
  ConnectionTestReport,
  ConnectionTestStage,
  AgentState,
  CaptionSnapshot,
  TranscriptionSegment,
  TranscriptionState,
  TranscriptionStatus,
} from '@swalvo/rtc';
export { isRTCError, trackKindToMediaKind } from '@swalvo/rtc';
// The framework-free caption reducer the hooks are built on, for a custom UI.
export { CaptionStore } from '@swalvo/rtc';
// End-to-end encryption: pass `e2ee={{ keyProvider }}` to <SwalvoRoom>.
// Re-exported so the worker stays tree-shaken unless one of these is called.
export { createKeyProvider, createSharedKeyProvider, isE2EESupported } from '@swalvo/rtc';
export type { KeyProvider } from '@swalvo/rtc';

// ---------------------------------------------------------------------------
// Chat (Phase 12), the @swalvo/chat integration.
//
// Its own provider and its own hooks, but sharing this package's existing
// store/snapshot pattern instead of inventing a second one (spec §43).
// RTC and Chat stay independent: use either alone, or mount both together
// for a call with a chat panel.
// ---------------------------------------------------------------------------
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

// Re-exported for convenience, same as the RTC types above, so a chat UI
// doesn't need a direct @swalvo/chat import for common types.
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

// ---------------------------------------------------------------------------
// Live Streaming (Phase 14), the @swalvo/live integration.
//
// A stream's room and chat are an ordinary Room and ChatClient, so
// useParticipants, useCamera and useMicrophone from above, plus
// useMessages, useReactions, useTyping and the rest of the chat hooks, all
// already work inside <SwalvoLiveStream>. src/live/live-hooks.ts explains
// why there's no separate useLiveStreamParticipants() or
// useLiveStreamChat().
// ---------------------------------------------------------------------------
export { SwalvoLiveStream } from './live/swalvo-live-stream';
export type { SwalvoLiveStreamProps } from './live/swalvo-live-stream';

export {
  useLiveStream,
  useLiveStreamClient,
  useLiveStreamHost,
  useLiveStreamRole,
  useLiveStreamViewer,
} from './live/live-hooks';
export type { UseLiveStreamHostResult, UseLiveStreamResult } from './live/live-hooks';

export type { SwalvoLiveStreamContextValue, SwalvoLiveStreamStatus } from './live/live-context';

// Re-exported for convenience, same as the RTC and Chat types above, so a
// live-streaming UI doesn't need a direct @swalvo/live import for
// common types. @swalvo/live's own discipline carries over unchanged:
// nothing transport- or media-plane-specific ever reaches this surface.
export type { LiveStream, LiveStreamCredentials, LiveStreamRole } from '@swalvo/live';

// Deprecated Raven* aliases (renamed to Swalvo*).
export * from './legacy-aliases';
