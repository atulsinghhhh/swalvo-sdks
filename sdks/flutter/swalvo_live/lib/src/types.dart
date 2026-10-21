import 'package:swalvo_rtc/swalvo_rtc.dart' show SwalvoIceServer;

/// A stream identity's role: the same three values the backend, the
/// server SDKs, and the web/React/React Native SDKs all use. HOST and
/// CO_HOST carry identical RTC/chat grants; the difference is bookkeeping,
/// never something this SDK infers on its own.
enum SwalvoLiveStreamRole { host, coHost, viewer }

/// `true` for [SwalvoLiveStreamRole.host] and [SwalvoLiveStreamRole.coHost].
extension SwalvoLiveStreamRoleX on SwalvoLiveStreamRole {
  bool get isHost =>
      this == SwalvoLiveStreamRole.host || this == SwalvoLiveStreamRole.coHost;
}

/// Parses the wire value (`"HOST"`, `"CO_HOST"`, `"VIEWER"`) your backend
/// sends. Throws on anything else: silently defaulting an unrecognised
/// role would be the one place getting this wrong actually matters.
SwalvoLiveStreamRole swalvoLiveStreamRoleFromJson(String value) {
  switch (value) {
    case 'HOST':
      return SwalvoLiveStreamRole.host;
    case 'CO_HOST':
      return SwalvoLiveStreamRole.coHost;
    case 'VIEWER':
      return SwalvoLiveStreamRole.viewer;
    default:
      throw ArgumentError.value(value, 'value', 'Unknown live stream role.');
  }
}

/// The RTC half of a stream credential: identical fields to what
/// `Swalvo(token:, endpoint:)` already takes.
class SwalvoLiveStreamRtcCredentials {
  const SwalvoLiveStreamRtcCredentials({
    required this.token,
    required this.endpoint,
    this.iceServers,
  });

  factory SwalvoLiveStreamRtcCredentials.fromJson(Map<String, dynamic> json) =>
      SwalvoLiveStreamRtcCredentials(
        token: json['token'] as String,
        endpoint: json['endpoint'] as String,
        iceServers: (json['iceServers'] as List<dynamic>?)
            ?.map((server) =>
                SwalvoIceServer.fromJson(server as Map<String, dynamic>))
            .toList(growable: false),
      );

  final String token;
  final String endpoint;
  final List<SwalvoIceServer>? iceServers;
}

/// The chat half of a stream credential. Absent entirely when the stream
/// has no chat conversation attached.
class SwalvoLiveStreamChatCredentials {
  const SwalvoLiveStreamChatCredentials({
    required this.token,
    required this.conversations,
    this.apiUrl,
    this.chatUrl,
  });

  factory SwalvoLiveStreamChatCredentials.fromJson(Map<String, dynamic> json) =>
      SwalvoLiveStreamChatCredentials(
        token: json['token'] as String,
        apiUrl: json['apiUrl'] as String?,
        chatUrl: json['chatUrl'] as String?,
        conversations: (json['conversations'] as List<dynamic>? ?? const [])
            .map((value) => value as String)
            .toList(growable: false),
      );

  final String token;
  final String? apiUrl;
  final String? chatUrl;

  /// The conversation(s) this token may touch. [SwalvoLiveStream] connects
  /// to the first one: a stream has exactly one chat conversation today.
  final List<String> conversations;
}

/// Everything [SwalvoLiveStream.join] needs, minted server-side by
/// `@swalvo/server`'s `addHost()`/`createViewerToken()` (or the
/// equivalent `swalvo` (Python) call): never construct one of these by hand.
///
/// Mirrors `@swalvo/live`'s `LiveStreamCredentials` field-for-field,
/// which is the reason [SwalvoLiveStreamCredentials.fromJson] accepts
/// exactly the JSON your backend forwards without any translation.
class SwalvoLiveStreamCredentials {
  const SwalvoLiveStreamCredentials({
    required this.streamId,
    required this.role,
    this.rtc,
    this.chat,
    this.chatRootMessageId,
    this.rtcRoom,
    this.identity,
    this.playback,
  });

