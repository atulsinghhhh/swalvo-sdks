/// Swalvo Live Streaming for Flutter.
///
/// ```dart
/// final stream = await SwalvoLiveStream.join(credentials);
///
/// if (stream.isHost) {
///   await stream.room.enableCamera();
///   await stream.room.enableMicrophone();
/// }
///
/// stream.room.participantChanges.listen((participants) { ... });
/// stream.chat?.messages.listen((message) { ... });
///
/// await stream.react('❤️');
/// await stream.leave();
/// ```
///
/// The same concepts as Swalvo Web, React, and React Native: a stream, a
/// host, co-hosts, viewers, live chat, reactions. Only the syntax follows
/// Dart.
///
/// Composes `swalvo_rtc` and `swalvo_chat` rather than reimplementing
/// either: `SwalvoLiveStream.room` is an ordinary [SwalvoRoom] and
/// `SwalvoLiveStream.chat` is an ordinary [SwalvoChat], so every existing
/// API on both packages already works on a stream.
library;

// The deprecated `RavenChat`/`RavenRoom` aliases are re-exported from their
// own packages (never redeclared here), so importing both this package and
// swalvo_rtc/swalvo_chat never sees two conflicting `RavenRoom`s.
// ignore: deprecated_member_use
export 'package:swalvo_chat/swalvo_chat.dart' show SwalvoChat, RavenChat;
// ignore: deprecated_member_use
export 'package:swalvo_rtc/swalvo_rtc.dart' show SwalvoRoom, RavenRoom;

// Deprecated `Raven*` names from the package's former name, raven_live.
export 'src/legacy_aliases.dart';

export 'src/live_player.dart' show SwalvoLivePlayer;
export 'src/live_stream.dart' show SwalvoLiveStream;
export 'src/types.dart'
    show
        SwalvoLiveStageEvent,
        SwalvoLiveStreamChatCredentials,
        SwalvoLiveStreamCredentials,
        SwalvoLiveStreamPlayback,
        SwalvoLiveStreamRole,
        SwalvoLiveStreamRoleX,
        SwalvoLiveStreamRtcCredentials;

// Deliberately not re-exported here: everything swalvo_rtc/swalvo_chat
// themselves keep private (flutter_webrtc, the signaling client, the
// peer-connection engine, the frame vocabulary). Import swalvo_rtc or
// swalvo_chat directly for anything beyond SwalvoRoom/SwalvoChat: this
// package only adds the stream-level composition on top.
