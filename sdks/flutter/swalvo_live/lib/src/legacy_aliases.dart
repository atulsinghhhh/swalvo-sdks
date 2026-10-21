// Deprecated aliases for the pre-rename `raven_live` public API.
//
// The package was published as `raven_live` with `Raven*` type names. Code
// written against it compiles against `swalvo_live` after changing the
// import, with deprecation warnings only. Every alias points at the same
// type, so `is` checks and pattern matches behave identically.

import 'live_player.dart';
import 'live_stream.dart';
import 'types.dart';

@Deprecated('Renamed to SwalvoLivePlayer. Will be removed in 1.0.')
typedef RavenLivePlayer = SwalvoLivePlayer;

@Deprecated('Renamed to SwalvoLiveStageEvent. Will be removed in 1.0.')
typedef RavenLiveStageEvent = SwalvoLiveStageEvent;

@Deprecated('Renamed to SwalvoLiveStream. Will be removed in 1.0.')
typedef RavenLiveStream = SwalvoLiveStream;

@Deprecated(
    'Renamed to SwalvoLiveStreamChatCredentials. Will be removed in 1.0.')
typedef RavenLiveStreamChatCredentials = SwalvoLiveStreamChatCredentials;

@Deprecated('Renamed to SwalvoLiveStreamCredentials. Will be removed in 1.0.')
typedef RavenLiveStreamCredentials = SwalvoLiveStreamCredentials;

@Deprecated('Renamed to SwalvoLiveStreamPlayback. Will be removed in 1.0.')
typedef RavenLiveStreamPlayback = SwalvoLiveStreamPlayback;

@Deprecated('Renamed to SwalvoLiveStreamRole. Will be removed in 1.0.')
typedef RavenLiveStreamRole = SwalvoLiveStreamRole;

@Deprecated(
    'Renamed to SwalvoLiveStreamRtcCredentials. Will be removed in 1.0.')
typedef RavenLiveStreamRtcCredentials = SwalvoLiveStreamRtcCredentials;
