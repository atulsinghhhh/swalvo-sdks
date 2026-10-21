/// Swalvo's signaling wire protocol, as the Flutter client sees it.
///
/// Mirrors `packages/sdk/src/internal/signaling/protocol.ts` and
/// `apps/api/src/modules/signaling/signaling.constants.ts`. Written out
/// here rather than generated: three client implementations (web, React
/// Native, Flutter) speak this, and the contract has to be readable on its
/// own in each language.
///
/// If you change a message here, change it in the other two and in the
/// server. Nothing at build time will catch a drift: only the
/// integration tests will.
library;

import 'dart:convert';

/// Messages this client sends.
abstract final class ClientMessageType {
  static const roomJoin = 'room.join';
  static const roomLeave = 'room.leave';
  static const sdpAnswer = 'sdp.answer';
  static const sdpOffer = 'sdp.offer';
  static const iceCandidate = 'ice.candidate';
  static const trackMute = 'track.mute';

  /// Declares what a track being published is *of*.
  ///
  /// WebRTC carries no notion of source, and an application cannot choose
  /// the media-stream or track id that ends up in the SDP. Without this
  /// the server could only infer source from codec kind, which cannot
  /// tell a screen share from a camera.
  static const trackPublish = 'track.publish';
  static const subscriptionUpdate = 'subscription.update';

  /// A fresh RTC token for the live session (phase1-contracts §1.1).
  static const tokenRefresh = 'token.refresh';
  static const ping = 'ping';

  /// Sets this participant's own metadata and/or attributes
  /// (phase7-contracts §2). Needs `perms.updateOwnMetadata`.
  static const participantUpdate = 'participant.update';
}

/// Messages the server sends.
abstract final class ServerMessageType {
  static const roomJoined = 'room.joined';
  static const roomLeft = 'room.left';
  static const participantJoined = 'participant.joined';
  static const participantLeft = 'participant.left';
  static const trackPublished = 'track.published';
  static const trackUnpublished = 'track.unpublished';
  static const trackMuted = 'track.muted';
  static const trackUnmuted = 'track.unmuted';
  static const sdpOffer = 'sdp.offer';
  static const sdpAnswer = 'sdp.answer';
  static const iceCandidate = 'ice.candidate';
  static const connectionState = 'connection.state';
  static const error = 'error';
  static const pong = 'pong';

  // Phase 1 resilience additions (docs/architecture/phase1-contracts.md
  // §1). Additive: a server that predates them never sends them.
  static const tokenExpiring = 'token.expiring';
  static const tokenRefreshed = 'token.refreshed';
  static const roomResumeToken = 'room.resume_token';
  static const participantPermissionsUpdated =
      'participant.permissions_updated';

  // Phase 2 media-quality additions
  // (docs/architecture/phase2-media-contracts.md §2–§5). Additive as well:
  // an older server never sends them, and this client then behaves exactly
  // as it did before they existed.
  static const speakersChanged = 'speakers.changed';
  static const qualityChanged = 'quality.changed';
  static const subscriptionState = 'subscription.state';
  static const publisherLayers = 'publisher.layers';

  /// Someone's metadata or attributes changed (phase7-contracts §2).
  static const participantUpdated = 'participant.updated';

  /// The SFU dropped this participant's data messages for exceeding the
  /// rate limit (phase7-contracts §1.4).
  static const dataThrottled = 'data.throttled';

  // Phase 6 (docs/architecture/phase6-contracts.md §4). Additive.
  /// A live caption, interim or final (§4.1).
  static const transcriptionSegment = 'transcription.segment';

  /// The room's transcription changed status (§4.3).
  static const transcriptionState = 'transcription.state';

  /// An AI agent is listening, thinking, speaking or has ended (§4.2).
  static const agentState = 'agent.state';
}

/// WebSocket close codes the client acts on.
abstract final class CloseCode {
  /// The API is restarting gracefully: reconnect now, with resume (§1.3).
  static const serviceRestart = 1012;

  /// Authentication failed, or the token expired with enforcement on.
  static const authFailed = 4001;

  /// Removed by the server, or the room closed. Never reconnect (§1.5).
  static const removed = 4003;
}

