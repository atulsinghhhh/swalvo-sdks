// ignore_for_file: deprecated_member_use, deprecated_member_use_from_same_package
import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/swalvo_rtc.dart';

/// The pre-rename `Raven*` names (raven_rtc) must stay usable, and must be
/// the very same types, until they are removed in 1.0.
void main() {
  test('every deprecated Raven* alias is the same type as its Swalvo* name',
      () {
    expect(
        identical(RavenAgentState, SwalvoAgentState) ||
            RavenAgentState == SwalvoAgentState,
        isTrue);
    expect(
        identical(RavenAgentStateChanged, SwalvoAgentStateChanged) ||
            RavenAgentStateChanged == SwalvoAgentStateChanged,
        isTrue);
    expect(
        identical(RavenConnectionQuality, SwalvoConnectionQuality) ||
            RavenConnectionQuality == SwalvoConnectionQuality,
        isTrue);
    expect(
        identical(
                RavenConnectionQualityUpdate, SwalvoConnectionQualityUpdate) ||
            RavenConnectionQualityUpdate == SwalvoConnectionQualityUpdate,
        isTrue);
    expect(
        identical(RavenConnectionState, SwalvoConnectionState) ||
            RavenConnectionState == SwalvoConnectionState,
        isTrue);
    expect(
        identical(RavenDataChannelKind, SwalvoDataChannelKind) ||
            RavenDataChannelKind == SwalvoDataChannelKind,
        isTrue);
    expect(
        identical(RavenDataMessage, SwalvoDataMessage) ||
            RavenDataMessage == SwalvoDataMessage,
        isTrue);
    expect(
        identical(RavenDataThrottled, SwalvoDataThrottled) ||
            RavenDataThrottled == SwalvoDataThrottled,
        isTrue);
    expect(
        identical(RavenDisconnectReason, SwalvoDisconnectReason) ||
            RavenDisconnectReason == SwalvoDisconnectReason,
        isTrue);
    expect(
        identical(RavenE2EEOptions, SwalvoE2EEOptions) ||
            RavenE2EEOptions == SwalvoE2EEOptions,
        isTrue);
    expect(
        identical(RavenE2EEState, SwalvoE2EEState) ||
            RavenE2EEState == SwalvoE2EEState,
        isTrue);
    expect(
        identical(RavenE2EEStateUpdate, SwalvoE2EEStateUpdate) ||
            RavenE2EEStateUpdate == SwalvoE2EEStateUpdate,
        isTrue);
    expect(
        identical(RavenErrorCode, SwalvoErrorCode) ||
            RavenErrorCode == SwalvoErrorCode,
        isTrue);
    expect(
        identical(RavenException, SwalvoException) ||
            RavenException == SwalvoException,
        isTrue);
    expect(identical(RavenGrants, SwalvoGrants) || RavenGrants == SwalvoGrants,
        isTrue);
    expect(
        identical(RavenIceServer, SwalvoIceServer) ||
            RavenIceServer == SwalvoIceServer,
        isTrue);
    expect(
        identical(RavenKeyProvider, SwalvoKeyProvider) ||
            RavenKeyProvider == SwalvoKeyProvider,
        isTrue);
    expect(
        identical(RavenMediaState, SwalvoMediaState) ||
            RavenMediaState == SwalvoMediaState,
        isTrue);
    expect(
        identical(RavenParticipant, SwalvoParticipant) ||
            RavenParticipant == SwalvoParticipant,
        isTrue);
    expect(
        identical(RavenParticipantMetadataChanged,
                SwalvoParticipantMetadataChanged) ||
            RavenParticipantMetadataChanged == SwalvoParticipantMetadataChanged,
        isTrue);
    expect(
        identical(RavenPermission, SwalvoPermission) ||
            RavenPermission == SwalvoPermission,
        isTrue);
    expect(
        identical(RavenPermissionException, SwalvoPermissionException) ||
            RavenPermissionException == SwalvoPermissionException,
        isTrue);
    expect(
        identical(RavenPermissions, SwalvoPermissions) ||
            RavenPermissions == SwalvoPermissions,
        isTrue);
    expect(
        identical(RavenRenderableTrack, SwalvoRenderableTrack) ||
            RavenRenderableTrack == SwalvoRenderableTrack,
        isTrue);
    expect(identical(RavenRoom, SwalvoRoom) || RavenRoom == SwalvoRoom, isTrue);
    expect(
        identical(RavenSimulcastStatus, SwalvoSimulcastStatus) ||
            RavenSimulcastStatus == SwalvoSimulcastStatus,
        isTrue);
    expect(
        identical(RavenSubscriptionState, SwalvoSubscriptionState) ||
            RavenSubscriptionState == SwalvoSubscriptionState,
        isTrue);
    expect(
        identical(
                RavenSubscriptionStateUpdate, SwalvoSubscriptionStateUpdate) ||
            RavenSubscriptionStateUpdate == SwalvoSubscriptionStateUpdate,
        isTrue);
    expect(
        identical(RavenTrackKind, SwalvoTrackKind) ||
            RavenTrackKind == SwalvoTrackKind,
        isTrue);
    expect(
        identical(RavenTranscriptionSegment, SwalvoTranscriptionSegment) ||
            RavenTranscriptionSegment == SwalvoTranscriptionSegment,
        isTrue);
    expect(
        identical(RavenTranscriptionState, SwalvoTranscriptionState) ||
            RavenTranscriptionState == SwalvoTranscriptionState,
        isTrue);
    expect(
        identical(RavenTranscriptionStatus, SwalvoTranscriptionStatus) ||
            RavenTranscriptionStatus == SwalvoTranscriptionStatus,
        isTrue);
    expect(
        identical(RavenVideoCodec, SwalvoVideoCodec) ||
            RavenVideoCodec == SwalvoVideoCodec,
        isTrue);
    expect(
        identical(RavenVideoFit, SwalvoVideoFit) ||
            RavenVideoFit == SwalvoVideoFit,
        isTrue);
    expect(
        identical(RavenVideoView, SwalvoVideoView) ||
            RavenVideoView == SwalvoVideoView,
        isTrue);
    expect(
        identical(RavenWarning, SwalvoWarning) || RavenWarning == SwalvoWarning,
        isTrue);
    expect(
        identical(RavenWarningCode, SwalvoWarningCode) ||
            RavenWarningCode == SwalvoWarningCode,
        isTrue);
  });
}
