import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;
import 'package:meta/meta.dart';

/// Signaling lifecycle, mirroring the web SDK's `ConnectionState`.
///
/// **This is the control plane, and only the control plane.** It is set
/// from the signaling socket alone — `room.joined`, `reconnecting`,
/// `disconnected`, `failed` — so a room reads [connected] as soon as the
/// server has accepted the join, whatever the media transport is doing.
/// A room whose ICE transport has failed outright still reads [connected]
/// here, because the socket carrying that news is itself perfectly
/// healthy.
///
/// That is the right answer to "am I in the room", and the wrong one to
/// "is video flowing". For the second question use
/// [SwalvoRoom.mediaState], which reports the peer connection itself.
/// A UI that labels this one "connected" with no qualifier is the reason
/// [SwalvoMediaState] exists.
enum SwalvoConnectionState {
  disconnected,
  connecting,
  connected,
  reconnecting,
  failed,
}

/// Why a room ended up [SwalvoConnectionState.disconnected] or
/// [SwalvoConnectionState.failed]. Read it from
/// [SwalvoRoom.disconnectReason]. Same vocabulary as the web SDK's
/// `DisconnectReason`.
enum SwalvoDisconnectReason {
  /// [SwalvoRoom.leave] was called.
  clientInitiated,

  /// The server removed this participant. The SDK does not reconnect.
  removed,

  /// The room was closed server-side. The SDK does not reconnect.
  roomClosed,

  /// The token expired and could not be refreshed: no `refreshToken` was
  /// configured, or it failed.
  tokenExpired,

  /// The network, the server or a fatal signaling error ended the session,
  /// and reconnecting did not (or could not) help.
  connectionFailed,
}

/// What this participant may currently do, as the server last said.
///
/// Starts from the token's grants and changes live when the server updates
/// them: a moderator revoking publishing, or a live-stream viewer promoted
/// to the stage. See [SwalvoRoom.grants] and [SwalvoRoom.grantChanges].
class SwalvoGrants {
  const SwalvoGrants({
    required this.subscribe,
    required this.publish,
    required this.publishAudio,
    required this.publishVideo,
    this.publishScreen = false,
    required this.publishData,
    this.updateOwnMetadata = false,
  });

  /// Reads the wire shape. A missing `subscribe` reads as allowed, every
  /// missing publish right as withheld: the conservative reading for the
  /// rights that cost the room something.
  factory SwalvoGrants.fromJson(Map<String, dynamic> json) => SwalvoGrants(
        subscribe: json['subscribe'] != false,
        publish: json['publish'] == true,
        publishAudio: json['publishAudio'] == true,
        publishVideo: json['publishVideo'] == true,
        publishScreen: json['publishScreen'] == true,
        publishData: json['publishData'] == true,
        updateOwnMetadata: json['updateOwnMetadata'] == true,
      );

  final bool subscribe;
  final bool publish;
  final bool publishAudio;
  final bool publishVideo;

  /// Screen-share, independent of [publishVideo] (agora-parity audit,
  /// phase 2). Granting camera video never implies this, and vice versa.
  final bool publishScreen;
  final bool publishData;

  /// Whether [SwalvoRoom.setMetadata] and [SwalvoRoom.setAttributes] are
  /// allowed (token `perms.updateOwnMetadata`, default false).
  final bool updateOwnMetadata;

  /// Whether a track of this codec kind (`'audio'` / `'video'`) may be
  /// published. For video this is [publishVideo] specifically — a camera
  /// check, not "any video source" — see [mayPublishSource] for one that
  /// also knows about screen share.
  bool mayPublishKind(String kind) =>
      publish && (kind == 'audio' ? publishAudio : publishVideo);

  /// Whether a track declared as this source (`'camera'`, `'microphone'`,
  /// `'screenShare'`, `'screenShareAudio'`) may be published. Screen share
  /// gates on [publishScreen], not [publishVideo]; its own audio
  /// companion is still just audio, gated on [publishAudio].
  bool mayPublishSource(String source) {
    if (!publish) return false;
    switch (source) {
      case 'microphone':
      case 'screenShareAudio':
        return publishAudio;
      case 'screenShare':
        return publishScreen;
      default:
        return publishVideo;
    }
  }
}