  factory SwalvoLiveStreamCredentials.fromJson(Map<String, dynamic> json) =>
      SwalvoLiveStreamCredentials(
        streamId: json['streamId'] as String,
        role: swalvoLiveStreamRoleFromJson(json['role'] as String),
        rtc: json['rtc'] == null
            ? null
            : SwalvoLiveStreamRtcCredentials.fromJson(
                json['rtc'] as Map<String, dynamic>),
        chat: json['chat'] == null
            ? null
            : SwalvoLiveStreamChatCredentials.fromJson(
                json['chat'] as Map<String, dynamic>),
        chatRootMessageId: json['chatRootMessageId'] as String?,
        rtcRoom: json['rtcRoom'] as String?,
        identity: json['identity'] as String?,
        playback: json['playback'] == null
            ? null
            : SwalvoLiveStreamPlayback.fromJson(
                json['playback'] as Map<String, dynamic>),
      );

  final String streamId;
  final SwalvoLiveStreamRole role;

  /// Absent on a BROADCAST viewer's playback credential, which carries
  /// [playback] instead.
  final SwalvoLiveStreamRtcCredentials? rtc;
  final SwalvoLiveStreamChatCredentials? chat;

  /// The stream's public id. `SwalvoLiveStream.join()` doesn't use this to
  /// pick a room — it joins whatever room the [rtc] token itself names,
  /// which for a cascaded viewer of an `edgeScaling` stream may be an edge
  /// room on another media node. That placement is never surfaced here;
  /// this field stays [streamId] either way, and exists only for
  /// display/logging.
  final String? rtcRoom;

  /// This identity, from the mint response.
  final String? identity;

  /// HLS playback for a BROADCAST viewer (mint with `acceptPlayback`).
  final SwalvoLiveStreamPlayback? playback;

  /// The chat message every viewer's reaction attaches to. `null` for a
  /// stream with no chat conversation attached.
  final String? chatRootMessageId;
}

/// A BROADCAST viewer's HLS playback. [url] may name a manifest that isn't
/// published yet while [status] is `STARTING`; [SwalvoLivePlayer] retries.
class SwalvoLiveStreamPlayback {
  const SwalvoLiveStreamPlayback({
    required this.url,
    required this.status,
    this.llhlsUrl,
    this.beacon,
  });

  factory SwalvoLiveStreamPlayback.fromJson(Map<String, dynamic> json) =>
      SwalvoLiveStreamPlayback(
        url: json['url'] as String?,
        llhlsUrl: json['llhlsUrl'] as String?,
        beacon: json['beacon'] == null
            ? null
            : SwalvoPlaybackBeacon.fromJson(
                json['beacon'] as Map<String, dynamic>),
        status: json['status'] as String? ?? 'NOT_STARTED',
      );

  final String? url;

  /// Low-latency HLS (about 2 s behind live) when the deployment serves
  /// it. Pass it as [SwalvoLivePlayer.lowLatencyUrl].
  final String? llhlsUrl;

  /// Watch-time heartbeat for viewer-minute billing. Pass it as
  /// [SwalvoLivePlayer.beacon].
  final SwalvoPlaybackBeacon? beacon;
  final String status;
}

/// A stage signal, from the stream's chat (live-streaming-v2.md §3.4).
/// `invited`, `promoted` and `demoted` are only ever accepted from the
/// server; `raise_hand` / `lower_hand` come from the viewer named.
class SwalvoLiveStageEvent {
  const SwalvoLiveStageEvent({
    required this.action,
    required this.identity,
    required this.forMe,
    this.role,
  });

  final String action;
  final String identity;
  final bool forMe;
  final String? role;
}

/// Where a player reports watch time while playing (viewer-minute billing).
class SwalvoPlaybackBeacon {
  const SwalvoPlaybackBeacon(
      {required this.url, required this.token, required this.intervalSec});

  factory SwalvoPlaybackBeacon.fromJson(Map<String, dynamic> json) =>
      SwalvoPlaybackBeacon(
        url: json['url'] as String,
        token: json['token'] as String,
        intervalSec: (json['intervalSec'] as num?)?.toInt() ?? 30,
      );

  final String url;
  final String token;
  final int intervalSec;
}