/// Signaling error codes, as the server names them.
abstract final class SignalingErrorCode {
  static const invalidToken = 'INVALID_TOKEN';
  static const tokenExpired = 'TOKEN_EXPIRED';
  static const unauthorized = 'UNAUTHORIZED';
  static const roomNotFound = 'ROOM_NOT_FOUND';
  static const roomFull = 'ROOM_FULL';
  static const permissionDenied = 'PERMISSION_DENIED';
  static const rateLimited = 'RATE_LIMITED';
  static const noRtcCapacity = 'NO_RTC_CAPACITY';
  static const rtcServerUnreachable = 'RTC_SERVER_UNREACHABLE';
  static const negotiationFailed = 'NEGOTIATION_FAILED';
  static const negotiationGlare = 'NEGOTIATION_GLARE';

  /// A `token.refresh` was refused. Non-fatal: the session continues on
  /// its old token (§1.1).
  static const tokenInvalid = 'TOKEN_INVALID';

  /// The room was closed server-side; a 4003 close follows.
  static const roomClosed = 'ROOM_CLOSED';

  /// Codes that mean the credential itself is the problem, so reconnecting
  /// with the same token cannot help.
  ///
  /// The distinction drives reconnect behaviour: everything else is worth
  /// retrying with backoff, these need a fresh token from the
  /// application's backend first.
  static const fatal = <String>{
    invalidToken,
    tokenExpired,
    unauthorized,
    roomNotFound,
    permissionDenied,
  };
}

/// A track the server says someone is publishing.
class ServerTrack {
  const ServerTrack({
    required this.trackId,
    required this.kind,
    required this.source,
    required this.muted,
    required this.simulcast,
    this.layers = const [],
  });

  factory ServerTrack.fromJson(Map<String, dynamic> json) => ServerTrack(
        trackId: json['trackId'] as String? ?? '',
        kind: json['kind'] as String? ?? 'video',
        source: json['source'] as String? ?? 'unknown',
        muted: json['muted'] as bool? ?? false,
        simulcast: json['simulcast'] as bool? ?? false,
        layers: (json['layers'] as List<dynamic>?)
                ?.map((layer) => layer as String)
                .toList(growable: false) ??
            const [],
      );

  final String trackId;

  /// `'audio'` or `'video'`: the codec kind, not the source.
  final String kind;

  /// `'camera'`, `'microphone'`, `'screenShare'`, or something this
  /// version does not know about.
  final String source;
  final bool muted;
  final bool simulcast;

  /// Layers actually being sent, when simulcast. Empty otherwise.
  final List<String> layers;
}

/// A participant the server says is in the room.
class ServerParticipant {
  const ServerParticipant({
    required this.id,
    this.tracks = const [],
    this.metadata,
    this.attributes,
  });

  factory ServerParticipant.fromJson(Map<String, dynamic> json) =>
      ServerParticipant(
        id: json['id'] as String? ?? '',
        tracks: (json['tracks'] as List<dynamic>?)
                ?.map((track) =>
                    ServerTrack.fromJson(track as Map<String, dynamic>))
                .toList(growable: false) ??
            const [],
        metadata: json['metadata'] as String?,
        attributes: parseAttributes(json['attributes']),
      );

  final String id;

  /// Opaque application metadata (phase7-contracts §2). Null when unset
  /// or from an older server.
  final String? metadata;

  /// Key/value attributes. Null when the server did not send the field.
  final Map<String, String>? attributes;

  /// What this participant is already publishing.
  ///
  /// Present in `room.joined` so a client joining a call in progress can
  /// render the room in one pass, instead of showing an empty grid and
  /// filling it in from a stream of events it has to distinguish from
  /// genuinely new ones.
  final List<ServerTrack> tracks;
}

/// What the server reports at the moment of joining.
class JoinedPayload {
  const JoinedPayload({
    required this.roomId,
    required this.participants,
    this.rtcServer,
    this.region,
    this.resumeToken,
    this.resumed = false,
    this.e2ee = false,
    this.capabilities = const [],
  });

