// Deprecated aliases for the pre-rename `raven_rtc` public API.
//
// The package was published as `raven_rtc` with `Raven*` type names. Code
// written against it compiles against `swalvo_rtc` after changing the
// import, with deprecation warnings only. Every alias points at the same
// type, so `is` checks and pattern matches behave identically.

import 'e2ee.dart';
import 'errors.dart';
import 'permissions.dart';
import 'room.dart';
import 'swalvo.dart';
import 'types.dart';
import 'video_view.dart';

@Deprecated('Renamed to Swalvo. Will be removed in 1.0.')
typedef Raven = Swalvo;

@Deprecated('Renamed to SwalvoAgentState. Will be removed in 1.0.')
typedef RavenAgentState = SwalvoAgentState;

@Deprecated('Renamed to SwalvoAgentStateChanged. Will be removed in 1.0.')
typedef RavenAgentStateChanged = SwalvoAgentStateChanged;

@Deprecated('Renamed to SwalvoConnectionQuality. Will be removed in 1.0.')
typedef RavenConnectionQuality = SwalvoConnectionQuality;

@Deprecated('Renamed to SwalvoConnectionQualityUpdate. Will be removed in 1.0.')
typedef RavenConnectionQualityUpdate = SwalvoConnectionQualityUpdate;

@Deprecated('Renamed to SwalvoConnectionState. Will be removed in 1.0.')
typedef RavenConnectionState = SwalvoConnectionState;

@Deprecated('Renamed to SwalvoDataChannelKind. Will be removed in 1.0.')
typedef RavenDataChannelKind = SwalvoDataChannelKind;

@Deprecated('Renamed to SwalvoDataMessage. Will be removed in 1.0.')
typedef RavenDataMessage = SwalvoDataMessage;

@Deprecated('Renamed to SwalvoDataThrottled. Will be removed in 1.0.')
typedef RavenDataThrottled = SwalvoDataThrottled;

@Deprecated('Renamed to SwalvoDisconnectReason. Will be removed in 1.0.')
typedef RavenDisconnectReason = SwalvoDisconnectReason;

@Deprecated('Renamed to SwalvoE2EEOptions. Will be removed in 1.0.')
typedef RavenE2EEOptions = SwalvoE2EEOptions;

@Deprecated('Renamed to SwalvoE2EEState. Will be removed in 1.0.')
typedef RavenE2EEState = SwalvoE2EEState;

@Deprecated('Renamed to SwalvoE2EEStateUpdate. Will be removed in 1.0.')
typedef RavenE2EEStateUpdate = SwalvoE2EEStateUpdate;

@Deprecated('Renamed to SwalvoErrorCode. Will be removed in 1.0.')
typedef RavenErrorCode = SwalvoErrorCode;

@Deprecated('Renamed to SwalvoException. Will be removed in 1.0.')
typedef RavenException = SwalvoException;

@Deprecated('Renamed to SwalvoGrants. Will be removed in 1.0.')
typedef RavenGrants = SwalvoGrants;

@Deprecated('Renamed to SwalvoIceServer. Will be removed in 1.0.')
typedef RavenIceServer = SwalvoIceServer;

@Deprecated('Renamed to SwalvoKeyProvider. Will be removed in 1.0.')
typedef RavenKeyProvider = SwalvoKeyProvider;

@Deprecated('Renamed to SwalvoMediaState. Will be removed in 1.0.')
typedef RavenMediaState = SwalvoMediaState;

@Deprecated('Renamed to SwalvoParticipant. Will be removed in 1.0.')
typedef RavenParticipant = SwalvoParticipant;

@Deprecated(
    'Renamed to SwalvoParticipantMetadataChanged. Will be removed in 1.0.')
typedef RavenParticipantMetadataChanged = SwalvoParticipantMetadataChanged;

@Deprecated('Renamed to SwalvoPermission. Will be removed in 1.0.')
typedef RavenPermission = SwalvoPermission;

@Deprecated('Renamed to SwalvoPermissionException. Will be removed in 1.0.')
typedef RavenPermissionException = SwalvoPermissionException;

@Deprecated('Renamed to SwalvoPermissions. Will be removed in 1.0.')
typedef RavenPermissions = SwalvoPermissions;

@Deprecated('Renamed to SwalvoRenderableTrack. Will be removed in 1.0.')
typedef RavenRenderableTrack = SwalvoRenderableTrack;

@Deprecated('Renamed to SwalvoRoom. Will be removed in 1.0.')
typedef RavenRoom = SwalvoRoom;

@Deprecated('Renamed to SwalvoSimulcastStatus. Will be removed in 1.0.')
typedef RavenSimulcastStatus = SwalvoSimulcastStatus;

@Deprecated('Renamed to SwalvoSubscriptionState. Will be removed in 1.0.')
typedef RavenSubscriptionState = SwalvoSubscriptionState;

@Deprecated('Renamed to SwalvoSubscriptionStateUpdate. Will be removed in 1.0.')
typedef RavenSubscriptionStateUpdate = SwalvoSubscriptionStateUpdate;

@Deprecated('Renamed to SwalvoTrackKind. Will be removed in 1.0.')
typedef RavenTrackKind = SwalvoTrackKind;

@Deprecated('Renamed to SwalvoTranscriptionSegment. Will be removed in 1.0.')
typedef RavenTranscriptionSegment = SwalvoTranscriptionSegment;

@Deprecated('Renamed to SwalvoTranscriptionState. Will be removed in 1.0.')
typedef RavenTranscriptionState = SwalvoTranscriptionState;

@Deprecated('Renamed to SwalvoTranscriptionStatus. Will be removed in 1.0.')
typedef RavenTranscriptionStatus = SwalvoTranscriptionStatus;

@Deprecated('Renamed to SwalvoVideoCodec. Will be removed in 1.0.')
typedef RavenVideoCodec = SwalvoVideoCodec;

@Deprecated('Renamed to SwalvoVideoFit. Will be removed in 1.0.')
typedef RavenVideoFit = SwalvoVideoFit;

@Deprecated('Renamed to SwalvoVideoView. Will be removed in 1.0.')
typedef RavenVideoView = SwalvoVideoView;

@Deprecated('Renamed to SwalvoWarning. Will be removed in 1.0.')
typedef RavenWarning = SwalvoWarning;

@Deprecated('Renamed to SwalvoWarningCode. Will be removed in 1.0.')
typedef RavenWarningCode = SwalvoWarningCode;