/// Something worth knowing that did not stop the call. See
/// [SwalvoRoom.warnings].
class SwalvoWarning {
  const SwalvoWarning(this.code, this.message, {this.expiresAt, this.cause});

  /// `tokenExpiring` (no `refreshToken` configured) or
  /// `tokenRefreshFailed` (it threw, or the server refused the new token).
  final SwalvoWarningCode code;
  final String message;

  /// When the current token expires, if the server said.
  final String? expiresAt;
  final Object? cause;

  @override
  String toString() => 'SwalvoWarning(${code.name}): $message';
}

enum SwalvoWarningCode { tokenExpiring, tokenRefreshFailed }

/// Health of the media transport: whether packets can actually flow.
///
/// The counterpart to [SwalvoConnectionState], and the one to believe when
/// the question is "why is there no video". Signaling and media are
/// separate connections over separate paths — a WebSocket to the control
/// plane, and an ICE/DTLS transport to the SFU — and they fail
/// independently. A corporate network that permits outbound TLS but drops
/// UDP produces a room that joins cleanly, lists its participants, relays
/// chat, and never carries a single frame.
///
/// Read from the peer connection's own state, not inferred from anything
/// the SDK did.
enum SwalvoMediaState {
  /// No peer connection yet: nobody has published or subscribed.
  idle,

  /// Gathering candidates and trying to establish a transport.
  connecting,

  /// A transport is up. Media can flow.
  connected,

  /// The transport dropped. ICE is still trying, and this often recovers
  /// on its own within a few seconds — a phone changing network usually
  /// passes through here. Worth showing as a warning, not an error.
  interrupted,

  /// ICE gave up. Nothing will flow on this connection again; recovery
  /// means a new one, which a signaling reconnect brings about.
  failed,

  /// The connection was closed, by [SwalvoRoom.leave] or a reconnect
  /// tearing the old session down.
  closed,
}

/// What a track carries.
///
/// `unknown` exists because the SFU can in principle report a source this
/// version doesn't know: treating that as an error would break an app on
/// a server upgrade it didn't ask for.
enum SwalvoTrackKind {
  camera,
  microphone,
  screenShare,

  /// The audio a screen share captured (a tab or system audio). Received
  /// like any audio track; never rendered as video.
  screenShareAudio,
  unknown,
}

/// @internal The simulcast layer a subscriber is asking the SFU for.
///
/// Internal on purpose: `SwalvoRoom.requestLayer` takes the wire string, and
/// has since before this existed. Adding an enum to the public signature
/// would break every existing caller to buy type safety on four values that
/// are already documented.
///
/// `auto` is not a fourth layer. It hands the choice back to the SFU
/// (highest available) and releases any pin an application had set.
enum SwalvoVideoLayer { low, medium, high, auto }

/// @internal The wire name for a layer. The protocol carries these
/// strings, and they are the same three RIDs the publisher sends.
extension SwalvoVideoLayerWire on SwalvoVideoLayer {
  String get wireName => switch (this) {
        SwalvoVideoLayer.low => 'low',
        SwalvoVideoLayer.medium => 'medium',
        SwalvoVideoLayer.high => 'high',
        SwalvoVideoLayer.auto => 'auto',
      };
}

/// Whether a published camera is genuinely sending a simulcast ladder.
///
/// Worth reporting rather than assuming, because for a long time this SDK
/// assumed. Simulcast was configured with `setParameters()` after
/// `addTrack()`, which the WebRTC specification requires implementations to
/// reject — the number of encodings is fixed once a sender exists — and the
/// rejection was swallowed. Every publisher sent one full-resolution layer
/// while the code believed it was sending three, and there was no way to
/// tell from the outside.
///
/// So this is deliberately observable: [SwalvoRoom.simulcastStatusFor] reads
/// it back from the negotiated sender parameters after publishing, not from
/// what was requested.
/// The camera codec `Swalvo(videoCodec:)` asks for (phase5-contracts §2.2).
enum SwalvoVideoCodec {
  /// Offered first, with the usual three-layer simulcast.
  vp8,

  /// Offered first, with simulcast. What a live-stream host wants: egress
  /// can copy it instead of transcoding.
  h264,

  /// SVC: one encoding with `scalabilityMode` L3T3_KEY, thinned by the SFU
  /// per subscriber. Falls back to VP8 simulcast where unsupported.
  vp9,