  factory JoinedPayload.fromJson(Map<String, dynamic> json,
          {bool askedToResume = false}) =>
      JoinedPayload(
        roomId: json['roomId'] as String? ?? '',
        participants: (json['participants'] as List<dynamic>?)
                ?.map((participant) => ServerParticipant.fromJson(
                    participant as Map<String, dynamic>))
                .toList(growable: false) ??
            const [],
        rtcServer: json['rtcServer'] as String?,
        region: json['region'] as String?,
        resumeToken: json['resumeToken'] as String?,
        // Only meaningful if the join asked to resume. A server that
        // ignores a request it does not understand must read as "fresh".
        resumed: askedToResume && json['resumed'] == true,
        e2ee: json['e2ee'] == true,
        capabilities: (json['capabilities'] as List<dynamic>?)
                ?.whereType<String>()
                .toList(growable: false) ??
            const [],
      );

  final String roomId;
  final List<ServerParticipant> participants;

  /// The RTC server's *name*, for diagnostics. Never its address: a
  /// client that learned an SFU's address could connect to it directly,
  /// and then the media plane could not be changed without breaking that
  /// client.
  final String? rtcServer;
  final String? region;

  /// Opaque; handed back in `room.join` after a socket drop (§1.2).
  final String? resumeToken;

  /// The room is end-to-end encrypted (phase5-contracts §3.1): unencrypted
  /// media must not be published into it.
  final bool e2ee;

  /// What the server supports beyond the base protocol, such as
  /// `'data.v2'` (phase7-contracts §1.6). Empty from an older server.
  final List<String> capabilities;

  /// True when this join re-bound the previous SFU session: the existing
  /// peer connection is still live and must be kept. False on a first join
  /// and whenever the server fell back to a fresh session.
  final bool resumed;
}

/// An ICE candidate, in the shape both directions of the protocol use.
class IceCandidatePayload {
  const IceCandidatePayload({
    required this.candidate,
    this.sdpMid,
    this.sdpMLineIndex,
    this.usernameFragment,
  });

  factory IceCandidatePayload.fromJson(Map<String, dynamic> json) =>
      IceCandidatePayload(
        candidate: json['candidate'] as String? ?? '',
        sdpMid: json['sdpMid'] as String?,
        sdpMLineIndex: json['sdpMLineIndex'] as int?,
        usernameFragment: json['usernameFragment'] as String?,
      );

  final String candidate;
  final String? sdpMid;
  final int? sdpMLineIndex;
  final String? usernameFragment;

  Map<String, dynamic> toJson() => {
        'type': ClientMessageType.iceCandidate,
        'candidate': candidate,
        if (sdpMid != null) 'sdpMid': sdpMid,
        if (sdpMLineIndex != null) 'sdpMLineIndex': sdpMLineIndex,
        if (usernameFragment != null) 'usernameFragment': usernameFragment,
      };
}

/// One entry of `speakers.changed` (phase2-media-contracts §2).
class SpeakerLevel {
  const SpeakerLevel(this.participantId, this.level);

  final String participantId;

  /// 0..1, clamped: a level outside the range is a server bug, not a
  /// reason to render a meter at 140 %.
  final double level;
}

/// Reads `speakers.changed`, loudest first as the server sent it.
///
/// Entries without a participant id are skipped, never thrown on: the
/// message is advisory, and one bad entry should not cost a UI the rest.
List<SpeakerLevel> parseSpeakers(Map<String, dynamic> message) {
  final raw = message['speakers'];
  if (raw is! List) return const [];
  final speakers = <SpeakerLevel>[];
  for (final entry in raw) {
    if (entry is! Map) continue;
    final id = entry['participantId'];
    if (id is! String || id.isEmpty) continue;
    final level = entry['level'];
    final value = level is num ? level.toDouble().clamp(0.0, 1.0) : 0.0;
    speakers.add(SpeakerLevel(id, value));
  }
  return speakers;
}

/// Connection-quality scores the server sends (§3). `unknown` is the
/// client's own word for "nobody has said", so it is not accepted here.
const connectionQualityWireNames = {'excellent', 'good', 'poor', 'lost'};

