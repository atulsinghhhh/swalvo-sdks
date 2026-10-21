/// Swalvo Chat for Flutter: real-time messaging.
///
/// ```dart
/// final chat = SwalvoChat(token: token, apiUrl: apiUrl);
/// await chat.connect('room_123');
///
/// chat.messages.listen((message) => print('${message.senderId}: ${message.text}'));
/// await chat.send('Hello everyone!');
/// ```
///
/// Talks to the same Swalvo Chat service as the web and React Native
/// SDKs, over the same protocol: there is no mobile-specific backend.
/// Durable history, presence, typing, reactions, read receipts and
/// threads all behave identically across platforms.
///
/// Independent of `swalvo_rtc`: a messaging app never pulls in a WebRTC
/// stack, and a video app never pulls in a message store. Use both
/// together for a call with a chat panel.
library;

// Deprecated `Raven*` names from the package's former name, raven_chat.
export 'src/legacy_aliases.dart';
export 'src/chat_client.dart' show SwalvoChat;
export 'src/errors.dart' show SwalvoChatErrorCode, SwalvoChatException;
export 'src/inbox.dart' show SwalvoInbox;
export 'src/outbox.dart'
    show
        SwalvoMemoryOutboxStorage,
        SwalvoOutbox,
        SwalvoOutboxEntry,
        SwalvoOutboxStatus,
        SwalvoOutboxStorage;
export 'src/phase3_models.dart'
    show
        SwalvoAttachmentUploadTicket,
        SwalvoBlock,
        SwalvoCursorPage,
        SwalvoDevice,
        SwalvoDevicePlatform,
        SwalvoFlagReason,
        SwalvoInboxConversation,
        SwalvoInboxLastMessage,
        SwalvoInboxPage,
        SwalvoMemberModerationEvent,
        SwalvoMessageUpdate,
        SwalvoModerationKind,
        SwalvoModerationState,
        SwalvoNotificationLevel,
        SwalvoNotificationPreferences,
        SwalvoPinEvent,
        SwalvoPresenceCount,
        SwalvoPresencePage,
        SwalvoPushProvider,
        SwalvoRecoverySummary,
        SwalvoResyncEvent,
        SwalvoRoomRecoveryResult,
        SwalvoRoomRemovedEvent;
export 'src/seq.dart' show compareSeq;
export 'src/models.dart'
    show
        SwalvoAttachment,
        SwalvoChatConnectionState,
        SwalvoLinkPreview,
        SwalvoMessage,
        SwalvoMessagePage,
        SwalvoMessageType,
        SwalvoPresence,
        SwalvoPresenceStatus,
        SwalvoReaction,
        SwalvoReactionEvent,
        SwalvoReadState,
        SwalvoTypingEvent;

// Deliberately not exported: the WebSocket channel, the REST client, the
// frame vocabulary, and the backoff policy. A developer using Swalvo Chat
// should never need to know a WebSocket is involved.
