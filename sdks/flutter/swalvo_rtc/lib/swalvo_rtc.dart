/// Swalvo for Flutter: real-time audio and video.
///
/// ```dart
/// final swalvo = Swalvo(token: token, endpoint: endpoint);
/// final room = await swalvo.join('room_123');
///
/// await room.enableCamera();
/// await room.enableMicrophone();
/// ```
///
/// The same concepts as Swalvo Web and Swalvo React Native: a room, a
/// participant, a camera, a microphone. Only the syntax follows Dart.
///
/// For messaging, add `swalvo_chat`: the two are independent packages, so
/// a video app never carries a message store and a chat app never carries
/// WebRTC.
library;

// Deprecated `Raven*` names from the package's former name, raven_rtc.
export 'src/legacy_aliases.dart';
export 'src/errors.dart'
    show
        SwalvoErrorCode,
        SwalvoException,
        SwalvoPermission,
        SwalvoPermissionException;
export 'src/e2ee.dart'
    show
        SwalvoE2EEOptions,
        SwalvoE2EEState,
        SwalvoE2EEStateUpdate,
        SwalvoKeyProvider;
export 'src/permissions.dart' show SwalvoPermissions;
export 'src/swalvo.dart' show Swalvo, SwalvoIceServer;
export 'src/room.dart' show SwalvoRoom;
export 'src/types.dart'
    show
        SwalvoAgentState,
        SwalvoAgentStateChanged,
        SwalvoConnectionQuality,
        SwalvoConnectionQualityUpdate,
        SwalvoConnectionState,
        SwalvoDataChannelKind,
        SwalvoDataMessage,
        SwalvoDataThrottled,
        SwalvoDisconnectReason,
        SwalvoGrants,
        SwalvoMediaState,
        SwalvoParticipant,
        SwalvoParticipantMetadataChanged,
        SwalvoRenderableTrack,
        SwalvoSimulcastStatus,
        SwalvoSubscriptionState,
        SwalvoSubscriptionStateUpdate,
        SwalvoTrackKind,
        SwalvoTranscriptionSegment,
        SwalvoTranscriptionState,
        SwalvoTranscriptionStatus,
        SwalvoVideoCodec,
        SwalvoWarning,
        SwalvoWarningCode;
export 'src/video_view.dart' show SwalvoVideoFit, SwalvoVideoView;

// Deliberately not exported: flutter_webrtc, the signaling client, the
// peer-connection engine, and every other implementation detail. A
// developer using Swalvo should never need to name a WebRTC type (spec §2).
//
// `SwalvoRenderableTrack` is the one borderline case: it carries a
// flutter_webrtc MediaStream, and it is exported only so the type
// `SwalvoParticipant.videoTrackFor` returns is nameable instead of leaked
// and unmentionable. It exists for SwalvoVideoView; an application should
// not need it.