  /// SVC, as [vp9].
  av1,
}

enum SwalvoSimulcastStatus {
  /// Three layers negotiated and confirmed present on the sender.
  enabled,

  /// The platform refused the ladder. One full-quality layer is being
  /// sent; subscribers cannot drop to a cheaper one. A warning was logged.
  unsupported,

  /// Not a simulcast track: microphones have no spatial layers, and screen
  /// shares deliberately send one high-quality layer because dropping
  /// resolution wrecks text legibility.
  notApplicable,

  /// Published, but the negotiation that would confirm the ladder has not
  /// finished yet.
  pending,

  /// One VP9/AV1 encoding with `scalabilityMode` L3T3_KEY
  /// (`Swalvo(videoCodec: ...)`): the layers travel inside it and the SFU
  /// thins it per subscriber (phase5-contracts §2.2).
  svc,
}

/// The SFU's read on a participant's connection, scored once a second from
/// what it measures itself: loss, jitter, RTT and, for a subscriber, its
/// bandwidth estimate against what its subscriptions need
/// (phase2-media-contracts §3).
///
/// [unknown] is the honest answer before the server has said anything, and
/// the only answer an older server ever gives. [lost] means no media or
/// RTCP from that participant for five seconds.
enum SwalvoConnectionQuality { excellent, good, poor, lost, unknown }

/// @internal Wire name → [SwalvoConnectionQuality]. Unknown names map to
/// [SwalvoConnectionQuality.unknown] rather than throwing.
SwalvoConnectionQuality connectionQualityFromWire(String? name) =>
    switch (name) {
      'excellent' => SwalvoConnectionQuality.excellent,
      'good' => SwalvoConnectionQuality.good,
      'poor' => SwalvoConnectionQuality.poor,
      'lost' => SwalvoConnectionQuality.lost,
      _ => SwalvoConnectionQuality.unknown,
    };

/// Whether the SFU is forwarding a subscribed video track to this device
/// (phase2-media-contracts §4). Audio is always forwarded.
enum SwalvoSubscriptionState {
  /// Being forwarded. `SwalvoRenderableTrack.layer` says which layer.
  active,

  /// Paused by the SFU's congestion control: this device's bandwidth
  /// estimate cannot fit even the lowest layer right now. It resumes on its
  /// own when bandwidth recovers. Worth a "poor connection" badge rather
  /// than a frozen frame.
  pausedBandwidth,

  /// Paused because this device asked: [SwalvoRoom.setVideoEnabled] with
  /// `false`, every view of it hidden or zero-sized, or a room joined with
  /// `autoSubscribe: false` that has not asked for this track yet.
  pausedClient,
}

/// @internal Wire name → [SwalvoSubscriptionState]; null for a name this
/// version does not know.
SwalvoSubscriptionState? subscriptionStateFromWire(String? name) =>
    switch (name) {
      'active' => SwalvoSubscriptionState.active,
      'paused_bandwidth' => SwalvoSubscriptionState.pausedBandwidth,
      'paused_client' => SwalvoSubscriptionState.pausedClient,
      _ => null,
    };

/// One participant's connection quality changing. See
/// [SwalvoRoom.connectionQualityChanges].
@immutable
class SwalvoConnectionQualityUpdate {
  const SwalvoConnectionQualityUpdate(this.participant, this.quality);

  /// A snapshot taken as the change landed; local or remote.
  final SwalvoParticipant participant;
  final SwalvoConnectionQuality quality;

  @override
  String toString() =>
      'SwalvoConnectionQualityUpdate(${participant.identity}: ${quality.name})';
}

/// A subscribed video track's forwarding state changing. See
/// [SwalvoRoom.subscriptionStateChanges].
@immutable
class SwalvoSubscriptionStateUpdate {
  const SwalvoSubscriptionStateUpdate({
    required this.participant,
    required this.kind,
    required this.state,
    this.layer,
  });

  /// The publisher, as a snapshot taken when the change landed.
  final SwalvoParticipant participant;

  /// `camera` or `screenShare`.
  final SwalvoTrackKind kind;
  final SwalvoSubscriptionState state;

