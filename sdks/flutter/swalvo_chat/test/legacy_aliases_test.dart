// ignore_for_file: deprecated_member_use, deprecated_member_use_from_same_package
import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_chat/swalvo_chat.dart';

/// The pre-rename `Raven*` names (raven_chat) must stay usable, and must be
/// the very same types, until they are removed in 1.0.
void main() {
  test('every deprecated Raven* alias is the same type as its Swalvo* name',
      () {
    expect(
        identical(RavenAttachment, SwalvoAttachment) ||
            RavenAttachment == SwalvoAttachment,
        isTrue);
    expect(
        identical(RavenAttachmentUploadTicket, SwalvoAttachmentUploadTicket) ||
            RavenAttachmentUploadTicket == SwalvoAttachmentUploadTicket,
        isTrue);
    expect(identical(RavenBlock, SwalvoBlock) || RavenBlock == SwalvoBlock,
        isTrue);
    expect(identical(RavenChat, SwalvoChat) || RavenChat == SwalvoChat, isTrue);
    expect(
        identical(RavenChatConnectionState, SwalvoChatConnectionState) ||
            RavenChatConnectionState == SwalvoChatConnectionState,
        isTrue);
    expect(
        identical(RavenChatErrorCode, SwalvoChatErrorCode) ||
            RavenChatErrorCode == SwalvoChatErrorCode,
        isTrue);
    expect(
        identical(RavenChatException, SwalvoChatException) ||
            RavenChatException == SwalvoChatException,
        isTrue);
    expect(identical(RavenDevice, SwalvoDevice) || RavenDevice == SwalvoDevice,
        isTrue);
    expect(
        identical(RavenDevicePlatform, SwalvoDevicePlatform) ||
            RavenDevicePlatform == SwalvoDevicePlatform,
        isTrue);
    expect(
        identical(RavenFlagReason, SwalvoFlagReason) ||
            RavenFlagReason == SwalvoFlagReason,
        isTrue);
    expect(identical(RavenInbox, SwalvoInbox) || RavenInbox == SwalvoInbox,
        isTrue);
    expect(
        identical(RavenInboxConversation, SwalvoInboxConversation) ||
            RavenInboxConversation == SwalvoInboxConversation,
        isTrue);
    expect(
        identical(RavenInboxLastMessage, SwalvoInboxLastMessage) ||
            RavenInboxLastMessage == SwalvoInboxLastMessage,
        isTrue);
    expect(
        identical(RavenInboxPage, SwalvoInboxPage) ||
            RavenInboxPage == SwalvoInboxPage,
        isTrue);
    expect(
        identical(RavenLinkPreview, SwalvoLinkPreview) ||
            RavenLinkPreview == SwalvoLinkPreview,
        isTrue);
    expect(
        identical(RavenMemberModerationEvent, SwalvoMemberModerationEvent) ||
            RavenMemberModerationEvent == SwalvoMemberModerationEvent,
        isTrue);
    expect(
        identical(RavenMemoryOutboxStorage, SwalvoMemoryOutboxStorage) ||
            RavenMemoryOutboxStorage == SwalvoMemoryOutboxStorage,
        isTrue);
    expect(
        identical(RavenMessage, SwalvoMessage) || RavenMessage == SwalvoMessage,
        isTrue);
    expect(
        identical(RavenMessagePage, SwalvoMessagePage) ||
            RavenMessagePage == SwalvoMessagePage,
        isTrue);
    expect(
        identical(RavenMessageType, SwalvoMessageType) ||
            RavenMessageType == SwalvoMessageType,
        isTrue);
    expect(
        identical(RavenMessageUpdate, SwalvoMessageUpdate) ||
            RavenMessageUpdate == SwalvoMessageUpdate,
        isTrue);
    expect(
        identical(RavenModerationKind, SwalvoModerationKind) ||
            RavenModerationKind == SwalvoModerationKind,
        isTrue);
    expect(
        identical(RavenModerationState, SwalvoModerationState) ||
            RavenModerationState == SwalvoModerationState,
        isTrue);
    expect(
        identical(RavenNotificationLevel, SwalvoNotificationLevel) ||
            RavenNotificationLevel == SwalvoNotificationLevel,
        isTrue);
    expect(
        identical(
                RavenNotificationPreferences, SwalvoNotificationPreferences) ||
            RavenNotificationPreferences == SwalvoNotificationPreferences,
        isTrue);
    expect(identical(RavenOutbox, SwalvoOutbox) || RavenOutbox == SwalvoOutbox,
        isTrue);
    expect(
        identical(RavenOutboxEntry, SwalvoOutboxEntry) ||
            RavenOutboxEntry == SwalvoOutboxEntry,
        isTrue);
    expect(
        identical(RavenOutboxStatus, SwalvoOutboxStatus) ||
            RavenOutboxStatus == SwalvoOutboxStatus,
        isTrue);
    expect(
        identical(RavenOutboxStorage, SwalvoOutboxStorage) ||
            RavenOutboxStorage == SwalvoOutboxStorage,
        isTrue);
    expect(
        identical(RavenPinEvent, SwalvoPinEvent) ||
            RavenPinEvent == SwalvoPinEvent,
        isTrue);
    expect(
        identical(RavenPresence, SwalvoPresence) ||
            RavenPresence == SwalvoPresence,
        isTrue);
    expect(
        identical(RavenPresenceCount, SwalvoPresenceCount) ||
            RavenPresenceCount == SwalvoPresenceCount,
        isTrue);
    expect(
        identical(RavenPresencePage, SwalvoPresencePage) ||
            RavenPresencePage == SwalvoPresencePage,
        isTrue);
    expect(
        identical(RavenPresenceStatus, SwalvoPresenceStatus) ||
            RavenPresenceStatus == SwalvoPresenceStatus,
        isTrue);
    expect(
        identical(RavenPushProvider, SwalvoPushProvider) ||
            RavenPushProvider == SwalvoPushProvider,
        isTrue);
    expect(
        identical(RavenReaction, SwalvoReaction) ||
            RavenReaction == SwalvoReaction,
        isTrue);
    expect(
        identical(RavenReactionEvent, SwalvoReactionEvent) ||
            RavenReactionEvent == SwalvoReactionEvent,
        isTrue);
    expect(
        identical(RavenReadState, SwalvoReadState) ||
            RavenReadState == SwalvoReadState,
        isTrue);
    expect(
        identical(RavenRecoverySummary, SwalvoRecoverySummary) ||
            RavenRecoverySummary == SwalvoRecoverySummary,
        isTrue);
    expect(
        identical(RavenResyncEvent, SwalvoResyncEvent) ||
            RavenResyncEvent == SwalvoResyncEvent,
        isTrue);
    expect(
        identical(RavenRoomRecoveryResult, SwalvoRoomRecoveryResult) ||
            RavenRoomRecoveryResult == SwalvoRoomRecoveryResult,
        isTrue);
    expect(
        identical(RavenRoomRemovedEvent, SwalvoRoomRemovedEvent) ||
            RavenRoomRemovedEvent == SwalvoRoomRemovedEvent,
        isTrue);
    expect(
        identical(RavenTypingEvent, SwalvoTypingEvent) ||
            RavenTypingEvent == SwalvoTypingEvent,
        isTrue);
  });
}
