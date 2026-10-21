// Deprecated aliases for the pre-rename `raven_chat` public API.
//
// The package was published as `raven_chat` with `Raven*` type names. Code
// written against it compiles against `swalvo_chat` after changing the
// import, with deprecation warnings only. Every alias points at the same
// type, so `is` checks and pattern matches behave identically.

import 'chat_client.dart';
import 'errors.dart';
import 'inbox.dart';
import 'models.dart';
import 'outbox.dart';
import 'phase3_models.dart';

@Deprecated('Renamed to SwalvoAttachment. Will be removed in 1.0.')
typedef RavenAttachment = SwalvoAttachment;

@Deprecated('Renamed to SwalvoAttachmentUploadTicket. Will be removed in 1.0.')
typedef RavenAttachmentUploadTicket = SwalvoAttachmentUploadTicket;

@Deprecated('Renamed to SwalvoBlock. Will be removed in 1.0.')
typedef RavenBlock = SwalvoBlock;

@Deprecated('Renamed to SwalvoChat. Will be removed in 1.0.')
typedef RavenChat = SwalvoChat;

@Deprecated('Renamed to SwalvoChatConnectionState. Will be removed in 1.0.')
typedef RavenChatConnectionState = SwalvoChatConnectionState;

@Deprecated('Renamed to SwalvoChatErrorCode. Will be removed in 1.0.')
typedef RavenChatErrorCode = SwalvoChatErrorCode;

@Deprecated('Renamed to SwalvoChatException. Will be removed in 1.0.')
typedef RavenChatException = SwalvoChatException;

@Deprecated('Renamed to SwalvoCursorPage. Will be removed in 1.0.')
typedef RavenCursorPage<T> = SwalvoCursorPage<T>;

@Deprecated('Renamed to SwalvoDevice. Will be removed in 1.0.')
typedef RavenDevice = SwalvoDevice;

@Deprecated('Renamed to SwalvoDevicePlatform. Will be removed in 1.0.')
typedef RavenDevicePlatform = SwalvoDevicePlatform;

@Deprecated('Renamed to SwalvoFlagReason. Will be removed in 1.0.')
typedef RavenFlagReason = SwalvoFlagReason;

@Deprecated('Renamed to SwalvoInbox. Will be removed in 1.0.')
typedef RavenInbox = SwalvoInbox;

@Deprecated('Renamed to SwalvoInboxConversation. Will be removed in 1.0.')
typedef RavenInboxConversation = SwalvoInboxConversation;

@Deprecated('Renamed to SwalvoInboxLastMessage. Will be removed in 1.0.')
typedef RavenInboxLastMessage = SwalvoInboxLastMessage;

@Deprecated('Renamed to SwalvoInboxPage. Will be removed in 1.0.')
typedef RavenInboxPage = SwalvoInboxPage;

@Deprecated('Renamed to SwalvoLinkPreview. Will be removed in 1.0.')
typedef RavenLinkPreview = SwalvoLinkPreview;

@Deprecated('Renamed to SwalvoMemberModerationEvent. Will be removed in 1.0.')
typedef RavenMemberModerationEvent = SwalvoMemberModerationEvent;

@Deprecated('Renamed to SwalvoMemoryOutboxStorage. Will be removed in 1.0.')
typedef RavenMemoryOutboxStorage = SwalvoMemoryOutboxStorage;

@Deprecated('Renamed to SwalvoMessage. Will be removed in 1.0.')
typedef RavenMessage = SwalvoMessage;

@Deprecated('Renamed to SwalvoMessagePage. Will be removed in 1.0.')
typedef RavenMessagePage = SwalvoMessagePage;

@Deprecated('Renamed to SwalvoMessageType. Will be removed in 1.0.')
typedef RavenMessageType = SwalvoMessageType;

@Deprecated('Renamed to SwalvoMessageUpdate. Will be removed in 1.0.')
typedef RavenMessageUpdate = SwalvoMessageUpdate;

@Deprecated('Renamed to SwalvoModerationKind. Will be removed in 1.0.')
typedef RavenModerationKind = SwalvoModerationKind;

@Deprecated('Renamed to SwalvoModerationState. Will be removed in 1.0.')
typedef RavenModerationState = SwalvoModerationState;

@Deprecated('Renamed to SwalvoNotificationLevel. Will be removed in 1.0.')
typedef RavenNotificationLevel = SwalvoNotificationLevel;

@Deprecated('Renamed to SwalvoNotificationPreferences. Will be removed in 1.0.')
typedef RavenNotificationPreferences = SwalvoNotificationPreferences;

@Deprecated('Renamed to SwalvoOutbox. Will be removed in 1.0.')
typedef RavenOutbox = SwalvoOutbox;

@Deprecated('Renamed to SwalvoOutboxEntry. Will be removed in 1.0.')
typedef RavenOutboxEntry = SwalvoOutboxEntry;

@Deprecated('Renamed to SwalvoOutboxStatus. Will be removed in 1.0.')
typedef RavenOutboxStatus = SwalvoOutboxStatus;

@Deprecated('Renamed to SwalvoOutboxStorage. Will be removed in 1.0.')
typedef RavenOutboxStorage = SwalvoOutboxStorage;

@Deprecated('Renamed to SwalvoPinEvent. Will be removed in 1.0.')
typedef RavenPinEvent = SwalvoPinEvent;

@Deprecated('Renamed to SwalvoPresence. Will be removed in 1.0.')
typedef RavenPresence = SwalvoPresence;

@Deprecated('Renamed to SwalvoPresenceCount. Will be removed in 1.0.')
typedef RavenPresenceCount = SwalvoPresenceCount;

@Deprecated('Renamed to SwalvoPresencePage. Will be removed in 1.0.')
typedef RavenPresencePage = SwalvoPresencePage;

@Deprecated('Renamed to SwalvoPresenceStatus. Will be removed in 1.0.')
typedef RavenPresenceStatus = SwalvoPresenceStatus;

@Deprecated('Renamed to SwalvoPushProvider. Will be removed in 1.0.')
typedef RavenPushProvider = SwalvoPushProvider;

@Deprecated('Renamed to SwalvoReaction. Will be removed in 1.0.')
typedef RavenReaction = SwalvoReaction;

@Deprecated('Renamed to SwalvoReactionEvent. Will be removed in 1.0.')
typedef RavenReactionEvent = SwalvoReactionEvent;

@Deprecated('Renamed to SwalvoReadState. Will be removed in 1.0.')
typedef RavenReadState = SwalvoReadState;

@Deprecated('Renamed to SwalvoRecoverySummary. Will be removed in 1.0.')
typedef RavenRecoverySummary = SwalvoRecoverySummary;

@Deprecated('Renamed to SwalvoResyncEvent. Will be removed in 1.0.')
typedef RavenResyncEvent = SwalvoResyncEvent;

@Deprecated('Renamed to SwalvoRoomRecoveryResult. Will be removed in 1.0.')
typedef RavenRoomRecoveryResult = SwalvoRoomRecoveryResult;

@Deprecated('Renamed to SwalvoRoomRemovedEvent. Will be removed in 1.0.')
typedef RavenRoomRemovedEvent = SwalvoRoomRemovedEvent;

@Deprecated('Renamed to SwalvoTypingEvent. Will be removed in 1.0.')
typedef RavenTypingEvent = SwalvoTypingEvent;