  /// `'low'`, `'medium'`, `'high'` or `'off'`: the layer the SFU says it is
  /// forwarding, when it said.
  final String? layer;

  @override
  String toString() => 'SwalvoSubscriptionStateUpdate(${participant.identity}/'
      '${kind.name}: ${state.name}${layer == null ? '' : ', $layer'})';
}

/// @internal Maps the wire protocol's source string onto Swalvo's enum.
SwalvoTrackKind trackKindFromSource(String source) => switch (source) {
      'camera' => SwalvoTrackKind.camera,
      'microphone' => SwalvoTrackKind.microphone,
      'screenShare' => SwalvoTrackKind.screenShare,
      'screenShareAudio' => SwalvoTrackKind.screenShareAudio,
      _ => SwalvoTrackKind.unknown,
    };

/// @internal The renderable half of a track, as a view needs it.
@immutable
class SwalvoRenderableTrack {
  const SwalvoRenderableTrack({
    required this.trackId,
    required this.stream,
    required this.kind,
    this.subscriptionState = SwalvoSubscriptionState.active,
    this.layer,
  });

  final String trackId;
  final rtc.MediaStream stream;
  final SwalvoTrackKind kind;

  /// Whether the SFU is forwarding this track. Always
  /// [SwalvoSubscriptionState.active] for a local track.
  final SwalvoSubscriptionState subscriptionState;

  /// The layer the SFU last said it forwards (`'low'`, `'medium'`,
  /// `'high'` or `'off'`). Null until it says, and for a local track.
  final String? layer;
}

/// A participant in a room.
///
/// A value object built from what the SFU has reported, rather than a
/// wrapper around a client library's participant. It is a snapshot: read
/// it again after a change notification rather than holding one and
/// expecting it to update.
///
/// `identity` is the value your backend put in the token, which is the
/// only participant identifier an application should need to reason
/// about.
@immutable
class SwalvoParticipant {
  const SwalvoParticipant({
    required this.identity,
    required this.isLocal,
    this.metadata,
    this.attributes = const {},
    Map<SwalvoTrackKind, SwalvoRenderableTrack> videoTracks = const {},
    Set<SwalvoTrackKind> liveSources = const {},
    this.isSpeaking = false,
    this.audioLevel = 0,
    this.connectionQuality = SwalvoConnectionQuality.unknown,
    this.agentState,
  })  : _videoTracks = videoTracks,
        _liveSources = liveSources;

  /// An AI voice agent's last reported state (phase6-contracts §4.2), or
  /// null for anyone who is not an agent or has not reported one yet.
  final SwalvoAgentState? agentState;

  /// True for an AI voice agent the platform put in the room (identity
  /// prefix `agent-`, phase6-contracts §1).
  bool get isAgent => identity.startsWith('agent-');

  /// True for the platform's transcription bot (identity prefix
  /// `transcriber-`). It subscribes to audio only and publishes nothing.
  bool get isTranscriber => identity.startsWith('transcriber-');

  /// Whether the SFU currently counts this participant as an active
  /// speaker: a smoothed level above about -50 dBov for at least 200 ms
  /// (phase2-media-contracts §2). Never true while their microphone is
  /// muted. False against a server that does not report speakers.
  final bool isSpeaking;

  /// Their smoothed audio level, 0..1, as the SFU last reported it. Zero
  /// whenever they are not among the active speakers.
  final double audioLevel;

  /// The SFU's score for this participant's connection. See
  /// [SwalvoConnectionQuality].
  final SwalvoConnectionQuality connectionQuality;

  /// The identity your backend minted the token for.
  final String identity;

  /// True for the device this SDK is running on.
  final bool isLocal;

  /// Opaque application metadata (at most 4 KiB): from the token (`md`)
  /// at join, then whatever the server or the participant last set. See
  /// [SwalvoRoom.participantMetadataChanges].
  final String? metadata;

  /// Application key/value attributes: from the token (`attrs`) at join,
  /// then updated live. Empty when none were set.
  final Map<String, String> attributes;

  final Map<SwalvoTrackKind, SwalvoRenderableTrack> _videoTracks;
  final Set<SwalvoTrackKind> _liveSources;

  /// Whether this participant is currently publishing camera video.
  ///
  /// False while muted, which is what a UI wants: a muted camera should
  /// show an avatar, not a frozen last frame.
  bool get isCameraEnabled => _liveSources.contains(SwalvoTrackKind.camera);