/// Reads `quality.changed` into `participantId → quality`, dropping any
/// entry whose score this version does not know.
Map<String, String> parseQualityUpdates(Map<String, dynamic> message) {
  final raw = message['updates'];
  if (raw is! List) return const {};
  final updates = <String, String>{};
  for (final entry in raw) {
    if (entry is! Map) continue;
    final id = entry['participantId'];
    final quality = entry['quality'];
    if (id is! String || id.isEmpty) continue;
    if (quality is! String || !connectionQualityWireNames.contains(quality)) {
      continue;
    }
    updates[id] = quality;
  }
  return updates;
}

/// Subscription states the server sends (§4).
const subscriptionStateWireNames = {
  'active',
  'paused_bandwidth',
  'paused_client',
};

/// Layers a `subscription.state` may report as being forwarded.
const forwardedLayerWireNames = {'low', 'medium', 'high', 'off'};

/// Reads `subscription.state`. Null when it is missing what it needs to be
/// attributed, or names a state this version does not know.
({String publisherId, String trackId, String state, String? layer})?
    parseSubscriptionState(Map<String, dynamic> message) {
  final publisherId = message['publisherId'];
  final trackId = message['trackId'];
  final state = message['state'];
  if (publisherId is! String || publisherId.isEmpty) return null;
  if (trackId is! String || trackId.isEmpty) return null;
  if (state is! String || !subscriptionStateWireNames.contains(state)) {
    return null;
  }
  final layer = message['layer'];
  return (
    publisherId: publisherId,
    trackId: trackId,
    state: state,
    layer: layer is String && forwardedLayerWireNames.contains(layer)
        ? layer
        : null,
  );
}

/// Reads `publisher.layers` (§5) into `rid → active`. Null when it names
/// no track.
({String trackId, Map<String, bool> layers})? parsePublisherLayers(
    Map<String, dynamic> message) {
  final trackId = message['trackId'];
  if (trackId is! String || trackId.isEmpty) return null;
  final raw = message['layers'];
  if (raw is! List) return null;
  final layers = <String, bool>{};
  for (final entry in raw) {
    if (entry is! Map) continue;
    final rid = entry['rid'];
    final active = entry['active'];
    if (rid is! String || rid.isEmpty || active is! bool) continue;
    layers[rid] = active;
  }
  return (trackId: trackId, layers: layers);
}

/// Other spellings of the same three RIDs.
///
/// The contract's example uses `q`/`h`/`f`; Swalvo's publishers send
/// `low`/`medium`/`high` (see `simulcastEncodings`). Both are accepted, so
/// a server written against either reading still reaches the right
/// encoding.
const ridAliases = {
  'q': 'low',
  'h': 'medium',
  'f': 'high',
  'low': 'q',
  'medium': 'h',
  'high': 'f',
};

/// Whether [layers] says the encoding with [rid] should send. Null when it
/// does not mention that encoding, which leaves it as it is.
bool? layerActiveFor(Map<String, bool> layers, String? rid) {
  if (rid == null || rid.isEmpty) return null;
  return layers[rid] ?? layers[ridAliases[rid]];
}

/// Reads the claims out of a Swalvo RTC token.
///
/// The payload is readable, not secret: the same information the server
/// will act on. It is decoded, never trusted: the server re-verifies the
/// signature, so anything a client changed here only changes which room it
/// *asks* for.
Map<String, dynamic>? decodeTokenClaims(String token) {
  final parts = token.split('.');
  if (parts.length != 3) return null;

  try {
    // base64Url tolerates the unpadded form the JWT spec mandates, so no
    // padding fix-up is needed: unlike plain `base64`, which throws.
    final decoded =
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
    final parsed = jsonDecode(decoded);
    return parsed is Map<String, dynamic> ? parsed : null;
  } catch (_) {
    return null;
  }
}

/// Capability a server advertises in `room.joined` for data messages v2.
const dataV2Capability = 'data.v2';

/// Reads a wire `attributes` object as string pairs; null when absent or
/// not an object. Non-string values are dropped.
Map<String, String>? parseAttributes(Object? raw) {
  if (raw is! Map) return null;
  final result = <String, String>{};
  raw.forEach((key, value) {
    if (key is String && value is String) result[key] = value;
  });
  return result;
}