  bool get isMicrophoneEnabled =>
      _liveSources.contains(SwalvoTrackKind.microphone);

  bool get isScreenSharing =>
      _liveSources.contains(SwalvoTrackKind.screenShare);

  /// Whether the screen share also carries audio.
  bool get isScreenShareAudioEnabled =>
      _liveSources.contains(SwalvoTrackKind.screenShareAudio);

  /// @internal Used by [SwalvoVideoView] to reach the renderable track.
  /// Not part of the public API: a developer never handles a WebRTC
  /// object, and the doc comment keeps that intent explicit.
  SwalvoRenderableTrack? videoTrackFor(SwalvoTrackKind kind) =>
      _videoTracks[kind];

  /// Identity, and only identity: two snapshots of the same person are
  /// equal however different what they are publishing is. That is what
  /// makes a roster diff stable across a publish — the same person is the
  /// same tile — but it also means `oldParticipant != newParticipant` is
  /// never the test for "have they started a camera". Ask
  /// [isCameraEnabled] or [videoTrackFor] instead; `didUpdateWidget`
  /// guarded on `!=` silently skips exactly the update that matters.
  @override
  bool operator ==(Object other) =>
      other is SwalvoParticipant && other.identity == identity;

  @override
  int get hashCode => identity.hashCode;

  @override
  String toString() =>
      'SwalvoParticipant($identity${isLocal ? ', local' : ''})';
}

/// Which data channel a message travels on.
enum SwalvoDataChannelKind {
  /// Ordered and retransmitted (`raven-data`). The default.
  reliable,

  /// Unordered, no retransmits (`raven-data-lossy`): for cursors, game
  /// state, anything where the latest value wins. At most 1,200 bytes.
  lossy,
}

/// A data message another participant, or the server, sent. See
/// [SwalvoRoom.dataMessages].
@immutable
class SwalvoDataMessage {
  const SwalvoDataMessage({
    required this.payload,
    this.participant,
    this.topic,
  });

  final Uint8List payload;

  /// The sender, as the SFU attests it (never a claim the sender made).
  /// Null for a message from the server, from a legacy client, or from
  /// someone no longer in the roster.
  final SwalvoParticipant? participant;

  /// The topic it was sent on, or null for none.
  final String? topic;

  @override
  String toString() => 'SwalvoDataMessage(${participant?.identity ?? 'server'}'
      '${topic == null ? '' : ', $topic'}, ${payload.length} bytes)';
}

/// The server dropped this device's data messages for going over the
/// per-participant rate limit (100 msg/s and 1 MiB/s reliable, 300 msg/s
/// lossy). See [SwalvoRoom.dataThrottled].
@immutable
class SwalvoDataThrottled {
  const SwalvoDataThrottled(this.channel);

  final SwalvoDataChannelKind channel;

  @override
  String toString() => 'SwalvoDataThrottled(${channel.name})';
}

/// A participant's metadata or attributes changed. See
/// [SwalvoRoom.participantMetadataChanges].
@immutable
class SwalvoParticipantMetadataChanged {
  const SwalvoParticipantMetadataChanged({
    required this.participant,
    required this.previousMetadata,
    required this.previousAttributes,
  });

  /// A snapshot carrying the new values.
  final SwalvoParticipant participant;
  final String? previousMetadata;
  final Map<String, String> previousAttributes;

  @override
  String toString() =>
      'SwalvoParticipantMetadataChanged(${participant.identity})';
}

/// What an AI voice agent is doing (phase6-contracts §4.2).
enum SwalvoAgentState {
  listening,
  thinking,
  speaking,

  /// The agent has stopped (or failed) and is leaving the room.
  ended;

  /// Parses the wire value; null for anything unrecognised.
  static SwalvoAgentState? fromWire(Object? value) {
    for (final state in values) {
      if (state.name == value) return state;
    }
    return null;
  }
}

/// A room transcription's lifecycle (phase6-contracts §4.3).
enum SwalvoTranscriptionStatus {
  starting,
  active,
  stopping,
  ended,
  failed;

  /// Parses the wire value (`STARTING`, `ACTIVE`, ...); null when unknown.
  static SwalvoTranscriptionStatus? fromWire(Object? value) {
    if (value is! String) return null;
    final lower = value.toLowerCase();
    for (final status in values) {
      if (status.name == lower) return status;
    }
    return null;
  }
}

/// One live caption (`transcription.segment`, phase6-contracts §4.1). See
/// [SwalvoRoom.transcriptionSegments].
///
/// Interim segments share a [segmentId] and replace each other; the one
/// with [isFinal] set closes it. A final with an empty [text] means the
/// provider withdrew the interim: clear it and show nothing.
@immutable
class SwalvoTranscriptionSegment {
  const SwalvoTranscriptionSegment({
    required this.transcriptionId,
    this.agentId,
    required this.participantId,
    required this.segmentId,
    required this.text,
    required this.isFinal,
    required this.language,
    required this.startMs,
    required this.endMs,
  });

  /// The transcription it belongs to; null for an agent's own speech
  /// while no transcription is running.
  final String? transcriptionId;

  /// Set when this is an AI agent's own speech.
  final String? agentId;

  /// Identity of whoever was speaking (an agent's identity for its speech).
  final String participantId;
  final String segmentId;
  final String text;

  /// The wire `final` flag.
  final bool isFinal;
  final String language;

  /// Relative to the transcription's start.
  final int startMs;
  final int endMs;

  /// Parses a `transcription.segment` frame; null when malformed.
  static SwalvoTranscriptionSegment? fromJson(Map<String, dynamic> json) {
    final participantId = json['participantId'];
    final segmentId = json['segmentId'];
    final text = json['text'];
    final isFinal = json['final'];
    if (participantId is! String ||
        participantId.isEmpty ||
        segmentId is! String ||
        segmentId.isEmpty ||
        text is! String ||
        isFinal is! bool) {
      return null;
    }
    final transcriptionId = json['transcriptionId'];
    final agentId = json['agentId'];
    final language = json['language'];
    final startMs = json['startMs'];
    final endMs = json['endMs'];
    return SwalvoTranscriptionSegment(
      transcriptionId: transcriptionId is String ? transcriptionId : null,
      agentId: agentId is String ? agentId : null,
      participantId: participantId,
      segmentId: segmentId,
      text: text,
      isFinal: isFinal,
      language: language is String ? language : '',
      startMs: startMs is num ? startMs.toInt() : 0,
      endMs: endMs is num ? endMs.toInt() : 0,
    );
  }

  @override
  String toString() => 'SwalvoTranscriptionSegment($participantId, $segmentId'
      '${isFinal ? ', final' : ''}: $text)';
}

/// A room transcription changed status (`transcription.state`,
/// phase6-contracts §4.3). See [SwalvoRoom.transcriptionStateChanges].
@immutable
class SwalvoTranscriptionState {
  const SwalvoTranscriptionState({
    required this.transcriptionId,
    required this.status,
    required this.language,
  });

  final String transcriptionId;
  final SwalvoTranscriptionStatus status;
  final String language;

  /// Whether captions are flowing (status `ACTIVE`).
  bool get isActive => status == SwalvoTranscriptionStatus.active;

  /// Parses a `transcription.state` frame; null when malformed.
  static SwalvoTranscriptionState? fromJson(Map<String, dynamic> json) {
    final id = json['transcriptionId'];
    final status = SwalvoTranscriptionStatus.fromWire(json['status']);
    if (id is! String || id.isEmpty || status == null) return null;
    final language = json['language'];
    return SwalvoTranscriptionState(
      transcriptionId: id,
      status: status,
      language: language is String ? language : '',
    );
  }

  @override
  String toString() =>
      'SwalvoTranscriptionState($transcriptionId, ${status.name})';
}

/// An AI agent changed state (`agent.state`, phase6-contracts §4.2). See
/// [SwalvoRoom.agentStateChanges].
@immutable
class SwalvoAgentStateChanged {
  const SwalvoAgentStateChanged(this.participant, this.state);

  /// A snapshot of the agent participant, [SwalvoParticipant.agentState]
  /// already set to [state].
  final SwalvoParticipant participant;
  final SwalvoAgentState state;

  @override
  String toString() =>
      'SwalvoAgentStateChanged(${participant.identity}, ${state.name})';
}
