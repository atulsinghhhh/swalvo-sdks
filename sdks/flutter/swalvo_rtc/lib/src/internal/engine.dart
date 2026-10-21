import 'dart:async';
import 'dart:developer' as developer;
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;

import '../errors.dart';
import '../types.dart';
import 'data_envelope.dart';
import 'e2ee_controller.dart';
import 'protocol.dart';
import 'signaling_client.dart';

/// The data-channel label. Must match the SFU's, which closes a channel it
/// does not recognise rather than silently dropping messages on it.
// legacy: the raven-* labels and protocol id are wire contracts, kept as-is.
const _dataChannelLabel = 'raven-data';

/// The lossy data channel (phase7-contracts §1.1): unordered, no
/// retransmits. Only opened against a server advertising `data.v2`; an
/// older SFU closes a label it does not know.
const _lossyDataChannelLabel = 'raven-data-lossy';

/// The RTCDataChannel `protocol` set on both channels (phase7-contracts
/// §1.1). It tells the SFU this client reads the `0x52 0x03` delivery
/// framing; without it the SFU sends bare payloads, as to an old SDK.
const dataChannelProtocol = 'raven.v2';

/// Sources whose track is audio. Everything else is video.
bool isAudioSource(String source) =>
    source == 'microphone' || source == 'screenShareAudio';

/// Simulcast ladder for a published camera (spec §15).
///
/// Three spatial layers, each a quarter of the previous one's pixel count
///: the standard ladder, and the one native WebRTC implements well.
///
/// The RIDs are load-bearing, not labels. They travel in an RTP header
/// extension on every packet, and the SFU maps them straight onto its own
/// layer names (`services/sfu/internal/room/downtrack.go`, `layerFromRID`).
/// An RID that does not reach the wire is a layer the SFU cannot offer
/// anyone.
///
/// `low` is capped at 15fps: at a quarter width it is feeding a thumbnail,
/// where halving the frame rate is invisible and halves the bitrate again.
/// The SVC mode a VP9/AV1 camera publishes (phase5-contracts §2.2).
const svcScalabilityMode = 'L3T3_KEY';

/// One SVC encoding carries all three spatial layers: the ladder's budget.
const svcMaxBitrate = 1700000;

const simulcastEncodings = <SimulcastLayerSpec>[
  SimulcastLayerSpec(
      rid: 'low',
      scaleResolutionDownBy: 4.0,
      maxBitrate: 150000,
      maxFramerate: 15),
  SimulcastLayerSpec(
      rid: 'medium',
      scaleResolutionDownBy: 2.0,
      maxBitrate: 500000,
      maxFramerate: 30),
  SimulcastLayerSpec(
      rid: 'high',
      scaleResolutionDownBy: 1.0,
      maxBitrate: 1500000,
      maxFramerate: 30),
];

/// One rung of the ladder.
class SimulcastLayerSpec {
  const SimulcastLayerSpec({
    required this.rid,
    required this.scaleResolutionDownBy,
    required this.maxBitrate,
    required this.maxFramerate,
  });

  final String rid;
  final double scaleResolutionDownBy;
  final int maxBitrate;
  final int maxFramerate;

  rtc.RTCRtpEncoding toEncoding() => rtc.RTCRtpEncoding(
        rid: rid,
        scaleResolutionDownBy: scaleResolutionDownBy,
        maxBitrate: maxBitrate,
        maxFramerate: maxFramerate,
      );
}

/// Sources that publish a simulcast ladder.
///
/// A microphone has no spatial layering to do and Opus manages its own
/// bitrate. A screen share is left at one high-quality layer on purpose:
/// the content is usually text, and dropping resolution wrecks legibility
/// in a way it never does for a face.
bool sourceUsesSimulcast(String source) => source == 'camera';

/// One track this participant is receiving.
class SubscribedTrack {
  SubscribedTrack({
    required this.participantId,
    required this.trackId,
    required this.source,
    required this.track,
    required this.stream,
    required this.muted,
    this.kind = 'video',
    this.subscriptionState = SwalvoSubscriptionState.active,
    this.layer,
  });

  final String participantId;
  final String trackId;
  final String source;
  final rtc.MediaStreamTrack track;
  final rtc.MediaStream stream;
  bool muted;

  /// `'audio'` or `'video'`, as the server announced it.
  final String kind;

  /// What the SFU last said about forwarding this track
  /// (phase2-media-contracts §4).
  SwalvoSubscriptionState subscriptionState;

  /// The layer it said it forwards: `low`, `medium`, `high` or `off`.
  String? layer;
}

/// One track this device is publishing.
class PublishedTrack {
  PublishedTrack({
    required this.source,
    required this.track,
    required this.stream,
    required this.sender,
  });

  final String source;
  rtc.MediaStreamTrack track;
  final rtc.MediaStream stream;
  final rtc.RTCRtpSender sender;
  bool muted = false;

  /// Whether the simulcast ladder this source asked for is genuinely on
  /// the sender. Read back from the platform after negotiation — never
  /// assumed from what was requested. See [SwalvoSimulcastStatus].
  SwalvoSimulcastStatus simulcast = SwalvoSimulcastStatus.notApplicable;

  /// Which of this sender's encodings the SFU last said someone wants, by
  /// RID (`publisher.layers`, phase2-media-contracts §5). Null until it
  /// says. Belongs to this sender: a new sender (a republish after a
  /// reconnect) is a new [PublishedTrack] and starts from all-active.
  Map<String, bool>? desiredLayers;

  /// Serializes `setParameters` calls on [sender]. Two in flight at once
  /// would each read the same cached parameters and the second would
  /// undo the first.
  Future<void> layerChain = Future<void>.value();
}

/// Drives the peer connection against Swalvo's signaling.
///
/// # Negotiation
///
/// The SFU offers, this answers. That holds even for publishing: a track
/// is added and the SFU's next offer carries it: except on the first
/// publish of a kind, where there is no transceiver yet and a
/// client-initiated offer is unavoidable. The server resolves the
/// resulting glare by refusing the client's offer with a retryable code,
/// and [_negotiatePublish] retries once the server's offer is answered.
///
/// # What this replaced
///
/// `livekit_client` owned all of this. The engine exists because Swalvo's
/// SFU speaks Swalvo's protocol, and because that is the whole point of
/// the migration: no client library sits between the app and the media
/// plane, so the media plane can change without an SDK release.
class SwalvoEngine {
  SwalvoEngine({
    required this.signaling,
    required this.iceServers,
    required this.adaptiveStream,
    this.localIdentity = '',
    SwalvoGrants? initialGrants,
    this.autoSubscribe = true,
    this.dynacast = true,
    this.e2ee,
    this.e2eeUnsupported = false,
    this.roomId = '',
    bool roomRequiresE2EE = false,
    this.audioRed = true,
    this.videoCodec,
  })  : _grants = initialGrants,
        _roomE2EE = roomRequiresE2EE;

  // -------------------------------------------------------------------
  // Phase 5: E2EE, RED, codec/SVC (docs/architecture/phase5-contracts.md)
  // -------------------------------------------------------------------

  /// The connection's frame-cryptor wiring; null without `Swalvo(e2ee:)`.
  final E2EEController? e2ee;

  /// `Swalvo(e2ee:)` was given but this platform cannot encrypt (web).
  final bool e2eeUnsupported;

  /// The token's `rid`: the room id the shared passphrase is salted with.
  final String roomId;

  /// Offer Opus with RED (`audio/red`) first. Off while E2EE is configured.
  final bool audioRed;

  /// `'vp8'`, `'h264'`, `'vp9'` or `'av1'` (SVC for the last two).
  final String? videoCodec;

  bool _roomE2EE;

  /// Whether the room is end-to-end encrypted (token claim or `room.joined`).
  bool get roomRequiresE2EE => _roomE2EE;

  /// Whether this device is encrypting what it sends.
  bool get isE2EEActive => _roomE2EE && e2ee != null;

  /// Receivers by remote track id, until the subscription completes and
  /// its participant (whose key decrypts it) is known.
  final _receivers = <String, rtc.RTCRtpReceiver>{};

  /// Set once the platform refuses an SVC encoding, so later publishes go
  /// straight to simulcast.
  bool _svcRefused = false;

  /// Throws instead of publishing plaintext into an E2EE room (§3.1).
  void assertMayPublish() {
    if (!_roomE2EE || e2ee != null) return;
    if (e2eeUnsupported) {
      throw const SwalvoException(
        SwalvoErrorCode.e2eeNotSupported,
        'This room is end-to-end encrypted and this platform cannot encrypt media (Flutter Web).',
      );
    }
    throw const SwalvoException(
      SwalvoErrorCode.e2eeRequired,
      'This room is end-to-end encrypted: pass Swalvo(e2ee: SwalvoE2EEOptions(...)) to publish into it.',
    );
  }

  void _applyRoomE2EE(JoinedPayload payload) {
    _roomE2EE = _roomE2EE || payload.e2ee;
    final controller = e2ee;
    if (controller == null) {
      if (_roomE2EE) {
        developer.log(
          'this room is end-to-end encrypted and no e2ee key provider is configured; publishing is disabled',
          name: 'swalvo_rtc',
          level: 900,
        );
      }
      return;
    }
    unawaited(controller
        .start(
            roomId: roomId.isEmpty ? payload.roomId : roomId,
            localIdentity: localIdentity,
            enabled: _roomE2EE)
        .catchError((Object error) {
      developer.log('could not load the e2ee keys',
          name: 'swalvo_rtc', level: 1000, error: error);
    }));
  }

  /// The camera codec this platform can honour: VP9/AV1 need SVC, and fall
  /// back to VP8 simulcast without it.
  String? get _effectiveVideoCodec {
    final codec = videoCodec;
    if ((codec == 'vp9' || codec == 'av1') && _svcRefused) return 'vp8';
    return codec;
  }

  Future<List<rtc.RTCRtpCodecCapability>?> _codecsPreferring(
      String kind, String mimeType) async {
    try {
      final caps = await rtc.getRtpSenderCapabilities(kind);
      final codecs = caps.codecs ?? const <rtc.RTCRtpCodecCapability>[];
      final wanted = mimeType.toLowerCase();
      final first =
          codecs.where((c) => c.mimeType.toLowerCase() == wanted).toList();
      if (first.isEmpty) return null;
      return [
        ...first,
        ...codecs.where((c) => c.mimeType.toLowerCase() != wanted)
      ];
    } catch (_) {
      return null;
    }
  }

  /// Best effort: a platform without the codec or without
  /// `setCodecPreferences` publishes with its own order.
  Future<void> _preferCodec(
      rtc.RTCRtpTransceiver transceiver, String kind, String mimeType) async {
    final ordered = await _codecsPreferring(kind, mimeType);
    if (ordered == null) return;
    try {
      await transceiver.setCodecPreferences(ordered);
    } catch (error) {
      developer.log('setCodecPreferences($mimeType) failed',
          name: 'swalvo_rtc', level: 800, error: error);
    }
  }

  /// RED first for a microphone, the configured codec first for video.
  Future<void> _applyCodecPreferences(
      rtc.RTCPeerConnection pc, rtc.RTCRtpSender sender, String source) async {
    final wantsRed = source == 'microphone' && audioRed && e2ee == null;
    final codec = isAudioSource(source) ? null : _effectiveVideoCodec;
    if (!wantsRed && codec == null) return;
    rtc.RTCRtpTransceiver? transceiver;
    try {
      final transceivers = await pc.getTransceivers();
      for (final candidate in transceivers) {
        if (candidate.sender.senderId == sender.senderId) {
          transceiver = candidate;
        }
      }
    } catch (_) {
      return;
    }
    if (transceiver == null) return;
    if (wantsRed) {
      await _preferCodec(transceiver, 'audio', 'audio/red');
    } else if (codec != null) {
      await _preferCodec(transceiver, 'video', 'video/$codec');
    }
  }

  /// Whether the join asked for video to be forwarded from the start
  /// (phase2-media-contracts §4). When false, every video subscription
  /// starts `paused_client` and stays so until a layer is requested for
  /// it — which a [SwalvoVideoView] does by being laid out.
  final bool autoSubscribe;

  /// Whether `publisher.layers` is honoured: encodings no subscriber wants
  /// are switched off on the sender, saving this device the CPU and
  /// uplink of encoding them. Off means every layer is always sent, which
  /// is what happens against a server that never sends the message.
  final bool dynacast;

  /// This device's participant identity, to recognise server messages
  /// about itself (a server mute, §1.6).
  final String localIdentity;

  SwalvoGrants? _grants;

  /// What this participant may do: the token's grants, then whatever the
  /// server last pushed (phase1-contracts §1.4).
  SwalvoGrants? get grants => _grants;

  final _grantChanges = StreamController<SwalvoGrants>.broadcast();
  final _serverMutes = StreamController<String>.broadcast();

  /// Fires when the server changes this participant's permissions.
  Stream<SwalvoGrants> get grantChanges => _grantChanges.stream;

  /// Sources (`'camera'`, `'microphone'`, …) the server muted (§1.6).
  Stream<String> get serverMutes => _serverMutes.stream;

  /// Publications that belonged to a peer connection a reset discarded,
  /// waiting for [republishAfterRebuild] to put them on the next one.
  bool _republishPending = false;

  /// Media-only rejoins since the media connection was last connected.
  int _mediaRejoinAttempts = 0;
  Timer? _mediaRejoinTimer;
  static const _mediaRejoinMaxAttempts = 5;

  final SignalingClient signaling;
  final List<Map<String, dynamic>> iceServers;

  /// When true, subscriptions follow the size a view is actually showing.
  ///
  /// Implemented by [requestLayer], which [SwalvoVideoView] calls as it
  /// lays out. On a phone this is the difference between decoding a 1080p
  /// stream into a thumbnail and decoding a thumbnail.
  final bool adaptiveStream;

  rtc.RTCPeerConnection? _pc;
  rtc.RTCDataChannel? _dataChannel;
  rtc.RTCDataChannel? _lossyChannel;

  /// Whether the server advertised `data.v2` in its last `room.joined`.
  bool _supportsDataV2 = false;

  /// Whether the "lossy is not supported here" warning was logged.
  bool _lossyFallbackWarned = false;

  /// Whether the server supports data messages v2 (topics, targeting,
  /// sender attribution, the lossy channel).
  bool get supportsDataV2 => _supportsDataV2;
  StreamSubscription<Map<String, dynamic>>? _messages;
  StreamSubscription<SignalingLifecycle>? _lifecycle;

  final _subscribed = <String, SubscribedTrack>{};
  final _published = <String, PublishedTrack>{};
  final _announced = <String, ServerTrack>{};
  final _announcedOwners = <String, String>{};
  final _pendingMedia =
      <String, ({rtc.MediaStreamTrack track, rtc.MediaStream stream})>{};
  final _deferredPublishes = <Future<void> Function()>[];

  /// Transceivers this engine created for a simulcast source, by source.
  ///
  /// Only ever holds a *live* one: [unpublish] stops the transceiver and
  /// drops it from here. Reviving a parked transceiver with `replaceTrack`
  /// kept its SSRCs and msid, so the SFU never saw a new incoming track and
  /// every subscriber silently lost the camera after a disable/enable cycle.
  /// A stopped transceiver's m-section is recycled by the next
  /// `addTransceiver`, so toggling does not grow the SDP either. Cleared
  /// with the peer connection in [_createPeerConnection]: a transceiver
  /// belongs to one connection and a reconnect builds a new one.
  final _simulcastTransceivers = <String, rtc.RTCRtpTransceiver>{};

  /// Layers an application pinned explicitly, keyed by `participantId/trackId`.
  ///
  /// Adaptive streaming never overrides one of these. See [requestLayer] for
  /// the precedence rules and how a pin is released.
  final _pinnedLayers = <String, String>{};

  /// The layer last *sent* for a subscription, keyed the same way.
  ///
  /// Purely to avoid re-sending a preference the SFU already has. A tile
  /// being laid out repeatedly at the same size is the normal case, not the
  /// exception, and every redundant message is one closer to the
  /// connection's rate limit.
  final _sentLayers = <String, String>{};

  /// Subscriptions the application paused with [setVideoEnabled], keyed
  /// like [_pinnedLayers]. Application intent, so it survives a reconnect
  /// the way a pin does.
  final _disabledVideo = <String>{};

  /// The layer adaptive streaming last chose from a view's size, keyed
  /// like [_pinnedLayers]. Recorded even while a pin holds the track, so
  /// releasing the pin goes straight back to the right size instead of to
  /// whatever the SFU picks.
  final _adaptiveLayers = <String, String>{};

  /// Per subscription, each registered view and whether it is visible.
  /// A subscription no view ever registered for is not considered hidden:
  /// nothing has said anything about it.
  final _viewVisibility = <String, Map<Object, bool>>{};

  /// Subscriptions whose views have been hidden for longer than
  /// [_hideDelay], and so are asking for `off`.
  final _hiddenVideo = <String>{};
  final _hideTimers = <String, Timer>{};

  /// How long every view of a track must stay hidden before its video is
  /// paused. Long enough that scrolling a tile past the edge of a list, or
  /// a route transition rebuilding the view, does not pause and resume it;
  /// short enough that a minimised call stops costing data within a second.
  /// Showing a view again resumes it at once.
  static const hideDelay = Duration(milliseconds: 500);

  /// Subscription states that arrived before their track did, keyed like
  /// [_subscribed]. Applied, silently, when the subscription completes.
  final _pendingSubscriptionStates =
      <String, ({SwalvoSubscriptionState state, String? layer})>{};

  /// Active speakers as the SFU last listed them, loudest first, with
  /// their levels (phase2-media-contracts §2).
  final _speakers = <String, double>{};

  /// Connection quality by participant id, local participant included.
  final _qualities = <String, SwalvoConnectionQuality>{};

  final _speakerEvents = StreamController<
      ({List<String> speakers, Set<String> changed})>.broadcast();
  final _qualityEvents = StreamController<List<String>>.broadcast();
  final _subscriptionStateEvents =
      StreamController<({String participantId, String trackId})>.broadcast();

  /// Completes once the SFU's first offer for the *current* peer connection
  /// generation has been answered (see [_handleOffer]).
  ///
  /// [publish] awaits this before ever calling [_negotiatePublish]. Without
  /// it, `enableCamera()`/`enableMicrophone()` called right after joining
  /// can call [_ensurePeerConnection] and offer before the SFU's own
  /// join-time offer has even been read off the socket — a race
  /// `pc.getSignalingState()` cannot see, because a peer connection that
  /// has not touched a description at all is `stable` too. This closes
  /// that half of the race deterministically: no timer, no polling, just
  /// awaiting the one event that has to happen anyway.
  ///
  /// Recreated in [_createPeerConnection] for every new generation ([
  /// _pcGeneration]), so a reconnect's fresh peer connection gets its own
  /// barrier instead of resolving instantly off the previous connection's.
  Completer<void> _initialOfferHandled = Completer<void>();

  /// Whether this negotiation round has already used its one immediate,
  /// no-inbound-message-required retry after a [SignalingErrorCode.
  /// negotiationGlare] response — see the `ServerMessageType.error` case in
  /// [_handleMessage].
  ///
  /// Bounded to one attempt per round on purpose. The SFU's glare
  /// rejection is a plain refusal, not a state change — retrying while its
  /// `offerInFlight` guard is still set (see services/sfu's
  /// `Participant.beginNegotiation`) glares again, and retrying *that*
  /// immediately too would reproduce the exact failure packages/sdk's own
  /// history warns about: an unbounded offer/rollback storm that trips the
  /// connection's message rate limit. One immediate attempt costs at most
  /// one extra round trip and resolves the common case (the SFU's answer
  /// processing was merely a little behind); if the round is genuinely
  /// stuck, this falls back to the existing, already-tested recovery via
  /// [_handleOffer]/[_handleAnswer] — or, failing that, the SFU's own
  /// retry once it abandons its stale offer.
  ///
  /// Reset at the start of [_handleOffer] and [_handleAnswer]: a real
  /// round trip completing is what earns the next glare a fresh attempt.
  bool _glareRecoveryAttempted = false;

  /// Serializes every operation that can change [_pc]'s `signalingState` —
  /// our own offers, the SFU's offers, its answers to ours — so an async
  /// gap inside one can never let another run against a signalingState it
  /// didn't expect to find.
  ///
  /// `signaling.messages.listen` in [start] dispatches each message via
  /// `unawaited(_handleMessage(...))`, so without this, an offer and an
  /// answer (or two offers) arriving back to back could interleave here.
  /// packages/sdk avoids the equivalent race by coalescing everything
  /// behind the browser's `onnegotiationneeded` event; flutter_webrtc's
  /// native platform channel exposes no such event (only its web backend
  /// does — see dart_webrtc's `onRenegotiationNeeded`), so this package
  /// cannot rely on it without behaving differently per platform. A plain
  /// FIFO chain gets the same guarantee everywhere `SwalvoEngine` runs.
  ///
  /// Only entry points reached from *outside* an already-serialized task
  /// go through this ([_handleMessage]'s offer/answer/glare-error cases,
  /// and [publish]/[unpublish]). [_flushDeferredPublishes] calls
  /// [_negotiatePublish] directly, never wrapped again: it only ever runs
  /// from inside [_handleOffer], [_handleAnswer], or [_recoverFromGlare],
  /// which are themselves already the chain's current task, and
  /// re-wrapping there would queue behind a task waiting on that very
  /// call — a deadlock.
  Future<void> _negotiationChain = Future<void>.value();

  Future<T> _serialized<T>(Future<T> Function() operation) {
    final result = _negotiationChain.then((_) => operation());
    // Chained regardless of outcome: a failed round must not wedge every
    // negotiation after it, and the caller still observes the failure
    // through the Future `result` itself.
    _negotiationChain = result.then((_) {}, onError: (_) {});
    return result;
  }

  final _changes = StreamController<void>.broadcast();
  final _errors = StreamController<SwalvoException>.broadcast();
  final _data = StreamController<DecodedDataMessage>.broadcast();

  /// Callers of [sendData] and [ensureDataChannel] waiting for the data
  /// channel to open. Settled together, in [_attachDataChannel], once it
  /// does; failed together on a terminal signaling failure ([_abortDataChannelWaiters]).
  final _dataChannelWaiters = <Completer<void>>[];
  final _lossyChannelWaiters = <Completer<void>>[];

  String? _remoteIceState;
  String? _remotePeerState;
  bool _disposed = false;

  final _mediaStates = StreamController<SwalvoMediaState>.broadcast();
  SwalvoMediaState _mediaState = SwalvoMediaState.idle;

  /// Whether the media transport can actually carry packets, as the peer
  /// connection itself reports it — never inferred from signaling.
  SwalvoMediaState get mediaState => _mediaState;

  /// Changes to [mediaState]. Broadcast, and only fires on a transition.
  Stream<SwalvoMediaState> get mediaStates => _mediaStates.stream;

  /// Fires whenever the track or participant set changed.
  Stream<void> get changes => _changes.stream;

  /// Failures that arrive asynchronously instead of from a call.
  Stream<SwalvoException> get errors => _errors.stream;

  /// Messages that arrived on either data channel, decoded
  /// (phase7-contracts §1.3).
  Stream<DecodedDataMessage> get data => _data.stream;

  Iterable<SubscribedTrack> get subscribedTracks => _subscribed.values;

  /// Participant ids the SFU counts as speaking, loudest first.
  List<String> get activeSpeakerIds => List.unmodifiable(_speakers.keys);

  /// A participant's last reported level, 0 when not speaking.
  double audioLevelOf(String participantId) => _speakers[participantId] ?? 0;

  bool isSpeaking(String participantId) => _speakers.containsKey(participantId);

  SwalvoConnectionQuality qualityOf(String participantId) =>
      _qualities[participantId] ?? SwalvoConnectionQuality.unknown;

  /// Fires on every `speakers.changed`: the new ordered list, and the ids
  /// whose speaking state flipped.
  Stream<({List<String> speakers, Set<String> changed})> get speakerEvents =>
      _speakerEvents.stream;

  /// Ids whose connection quality changed, per `quality.changed`.
  Stream<List<String>> get qualityEvents => _qualityEvents.stream;

  /// A subscription's forwarding state changed.
  Stream<({String participantId, String trackId})>
      get subscriptionStateEvents => _subscriptionStateEvents.stream;
  Iterable<PublishedTrack> get publishedTracks => _published.values;

  /// The SFU's own view of this connection, which can disagree with the
  /// local one, and that disagreement is often the whole diagnosis.
  ({String? iceState, String? peerState}) get remoteConnectionState =>
      (iceState: _remoteIceState, peerState: _remotePeerState);

  String? get iceConnectionState => _pc?.iceConnectionState?.name;
  String? get signalingState => _pc?.signalingState?.name;

  /// Starts consuming signaling.
  ///
  /// Called from [SwalvoRoom.attach], before [signaling] is asked to
  /// connect — not after the join completes. Subscribing only once
  /// already joined is what used to drop the SFU's `sdp.offer`: it and
  /// `room.joined` race the instant the join resolves, and a broadcast
  /// stream with no listener yet simply loses whatever is added to it.
  void start() {
    _messages = signaling.messages.listen((message) {
      unawaited(_handleMessage(message));
    });
    _lifecycle = signaling.lifecycle.listen((state) {
      switch (state) {
        case SignalingFailed(:final error):
          _clearRoomSignals();
          _abortDataChannelWaiters(error);
        case SignalingClosed():
          _clearRoomSignals();
          _abortDataChannelWaiters(const SwalvoException(
            SwalvoErrorCode.connectionFailed,
            'The connection closed before the data channel could open.',
          ));
        case SignalingReconnecting():
          // Not aborted: rejoining recreates the channel and settles the
          // wait normally. See _abortDataChannelWaiters.
          break;
        case SignalingEnded():
          _clearRoomSignals();
          _abortDataChannelWaiters(const SwalvoException(
            SwalvoErrorCode.connectionFailed,
            'The session was ended by the server before the data channel could open.',
          ));
      }
    });
  }

  /// Applies the room state reported at join.
  ///
  /// Called on the first join and after every reconnect. On a reconnect
  /// the reported set is authoritative, so tracks nobody is publishing any
  /// more are dropped, not lingering.
  ///
  /// A late joiner's own `onTrack` for an already-live publisher's media
  /// can fire before this runs — `room.joined` and the SFU's join-time
  /// offer arrive close together, and nothing orders "the roster's own
  /// announcements landed" ahead of "the peer connection's tracks
  /// arrived" the way [_announceTrack] is ordered relative to a *later*
  /// publish. Without draining [_pendingMedia] here the way
  /// [_announceTrack] already does, a track parked before this call ran
  /// never gets a second chance: nothing else was ever going to announce
  /// it again, so it sits there forever and that participant's media
  /// never completes subscribing.
  void applyJoinedState(JoinedPayload payload) {
    _applyRoomE2EE(payload);
    _supportsDataV2 = payload.capabilities.contains(dataV2Capability);
    if (_supportsDataV2 && _mayOpenDataChannels) {
      // v2 SDKs open both channels at connect (phase7-contracts §1.1), so
      // the SFU marks this recipient v2-capable before anything is sent.
      // A no-op when a resumed session kept them. Only with publishData:
      // opening a channel is an offer, which the API refuses (failing the
      // connection) for a participant that may neither publish nor
      // publishData, e.g. a live-stream viewer.
      unawaited(ensureDataChannel().catchError((Object error) {
        developer.log('could not open the data channels at join',
            name: 'swalvo_rtc', level: 900, error: error);
      }));
    }
    final present = <String>{};
    for (final participant in payload.participants) {
      for (final track in participant.tracks) {
        final key = _key(participant.id, track.trackId);
        present.add(key);
        _announced[key] = track;
        _announcedOwners[key] = participant.id;

        final pending = _pendingMedia.remove(track.trackId);
        if (pending != null) {
          _completeSubscription(
              participant.id, track, pending.track, pending.stream);
        }
      }
    }

    _announced.removeWhere((key, _) => !present.contains(key));
    _announcedOwners.removeWhere((key, _) => !present.contains(key));
    _subscribed.removeWhere((key, _) => !present.contains(key));
    _notify();
  }

  Future<void> _handleMessage(Map<String, dynamic> message) async {
    if (_disposed) return;

    switch (message['type']) {
      case ServerMessageType.sdpOffer:
        await _serialized(() => _handleOffer(message['sdp'] as String? ?? ''));
      case ServerMessageType.sdpAnswer:
        await _serialized(() => _handleAnswer(message['sdp'] as String? ?? ''));
      case ServerMessageType.iceCandidate:
        await _handleRemoteCandidate(IceCandidatePayload.fromJson(message));
      case ServerMessageType.trackPublished:
        _announceTrack(
          message['participantId'] as String? ?? '',
          ServerTrack.fromJson(
              (message['track'] as Map<String, dynamic>?) ?? const {}),
        );
      case ServerMessageType.trackUnpublished:
        _unannounceTrack(
          message['participantId'] as String? ?? '',
          message['trackId'] as String? ?? '',
        );
      case ServerMessageType.participantPermissionsUpdated:
        final permissions =
            (message['permissions'] as Map<String, dynamic>?) ?? const {};
        // `updateOwnMetadata` is a token grant the live update may not
        // carry; absent means unchanged, not withdrawn.
        await _applyGrants(SwalvoGrants.fromJson({
          if (!permissions.containsKey('updateOwnMetadata'))
            'updateOwnMetadata': _grants?.updateOwnMetadata ?? false,
          ...permissions,
        }));
      case ServerMessageType.trackMuted
          when message['byServer'] == true &&
              localIdentity.isNotEmpty &&
              message['participantId'] == localIdentity:
        await _applyServerMute(message['trackId'] as String? ?? '');
      case ServerMessageType.trackMuted:
      case ServerMessageType.trackUnmuted:
        _setRemoteMuted(
          message['participantId'] as String? ?? '',
          message['trackId'] as String? ?? '',
          message['type'] == ServerMessageType.trackMuted,
        );
      case ServerMessageType.connectionState:
        _remoteIceState = message['iceState'] as String?;
        _remotePeerState = message['peerState'] as String?;
      case ServerMessageType.speakersChanged:
        _applySpeakers(parseSpeakers(message));
      case ServerMessageType.qualityChanged:
        _applyQuality(parseQualityUpdates(message));
      case ServerMessageType.subscriptionState:
        final update = parseSubscriptionState(message);
        if (update != null) {
          _applySubscriptionState(update.publisherId, update.trackId,
              subscriptionStateFromWire(update.state)!, update.layer);
        }
      case ServerMessageType.publisherLayers:
        final update = parsePublisherLayers(message);
        if (update != null) {
          _applyPublisherLayers(update.trackId, update.layers);
        }
      case ServerMessageType.error:
        final code = message['code'] as String? ?? '';
        if (code == SignalingErrorCode.negotiationGlare) {
          // Genuine glare: the SFU refused our offer because its own is
          // already on the way (services/sfu's AcceptOffer — "our offer
          // stands, the client retries once it has answered it"). The
          // refused offer described real local state (a track just
          // published, most often), so it must not simply be dropped, or
          // that track sits on the peer connection forever undeclared to
          // the server: exactly what left publishers showing camera/mic
          // as unpublished despite a successful-looking `publish()` call.
          //
          // Requeued through the same path a publish takes when it finds
          // the peer connection already mid-round, so it is still covered
          // if [_handleOffer]/[_handleAnswer] is what ends up flushing it
          // — the SFU's own offer, the one this glare made way for, is the
          // normal, expected way this resolves.
          _deferredPublishes.add(_negotiatePublish);
          // But that offer is not guaranteed to arrive promptly: a live
          // trace showed the SFU's *own* AcceptAnswer for our join-time
          // answer stall for the full 15s answerTimeout before it retried
          // on its own, during which nothing else was ever going to flush
          // this queue. One immediate, bounded retry — see
          // [_glareRecoveryAttempted] for why it is bounded — gives this
          // round a free chance to resolve in well under that, without
          // waiting on any inbound message at all.
          await _serialized(_recoverFromGlare);
          return;
        }
        _errors.add(SwalvoException(
          SwalvoErrorCode.signalingError,
          message['message'] as String? ?? 'The RTC server reported an error.',
        ));
    }
  }

  /// Rolls our glare-refused offer back and, once only, retries whatever
  /// is deferred behind it right away — see [_glareRecoveryAttempted].
  ///
  /// Safe to call whether or not our own offer is actually still
  /// outstanding: [_handleOffer] may already have rolled it back if the
  /// SFU's offer won the race to arrive first, in which case this is a
  /// no-op past the state check and [_flushDeferredPublishes] finds
  /// nothing left to do.
  Future<void> _recoverFromGlare() async {
    if (_glareRecoveryAttempted) {
      // Already spent this round's one attempt; wait for a real round
      // trip ([_handleOffer]/[_handleAnswer]) to earn another, exactly as
      // before this method existed.
      return;
    }
    _glareRecoveryAttempted = true;

    final pc = _pc;
    if (pc == null) return;
    try {
      // Live read, same reasoning as [_handleOffer]'s: the platform's
      // cached signalingState getter can lag the setLocalDescription(offer)
      // call that just glared.
      final state = await pc.getSignalingState();
      if (state == rtc.RTCSignalingState.RTCSignalingStateHaveLocalOffer) {
        try {
          // Same wire form as _handleOffer's rollback — flutter_webrtc has
          // no dedicated rollback call.
          await pc
              .setLocalDescription(rtc.RTCSessionDescription('', 'rollback'));
        } catch (error) {
          // Best-effort, same as _handleOffer: the retry offer below
          // performs an implicit rollback on platforms where an explicit
          // one fails.
        }
      }
    } catch (error) {
      // A failed live-state read leaves the offer in whatever state it
      // was in; _flushDeferredPublishes below still gets a chance to run,
      // and _negotiatePublish's own state check protects it either way.
    }

    await _flushDeferredPublishes();
  }

  // -------------------------------------------------------------------
  // Peer connection
  // -------------------------------------------------------------------

  /// The in-flight creation, while one is running; cleared once it
  /// settles, successfully or not, so the next caller that finds [_pc]
  /// still null starts a fresh attempt instead of joining a dead one.
  ///
  /// Without this, [_ensurePeerConnection] is a classic check-then-await
  /// race: two callers can both read [_pc] as null before either's
  /// `createPeerConnection()` resolves, and both proceed to create one.
  /// Whichever finishes last silently wins `_pc = pc`; the other's
  /// connection is now orphaned, but its caller still holds a reference
  /// to it and keeps negotiating on it as if it were live. The SFU only
  /// expects one session per participant, so from its side this looks
  /// like a confused peer sending two overlapping SDP/ICE exchanges for
  /// the same participant, and whichever one it ends up tracking is not
  /// guaranteed to be the one this engine kept as [_pc] — `onTrack`
  /// on the connection that lost gets attached, but frequently never
  /// fires, since the SFU never completed a real ICE/DTLS session with
  /// it. This is exactly the shape of race a participant hits by
  /// joining an already-live room and publishing right away: the SFU's
  /// join-time offer (needing a peer connection to answer on) and this
  /// device's own `publish()` (needing one to add a track to) both reach
  /// [_ensurePeerConnection] within the same span of microtasks.
  Future<rtc.RTCPeerConnection>? _pcCreating;

  /// Bumped by [resetPeerConnection] so a creation already in flight at
  /// reset time can tell it's stale once it finishes, instead of
  /// resurrecting [_pc] with a connection the reset already discarded.
  /// [_pcCreating] alone isn't enough for that: nulling it out mid-flight
  /// stops *new* callers from joining the stale attempt, but the
  /// attempt itself is still running and would otherwise still assign
  /// `_pc = pc` on completion.
  int _pcGeneration = 0;

  /// Remote ICE candidates that arrived before they could be applied.
  ///
  /// The SFU trickles its candidates the moment it has them, which is
  /// routinely *before* its offer has been processed here — and
  /// `addCandidate` throws when there is no remote description yet.
  /// Discarding those is what left an Android client with no remote
  /// candidate to check toward: it allocated a TURN relay, never sent a
  /// CreatePermission for the server's address because it had no peer to
  /// permit, never sent a relay connectivity check, and sat in `checking`
  /// until the SFU's own 30s deadline closed the session. Whether the
  /// race was lost came down to which message won, which is why it
  /// looked intermittent.
  ///
  /// Bounded: a server that trickles endlessly into a connection that
  /// never gets a description must not grow this without limit.
  final _pendingRemoteCandidates = <IceCandidatePayload>[];

  /// Whether a remote description has been applied to [_pc]. `addCandidate`
  /// is only legal after one, and this is cheaper and more reliable than
  /// asking the platform on every candidate.
  bool _remoteDescriptionApplied = false;

  /// Guards ICE recovery so it runs at most once per connection, and never
  /// concurrently with itself.
  bool _iceRestartAttempted = false;
  bool _iceRestartInFlight = false;

  /// Fires if the connection is still trying to reach `connected`. See
  /// [_armIceWatchdog].
  Timer? _iceWatchdog;

  Future<rtc.RTCPeerConnection> _ensurePeerConnection() {
    final existing = _pc;
    if (existing != null) return Future.value(existing);
    return _pcCreating ??= _createPeerConnection(_pcGeneration);
  }

  Future<rtc.RTCPeerConnection> _createPeerConnection(int generation) async {
    final pc = await rtc.createPeerConnection({
      'iceServers': iceServers,
      // Unified plan is the only spec-compliant semantics and the only
      // one an SFU can negotiate reliably.
      'sdpSemantics': 'unified-plan',
    });

    if (generation != _pcGeneration) {
      // A reset landed while this was in flight. Dispose it rather than
      // leaving it to leak: nothing will ever reference it as [_pc], so
      // it would otherwise sit there holding a camera/mic and gathering
      // ICE candidates for a session nobody is using.
      //
      // `dispose()`, not `close()`: flutter_webrtc's native side only
      // removes a PeerConnection's observer from its own internal,
      // process-lifetime registry on `dispose()` (`peerConnectionDispose`);
      // `close()` alone just closes the native connection and leaves that
      // registry entry behind forever. Every later `getUserMedia()` call —
      // for any room, not just this one — scans every entry still in that
      // registry, so a `close()`-only teardown accumulates one permanently
      // stale entry per discarded/reset connection for the rest of the
      // process's life.
      unawaited(pc.dispose());
      throw StateError('peer connection reset while it was being created');
    }

    // A transceiver belongs to the connection that created it, so anything
    // cached from the previous generation is now a handle to a closed
    // object. Kept here rather than in the reconnect path so every route to
    // a new connection clears it, including ones added later.
    _simulcastTransceivers.clear();
    // Subscriptions are renegotiated from scratch too, so the SFU has no
    // memory of what was last asked for. Pins are application intent and
    // deliberately survive; what cannot survive is the record of what was
    // already sent, or a restored subscription would keep whatever layer
    // the SFU defaults to.
    _sentLayers.clear();

    pc.onIceCandidate = (candidate) {
      if (candidate.candidate == null) {
        // End of gathering. Not forwarded: the server treats the absence
        // of further candidates the same way, and an explicit
        // end-of-candidates message would be one more thing for three
        // client implementations to agree on.
        return;
      }
      signaling.send(IceCandidatePayload(
        candidate: candidate.candidate!,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      ).toJson());
    };

    pc.onConnectionState = _handleConnectionState;

    pc.onTrack = (event) => unawaited(_handleIncomingTrack(event));

    pc.onDataChannel = (channel) {
      if (channel.label == _dataChannelLabel) {
        _attachDataChannel(channel);
      } else if (channel.label == _lossyDataChannelLabel) {
        _attachDataChannel(channel, lossy: true);
      }
    };

    _pc = pc;
    _pcCreating = null;
    return pc;
  }

  Future<void> _handleOffer(String sdp) async {
    // A real round trip is starting: whatever glare a previous offer hit
    // has, at minimum, been superseded by this one. See
    // [_glareRecoveryAttempted]'s doc comment for why this is where its
    // one-shot budget refills.
    _glareRecoveryAttempted = false;
    final pc = await _ensurePeerConnection();
    try {
      // Live read — see _negotiatePublish's doc comment on why the cached
      // `pc.signalingState` getter is not trustworthy here either: an
      // offer we just sent may not have updated it yet.
      final state = await pc.getSignalingState();
      if (state == rtc.RTCSignalingState.RTCSignalingStateHaveLocalOffer) {
        // Real glare: this offer arrived while our own was still
        // outstanding. The SFU is the impolite peer by design (see
        // services/sfu's Participant.AcceptOffer) — it has already
        // refused, or is about to refuse, our offer with
        // NEGOTIATION_GLARE (see the ServerMessageType.error case above),
        // so rolling back here just brings the local description in line
        // with what the server already decided, instead of
        // setRemoteDescription below throwing "Called in wrong state".
        try {
          // flutter_webrtc has no dedicated rollback call. An empty-SDP
          // description typed 'rollback' is the spec-correct wire form
          // for one; dart_webrtc's setLocalDescription force-unwraps
          // description.sdp (rtc_peerconnection_impl.dart), so this has
          // to be '' rather than null, or the unwrap throws before the
          // platform ever sees the call.
          await pc
              .setLocalDescription(rtc.RTCSessionDescription('', 'rollback'));
        } catch (error) {
          // Best-effort: setRemoteDescription(offer) below performs an
          // implicit rollback per the WebRTC spec on platforms where an
          // explicit one fails or isn't implemented, so proceed either
          // way.
        }
      }

      await pc.setRemoteDescription(rtc.RTCSessionDescription(sdp, 'offer'));
      _remoteDescriptionApplied = true;
      // Before the answer: the agent can begin checking against these
      // as soon as it has a local description, and the SFU has usually
      // trickled several by now.
      await _drainRemoteCandidates();
      final answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Re-read the local description: the platform may have folded
      // candidates into it, and sending the pre-set copy would drop them.
      final local = await pc.getLocalDescription();
      signaling.send({
        'type': ClientMessageType.sdpAnswer,
        'sdp': local?.sdp ?? answer.sdp ?? '',
      });

      // The SFU's first offer for this generation has now been answered —
      // whatever was waiting on [_initialOfferHandled] (a publish() that
      // arrived before this offer did) is free to negotiate. Idempotent:
      // every offer after the first finds this already completed.
      if (!_initialOfferHandled.isCompleted) {
        _initialOfferHandled.complete();
      }

      await _flushDeferredPublishes();
      _reapplyPublisherLayers();
    } catch (error) {
      _errors.add(SwalvoException(
        SwalvoErrorCode.signalingError,
        "Could not answer the server's offer.",
        error,
      ));
    }
  }

  Future<void> _handleAnswer(String sdp) async {
    final pc = _pc;
    if (pc == null) return;
    // See _handleOffer's matching reset — an answer to our own offer is
    // just as much a completed round trip as the SFU offering first.
    _glareRecoveryAttempted = false;
    try {
      await pc.setRemoteDescription(rtc.RTCSessionDescription(sdp, 'answer'));
      _remoteDescriptionApplied = true;
      await _drainRemoteCandidates();

      // The round this answer just completed may have had another
      // publish queued behind it (_negotiatePublish's `signalingState !=
      // stable` branch, reached when a second track was published while
      // our first offer was still outstanding). Without this, that
      // publish stayed queued until something unrelated prompted the SFU
      // to offer again — previously only _handleOffer flushed the queue,
      // so a publish that only ever raced our own offer, never the
      // SFU's, retried on nothing.
      await _flushDeferredPublishes();
      _reapplyPublisherLayers();
    } catch (error) {
      _errors.add(SwalvoException(
        SwalvoErrorCode.signalingError,
        'Could not apply the server\'s answer.',
        error,
      ));
    }
  }

  /// How many un-appliable remote candidates to hold before dropping the
  /// oldest. A real negotiation produces a handful per m-section; anything
  /// beyond this is a server trickling into a connection that is never
  /// going to get a description, and holding it all helps nobody.
  static const _maxPendingRemoteCandidates = 128;

  Future<void> _handleRemoteCandidate(IceCandidatePayload payload) async {
    final pc = _pc;
    // No connection yet, or no remote description to hang a candidate on.
    // Hold it: this is the ordering the SFU actually produces, not an
    // error, and dropping it costs the agent the pair it needed.
    if (pc == null || !_remoteDescriptionApplied) {
      _bufferRemoteCandidate(payload);
      return;
    }
    await _addRemoteCandidate(pc, payload, buffered: false);
  }

  void _bufferRemoteCandidate(IceCandidatePayload payload) {
    if (_pendingRemoteCandidates.length >= _maxPendingRemoteCandidates) {
      _pendingRemoteCandidates.removeAt(0);
      debugPrint('[swalvo] ice: candidate buffer full, dropped oldest');
    }
    _pendingRemoteCandidates.add(payload);
    debugPrint('[swalvo] ice: buffered remote candidate '
        '${_candidateShape(payload.candidate)} '
        '(pending=${_pendingRemoteCandidates.length})');
  }

  Future<void> _addRemoteCandidate(
    rtc.RTCPeerConnection pc,
    IceCandidatePayload payload, {
    required bool buffered,
  }) async {
    try {
      await pc.addCandidate(rtc.RTCIceCandidate(
        payload.candidate,
        payload.sdpMid,
        payload.sdpMLineIndex,
      ));
      debugPrint('[swalvo] ice: applied ${buffered ? "buffered " : ""}'
          'remote candidate ${_candidateShape(payload.candidate)}');
    } catch (error) {
      // Still not appliable. If a description has since been set this is a
      // genuinely stale candidate (a transceiver that has gone) and there
      // is nothing to retry; otherwise hold it for the next drain.
      if (!_remoteDescriptionApplied) {
        _bufferRemoteCandidate(payload);
        return;
      }
      debugPrint('[swalvo] ice: discarded unusable remote candidate '
          '${_candidateShape(payload.candidate)}: $error');
    }
  }

  /// Applies everything held back, oldest first, once a remote description
  /// exists. Called from both description paths so neither ordering loses
  /// the candidates the other would have applied.
  Future<void> _drainRemoteCandidates() async {
    if (_pendingRemoteCandidates.isEmpty) return;
    final pc = _pc;
    if (pc == null || !_remoteDescriptionApplied) return;

    final pending = List.of(_pendingRemoteCandidates);
    _pendingRemoteCandidates.clear();
    debugPrint(
        '[swalvo] ice: draining ${pending.length} buffered remote candidate(s)');
    for (final payload in pending) {
      await _addRemoteCandidate(pc, payload, buffered: true);
    }
  }

  /// A candidate's shape — type and transport only, never its address.
  ///
  /// Enough to tell host from srflx from relay when reading a log, with
  /// no IP, port, or ufrag in it: an ICE candidate line carries the
  /// connection's ufrag, and those are credentials.
  static String _candidateShape(String candidate) {
    final type = RegExp(r'\btyp (host|srflx|prflx|relay)\b')
        .firstMatch(candidate)
        ?.group(1);
    final transport = RegExp(r'\b(udp|tcp)\b', caseSensitive: false)
        .firstMatch(candidate)
        ?.group(1)
        ?.toLowerCase();
    return '${type ?? "unknown"}/${transport ?? "?"}';
  }

  Future<void> _flushDeferredPublishes() async {
    final pending = List.of(_deferredPublishes);
    _deferredPublishes.clear();
    for (final retry in pending) {
      await retry();
    }
  }

  /// Offers, so the server learns about a newly added track.
  ///
  /// Needed only when adding a track created a new transceiver: the first
  /// publish of each kind. Later publishes of the same kind reuse it and
  /// ride the server's next offer.
  Future<void> _negotiatePublish() async {
    final pc = _pc;
    if (pc == null) return;

    // A *live* read, not the cached `pc.signalingState` getter: that
    // cache only updates from a `signalingState` platform event, which on
    // Flutter Web arrives via the browser's own `signalingstatechange`
    // listener — asynchronously, on its own turn of the event loop. Called
    // right after _handleOffer's own setRemoteDescription/setLocalDescription
    // (as _flushDeferredPublishes does), that event can easily not have
    // landed yet, so the cache still reads the description-old state and
    // this defers a retry that was actually free to send — forever, since
    // nothing else was going to prompt another flush. getSignalingState()
    // asks the platform directly and has no such lag.
    final state = await pc.getSignalingState();
    if (state != rtc.RTCSignalingState.RTCSignalingStateStable) {
      // The server has an offer in flight. Retry after we answer it,
      // rather than creating a competing offer.
      _deferredPublishes.add(_negotiatePublish);
      return;
    }

    try {
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      final local = await pc.getLocalDescription();
      signaling.send({
        'type': ClientMessageType.sdpOffer,
        'sdp': local?.sdp ?? offer.sdp ?? '',
      });
    } catch (error) {
      throw SwalvoException(
        SwalvoErrorCode.mediaError,
        'Could not negotiate the published track.',
        error,
      );
    }
  }

  // -------------------------------------------------------------------
  // Incoming media
  // -------------------------------------------------------------------

  /// Matches an arriving track to what signaling said about it.
  ///
  /// `onTrack` and `track.published` race, and either can be first, so
  /// this completes the subscription only when both halves are present,
  /// and parks whichever arrived first. A path that only worked in one
  /// order would drop tracks nondeterministically.
  ///
  /// The id used to do that matching is [_remoteTrackIdFor]'s, never
  /// [rtc.MediaStreamTrack.id] directly — see that method's doc for why
  /// trusting the platform's own id here silently drops every
  /// subscription.
  Future<void> _handleIncomingTrack(rtc.RTCTrackEvent event) async {
    final track = event.track;
    final stream = event.streams.isNotEmpty ? event.streams.first : null;
    if (stream == null) return;

    final resolvedId = await _remoteTrackIdFor(event) ?? track.id ?? '';
    final receiver = event.receiver;
    if (receiver != null && e2ee != null) _receivers[resolvedId] = receiver;
    final owner = _ownerOfAnnouncedTrack(resolvedId);
    if (owner == null) {
      _pendingMedia[resolvedId] = (track: track, stream: stream);
      return;
    }

    _completeSubscription(owner.participantId, owner.track, track, stream);
  }

  /// The id the SFU actually published this track under, read from the
  /// remote SDP's `a=msid:` line — never [rtc.MediaStreamTrack.id].
  ///
  /// `RTCTrackEvent.track.id` is **not** the remote track id: the
  /// platform mints a fresh local id for a track it just received and
  /// ignores the `msid` the sender put on the wire, which is what the SFU
  /// actually announces in `track.published`. Matching on the local id
  /// therefore never matches anything — every subscription silently
  /// parks in [_pendingMedia] forever, with no error, because from this
  /// engine's point of view the announcement simply "hasn't arrived yet".
  /// `packages/sdk`'s adapter hit the identical bug against Chrome and
  /// documents the same fix: read the id the remote peer actually picked
  /// out of the SDP, located by the transceiver's `mid` rather than by
  /// scanning for the first `a=msid:` line, since a participant
  /// publishing both a camera and a screen share has two video
  /// m-sections and the wrong one mislabels both.
  ///
  /// Returns null when the mid or the msid can't be read yet — an
  /// `msid`-less section, or a transceiver whose `mid` hasn't settled —
  /// so the caller can fall back to the local id rather than guessing.
  Future<String?> _remoteTrackIdFor(rtc.RTCTrackEvent event) async {
    final mid = event.transceiver?.mid;
    if (mid == null || mid.isEmpty) return null;
    final remote = await _pc?.getRemoteDescription();
    final sdp = remote?.sdp;
    if (sdp == null) return null;
    return _msidTrackIdForMid(sdp, mid);
  }

  ({String participantId, ServerTrack track})? _ownerOfAnnouncedTrack(
      String trackId) {
    for (final entry in _announced.entries) {
      if (entry.value.trackId == trackId) {
        final participantId = _announcedOwners[entry.key];
        if (participantId != null) {
          return (participantId: participantId, track: entry.value);
        }
      }
    }
    return null;
  }

  void _announceTrack(String participantId, ServerTrack track) {
    if (track.trackId.isEmpty) return;

    final key = _key(participantId, track.trackId);
    _announced[key] = track;
    _announcedOwners[key] = participantId;

    final pending = _pendingMedia.remove(track.trackId);
    if (pending != null) {
      _completeSubscription(
          participantId, track, pending.track, pending.stream);
      return;
    }
    _notify();
  }

  void _unannounceTrack(String participantId, String trackId) {
    final key = _key(participantId, trackId);
    _announced.remove(key);
    _announcedOwners.remove(key);
    _pendingMedia.remove(trackId);
    _subscribed.remove(key);
    _pendingSubscriptionStates.remove(key);
    _notify();
  }

  void _completeSubscription(
    String participantId,
    ServerTrack serverTrack,
    rtc.MediaStreamTrack track,
    rtc.MediaStream stream,
  ) {
    final key = _key(participantId, serverTrack.trackId);
    if (_subscribed.containsKey(key)) return;

    final receiver = _receivers.remove(serverTrack.trackId);
    final controller = e2ee;
    if (receiver != null && controller != null) {
      unawaited(controller
          .setupReceiver(receiver, participantId)
          .catchError((Object error) {
        developer.log('could not attach the e2ee decryptor',
            name: 'swalvo_rtc', level: 900, error: error);
      }));
    }

    final parked = _pendingSubscriptionStates.remove(key);
    final isVideo = serverTrack.kind != 'audio';
    _subscribed[key] = SubscribedTrack(
      participantId: participantId,
      trackId: serverTrack.trackId,
      source: serverTrack.source,
      track: track,
      stream: stream,
      muted: serverTrack.muted,
      kind: serverTrack.kind,
      // §4: with autoSubscribe off, video starts paused until asked for.
      // Derived from the contract rather than waited for, so a UI shows
      // the right thing from the first frame; the server's own word, when
      // it arrives (or already has, parked), replaces it.
      subscriptionState: parked?.state ??
          (isVideo && !autoSubscribe
              ? SwalvoSubscriptionState.pausedClient
              : SwalvoSubscriptionState.active),
      layer: parked?.layer,
    );
    // A pin, a pause or a size chosen before this subscription existed —
    // most often carried over a reconnect — reaches the new SFU session
    // now rather than at the next unrelated layout pass. Only when one
    // exists: with autoSubscribe off and nothing asked for yet, sending the
    // default here would resume every video the join asked to keep paused.
    if (isVideo && _hasLayerInput(key)) {
      _sendEffectiveLayer(participantId, serverTrack.trackId);
    }
    _notify();
  }

  void _setRemoteMuted(String participantId, String trackId, bool muted) {
    final subscription = _subscribed[_key(participantId, trackId)];
    if (subscription == null) return;
    // The publisher's mute, reported by the SFU: not the platform's
    // "no data arriving" flag, which flickers during ordinary jitter and
    // would flash a muted badge on a healthy connection.
    subscription.muted = muted;
    _notify();
  }

  /// Asks the SFU for a different simulcast layer of a subscribed track.
  ///
  /// A preference, not a command: the SFU will not hand over a layer the
  /// publisher is not sending, and congestion control may hold it lower.
  /// A UI that treated this as a command would show the wrong quality.
  /// Precedence, highest first:
  ///
  /// 1. **An explicit application request** (`automatic: false`). It pins
  ///    the subscription: adaptive streaming will not move it afterwards.
  ///    Requesting `auto` releases the pin and hands the track back to
  ///    adaptive streaming.
  /// 2. **Adaptive streaming** (`automatic: true`), when [adaptiveStream] is
  ///    on and the track is not pinned. Driven by rendered tile size from
  ///    `SwalvoVideoView`.
  /// 3. **The SFU's own choice**, when neither has said anything: `auto`,
  ///    which resolves to the best layer available.
  ///
  /// Whatever wins, it stays a preference. The SFU will not hand over a
  /// layer the publisher is not sending, and congestion control may hold a
  /// subscriber below the layer it asked for.
  ///
  /// [adaptiveStream] gates only rule 2. An explicit request works with
  /// adaptive streaming off — that combination is precisely "I will manage
  /// quality myself", and it used to be silently ignored.
  void requestLayer(
    String participantId,
    String trackId,
    String layer, {
    bool automatic = false,
  }) {
    final key = _subscriptionKey(participantId, trackId);

    if (automatic) {
      if (!adaptiveStream) return;
      _adaptiveLayers[key] = layer;
    } else if (layer == 'auto') {
      _pinnedLayers.remove(key);
    } else {
      _pinnedLayers[key] = layer;
    }

    _sendEffectiveLayer(participantId, trackId);
  }

  /// Pauses (`false`) or resumes (`true`) a subscribed video track
  /// (phase2-media-contracts §4, layer `off`).
  ///
  /// Outranks everything else: a paused track stays paused however its
  /// views are sized or shown, and whatever was pinned. Resuming hands it
  /// back to the pin, adaptive streaming, or the SFU, in that order.
  ///
  /// With `autoSubscribe: false`, `setVideoEnabled(…, true)` is also how a
  /// track nothing else has asked for is started.
  void setVideoEnabled(String participantId, String trackId, bool enabled) {
    final key = _subscriptionKey(participantId, trackId);
    if (enabled) {
      _disabledVideo.remove(key);
    } else {
      _disabledVideo.add(key);
    }
    // Unconditional: a no-op when the SFU already has the result, and the
    // one thing that starts an autoSubscribe:false video when it has not.
    _sendEffectiveLayer(participantId, trackId);
  }

  /// Whether anything has expressed a layer for this subscription.
  bool _hasLayerInput(String key) =>
      _disabledVideo.contains(key) ||
      _pinnedLayers.containsKey(key) ||
      _hiddenVideo.contains(key) ||
      _adaptiveLayers.containsKey(key);

  /// Whether [setVideoEnabled] paused this subscription.
  bool isVideoEnabled(String participantId, String trackId) =>
      !_disabledVideo.contains(_subscriptionKey(participantId, trackId));

  /// @internal Records whether one [view] of a subscription is visible.
  ///
  /// A subscription is visible while any of its registered views is.
  /// Hiding is applied after [hideDelay]; showing applies at once. Ignored
  /// with adaptive streaming off, which is "I will manage quality myself".
  void setViewVisibility(
    String participantId,
    String trackId,
    Object view,
    bool visible,
  ) {
    if (!adaptiveStream) return;
    final key = _subscriptionKey(participantId, trackId);
    final views = _viewVisibility.putIfAbsent(key, () => {});
    if (views[view] == visible) return;
    views[view] = visible;
    _updateVisibility(participantId, trackId);
  }

  /// @internal A view of a subscription went away. The last one leaving
  /// counts as hidden: nothing is showing the video any more.
  void removeView(String participantId, String trackId, Object view) {
    final key = _subscriptionKey(participantId, trackId);
    final views = _viewVisibility[key];
    if (views == null || views.remove(view) == null) return;
    if (!adaptiveStream) return;
    _updateVisibility(participantId, trackId);
  }

  void _updateVisibility(String participantId, String trackId) {
    final key = _subscriptionKey(participantId, trackId);
    final views = _viewVisibility[key];
    final visible = views == null || views.values.any((shown) => shown);

    if (visible) {
      _hideTimers.remove(key)?.cancel();
      if (_hiddenVideo.remove(key)) _sendEffectiveLayer(participantId, trackId);
      return;
    }
    if (_hiddenVideo.contains(key) || _hideTimers.containsKey(key)) return;
    _hideTimers[key] = Timer(hideDelay, () {
      _hideTimers.remove(key);
      if (_disposed) return;
      _hiddenVideo.add(key);
      _sendEffectiveLayer(participantId, trackId);
    });
  }

  /// The layer a subscription should be on, all inputs considered. The one
  /// place the precedence lives:
  ///
  /// 1. paused by [setVideoEnabled] → `off`;
  /// 2. an application pin ([requestLayer], non-automatic);
  /// 3. with adaptive streaming on, every view hidden → `off`;
  /// 4. with adaptive streaming on, the layer its views' size calls for;
  /// 5. `auto`: the SFU's choice.
  String _effectiveLayer(String key) {
    if (_disabledVideo.contains(key)) return 'off';
    final pinned = _pinnedLayers[key];
    if (pinned != null) return pinned;
    if (adaptiveStream) {
      if (_hiddenVideo.contains(key)) return 'off';
      final adaptive = _adaptiveLayers[key];
      if (adaptive != null) return adaptive;
    }
    return 'auto';
  }

  /// Sends the effective layer if the SFU does not already have it.
  ///
  /// "Nothing sent yet" means `auto` — the SFU's default — unless the join
  /// had `autoSubscribe: false`, in which case it means `off` for video,
  /// which is how §4 starts those subscriptions. So a room that never
  /// expresses a preference sends nothing, and one with autoSubscribe off
  /// sends exactly the request that starts each video.
  void _sendEffectiveLayer(String participantId, String trackId) {
    final key = _subscriptionKey(participantId, trackId);
    final subscription = _subscribed[key];
    final isVideo = subscription == null || subscription.kind != 'audio';
    if (!isVideo) return;

    final layer = _effectiveLayer(key);
    final last = _sentLayers[key] ?? (autoSubscribe ? 'auto' : 'off');
    if (last == layer) return;
    _sentLayers[key] = layer;

    signaling.send({
      'type': ClientMessageType.subscriptionUpdate,
      'publisherId': participantId,
      'trackId': trackId,
      'layer': layer,
    });
  }

  // -------------------------------------------------------------------
  // Speakers, quality, subscription state, dynacast (phase2 §2–§5)
  // -------------------------------------------------------------------

  void _applySpeakers(List<SpeakerLevel> speakers) {
    final before = _speakers.keys.toSet();
    _speakers.clear();
    // Capped at 8 by the server; a longer list is honoured, not trimmed.
    for (final speaker in speakers) {
      _speakers.putIfAbsent(speaker.participantId, () => speaker.level);
    }
    final after = _speakers.keys.toSet();
    final changed = before.difference(after).union(after.difference(before));
    if (!_speakerEvents.isClosed) {
      _speakerEvents.add((speakers: activeSpeakerIds, changed: changed));
    }
  }

  void _applyQuality(Map<String, String> updates) {
    final changed = <String>[];
    updates.forEach((id, wire) {
      final quality = connectionQualityFromWire(wire);
      if (_qualities[id] == quality) return;
      _qualities[id] = quality;
      changed.add(id);
    });
    if (changed.isNotEmpty && !_qualityEvents.isClosed) {
      _qualityEvents.add(changed);
    }
  }

  void _applySubscriptionState(
    String participantId,
    String trackId,
    SwalvoSubscriptionState state,
    String? layer,
  ) {
    final key = _subscriptionKey(participantId, trackId);
    final subscription = _subscribed[key];
    if (subscription == null) {
      // Ahead of its track: `subscription.state` and `onTrack` race like
      // `track.published` and `onTrack` do.
      _pendingSubscriptionStates[key] = (state: state, layer: layer);
      return;
    }
    if (subscription.subscriptionState == state &&
        subscription.layer == layer) {
      return;
    }
    subscription
      ..subscriptionState = state
      ..layer = layer;
    if (!_subscriptionStateEvents.isClosed) {
      _subscriptionStateEvents
          .add((participantId: participantId, trackId: trackId));
    }
    _notify();
  }

  /// Dynacast: switch this device's simulcast encodings on and off to
  /// match what the SFU says somebody is receiving (§5).
  ///
  /// flutter_webrtc's native `RTCRtpSender.parameters` is a snapshot cached
  /// from when the sender was created and updated only by our own
  /// `setParameters`; there is no platform call to read the live value.
  /// That is enough here, because nothing but this engine changes the
  /// `active` flags, but it is why the desired state is also re-applied
  /// after every negotiation round and why a failed `setParameters` is
  /// rolled back in the cache rather than left claiming a change that did
  /// not happen.
  void _applyPublisherLayers(String trackId, Map<String, bool> layers) {
    if (!dynacast) return;
    for (final published in _published.values) {
      if (published.track.id != trackId) continue;
      published.desiredLayers = Map.of(layers);
      _queueLayerUpdate(published);
      return;
    }
  }

  void _reapplyPublisherLayers() {
    for (final published in _published.values) {
      if (published.desiredLayers != null) _queueLayerUpdate(published);
    }
  }

  void _queueLayerUpdate(PublishedTrack published) {
    published.layerChain = published.layerChain
        .then((_) => _setEncodingsActive(published))
        .catchError((Object error) {
      developer.log(
        'could not apply publisher.layers to the ${published.source} sender',
        name: 'swalvo_rtc',
        level: 800, // INFO
        error: error,
      );
    });
  }

  Future<void> _setEncodingsActive(PublishedTrack published) async {
    final desired = published.desiredLayers;
    if (desired == null || _disposed) return;
    final sender = published.sender;
    final parameters = sender.parameters;
    final encodings = parameters.encodings;
    if (encodings == null || encodings.isEmpty) return;

    final previous = <rtc.RTCRtpEncoding, bool>{};
    for (final encoding in encodings) {
      final want = layerActiveFor(desired, encoding.rid);
      if (want == null || encoding.active == want) continue;
      previous[encoding] = encoding.active;
      encoding.active = want;
    }
    if (previous.isEmpty) return;

    try {
      await sender.setParameters(parameters);
    } catch (error) {
      previous.forEach((encoding, active) => encoding.active = active);
      rethrow;
    }
  }

  /// Forgets what only meant something while connected: who was speaking
  /// and everyone's quality. Not subscription states, which go with their
  /// subscriptions.
  void _clearRoomSignals() {
    final wasSpeaking = _speakers.keys.toSet();
    _speakers.clear();
    _qualities.clear();
    if (wasSpeaking.isNotEmpty && !_speakerEvents.isClosed) {
      _speakerEvents.add((speakers: const [], changed: wasSpeaking));
    }
  }

  /// The layer an application pinned for a subscription, if any.
  String? pinnedLayer(String participantId, String trackId) =>
      _pinnedLayers[_subscriptionKey(participantId, trackId)];

  /// The simulcast state of a source this device is publishing.
  SwalvoSimulcastStatus simulcastStatusFor(String source) =>
      _published[source]?.simulcast ?? SwalvoSimulcastStatus.notApplicable;

  static String _subscriptionKey(String participantId, String trackId) =>
      '$participantId/$trackId';

  // -------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------

  /// Publishes a locally captured track under a declared source.
  Future<PublishedTrack> publish({
    required String source,
    required rtc.MediaStream stream,
    required rtc.MediaStreamTrack track,
  }) async {
    assertMayPublish();
    final pc = await _ensurePeerConnection();

    final attached = await _attachSender(
      pc: pc,
      source: source,
      stream: stream,
      track: track,
    );
    final sender = attached.sender;
    // Before the first frame is encoded (§3.2): with E2EE on, nothing
    // leaves this sender unencrypted.
    await e2ee?.setupSender(sender);

    // Declared over signaling, not inferred from the SDP: an application
    // cannot choose the stream or track id that reaches the wire, so
    // codec kind is all the SFU could otherwise go on, and that cannot
    // tell a screen share from a camera (spec §16). Sent before
    // negotiating so the source is known by the time the media arrives.
    signaling.send({
      'type': ClientMessageType.trackPublish,
      'trackId': track.id ?? '',
      'source': source,
    });

    final published = PublishedTrack(
      source: source,
      track: track,
      stream: stream,
      sender: sender,
    )..simulcast = attached.simulcast;
    _published[source] = published;
    // The local MediaStream is already capturing and ready to render right
    // here — notify now rather than waiting for the SFU round trip below,
    // so a local self-preview shows up as soon as the camera/mic actually
    // opens instead of appearing to hang until negotiation finishes (external
    // report: local tile stuck on its placeholder while the remote tile,
    // which has no equivalent avoidable delay, rendered immediately).
    _notify();

    // Everything above is local (or, for track.publish, fire-and-forget
    // and order-independent of the offer/answer round) and safe to do the
    // instant the app calls publish() — including before the SFU's own
    // join-time offer has even arrived. Only the actual offer has to
    // wait: see [_initialOfferHandled]'s doc comment for the race this
    // closes. A no-op await once the first round has completed, which is
    // true for every publish after the first.
    await _initialOfferHandled.future;

    // Serialized: publish()/unpublish() are called from outside any
    // chain task (app code, via SwalvoRoom), unlike _flushDeferredPublishes,
    // which calls _negotiatePublish directly because it already runs
    // inside one. See _serialized's doc comment.
    await _serialized(_negotiatePublish);

    // Only now can the ladder be confirmed. Before the offer/answer round
    // the platform has not committed to a set of encodings, and asking it
    // earlier is how the previous implementation convinced itself simulcast
    // was on: it read back an empty list, took the early return, and never
    // looked again.
    if (attached.simulcast == SwalvoSimulcastStatus.pending) {
      published.simulcast = await _confirmSimulcast(source, sender);
    }

    _notify();
    return published;
  }

  /// Puts a local track on the connection, with a simulcast ladder when the
  /// source calls for one.
  ///
  /// # Why this is not `addTrack`
  ///
  /// `addTrack` returns a sender with exactly one encoding, and the number
  /// of encodings on a sender is fixed for its lifetime — `setParameters`
  /// is specified to reject any change to it. RIDs also only reach the SDP
  /// (`a=simulcast:send`, `a=rid:`) when they were present before the offer
  /// was generated. So the ladder has to be declared at the moment the
  /// transceiver is created and can never be added afterwards, which is
  /// exactly what the previous `addTrack` + `setParameters` pair tried to
  /// do, failed at, and hid.
  ///
  /// # The transceiver it reuses
  ///
  /// The SFU pre-creates a recvonly audio and video transceiver for every
  /// participant so an ordinary first publish costs no renegotiation, and
  /// `addTrack` reuses those. A simulcast publisher cannot: those
  /// transceivers already exist with one encoding. It offers its own
  /// m-section instead, which `Participant.AcceptOffer` on the SFU answers
  /// normally.
  ///
  /// What it does reuse is its *own* previous transceiver, kept in
  /// [_simulcastTransceivers]. Without that, every `disableCamera()` /
  /// `enableCamera()` cycle would add an m-section that never goes away,
  /// and a call where somebody toggles their camera a few dozen times would
  /// carry an SDP to match.
  Future<({rtc.RTCRtpSender sender, SwalvoSimulcastStatus simulcast})>
      _attachSender({
    required rtc.RTCPeerConnection pc,
    required String source,
    required rtc.MediaStream stream,
    required rtc.MediaStreamTrack track,
  }) async {
    if (!sourceUsesSimulcast(source)) {
      try {
        final sender = await pc.addTrack(track, stream);
        await _applyCodecPreferences(pc, sender, source);
        return (sender: sender, simulcast: SwalvoSimulcastStatus.notApplicable);
      } catch (error) {
        throw SwalvoException(
          SwalvoErrorCode.mediaError,
          'Could not add the $source track to the connection.',
          error,
        );
      }
    }

    final existing = _simulcastTransceivers[source];
    if (existing != null) {
      try {
        await existing.sender.replaceTrack(track);
        await existing.setDirection(rtc.TransceiverDirection.SendOnly);
        return (
          sender: existing.sender,
          simulcast: SwalvoSimulcastStatus.pending,
        );
      } catch (error) {
        // The transceiver is gone or unusable — a reconnect rebuilt the
        // peer connection under us, say. Fall through and build a new one
        // rather than failing a publish over a cache.
        developer.log(
          'reusing the $source transceiver failed; creating a new one',
          name: 'swalvo_rtc',
          level: 800, // INFO
          error: error,
        );
        _simulcastTransceivers.remove(source);
      }
    }

    final codec = _effectiveVideoCodec;
    if (codec == 'vp9' || codec == 'av1') {
      // SVC (§2.2): one encoding carrying L3T3_KEY. Only when the platform
      // can send the codec at all; otherwise VP8 simulcast below.
      final ordered = await _codecsPreferring('video', 'video/$codec');
      if (ordered == null) {
        _svcRefused = true;
      } else {
        try {
          final transceiver = await pc.addTransceiver(
            track: track,
            kind: rtc.RTCRtpMediaType.RTCRtpMediaTypeVideo,
            init: rtc.RTCRtpTransceiverInit(
              direction: rtc.TransceiverDirection.SendOnly,
              streams: [stream],
              sendEncodings: [
                rtc.RTCRtpEncoding(
                    scalabilityMode: svcScalabilityMode,
                    maxBitrate: svcMaxBitrate),
              ],
            ),
          );
          try {
            await transceiver.setCodecPreferences(ordered);
          } catch (error) {
            developer.log('setCodecPreferences(video/$codec) failed',
                name: 'swalvo_rtc', level: 800, error: error);
          }
          _simulcastTransceivers[source] = transceiver;
          return (
            sender: transceiver.sender,
            simulcast: SwalvoSimulcastStatus.pending
          );
        } catch (error) {
          _svcRefused = true;
          developer.log('$codec SVC refused; publishing VP8 simulcast instead',
              name: 'swalvo_rtc', level: 900, error: error);
        }
      }
    }

    try {
      final transceiver = await pc.addTransceiver(
        track: track,
        kind: rtc.RTCRtpMediaType.RTCRtpMediaTypeVideo,
        init: rtc.RTCRtpTransceiverInit(
          direction: rtc.TransceiverDirection.SendOnly,
          streams: [stream],
          sendEncodings: simulcastEncodings
              .map((layer) => layer.toEncoding())
              .toList(growable: false),
        ),
      );
      final simulcastCodec = _effectiveVideoCodec;
      if (simulcastCodec != null) {
        await _preferCodec(transceiver, 'video', 'video/$simulcastCodec');
      }
      _simulcastTransceivers[source] = transceiver;
      return (
        sender: transceiver.sender,
        simulcast: SwalvoSimulcastStatus.pending,
      );
    } catch (error) {
      // A platform that will not take the ladder still has to be able to
      // publish. Falling back to one layer is the controlled outcome; doing
      // it silently is what let this ship broken, so it is logged loudly and
      // recorded on the publication.
      developer.log(
        'simulcast is unavailable on this platform: the $source track will '
        'publish a single full-quality layer, so subscribers cannot drop to '
        'a cheaper one and a large call will cost every participant the full '
        'bitrate. Swalvo.simulcastStatusFor() reports this.',
        name: 'swalvo_rtc',
        level: 900, // WARNING
        error: error,
      );
      try {
        final sender = await pc.addTrack(track, stream);
        return (sender: sender, simulcast: SwalvoSimulcastStatus.unsupported);
      } catch (fallbackError) {
        throw SwalvoException(
          SwalvoErrorCode.mediaError,
          'Could not add the $source track to the connection.',
          fallbackError,
        );
      }
    }
  }

  /// Reads the ladder back off the sender once negotiation has settled.
  ///
  /// The check that matters is the RID count, because that is what the SFU
  /// keys layers on. A sender reporting one encoding is publishing one
  /// layer no matter what was asked for.
  Future<SwalvoSimulcastStatus> _confirmSimulcast(
    String source,
    rtc.RTCRtpSender sender,
  ) async {
    try {
      final encodings = sender.parameters.encodings ?? const [];
      final mode =
          encodings.length == 1 ? encodings.first.scalabilityMode : null;
      if (mode != null && RegExp(r'^L[23]T').hasMatch(mode)) {
        return SwalvoSimulcastStatus.svc;
      }
      final rids = encodings
          .map((encoding) => encoding.rid)
          .whereType<String>()
          .where((rid) => rid.isNotEmpty)
          .toSet();
      final wanted = simulcastEncodings.map((layer) => layer.rid).toSet();

      if (rids.containsAll(wanted)) {
        return SwalvoSimulcastStatus.enabled;
      }

      developer.log(
        'simulcast did not survive negotiation for the $source track: the '
        'sender reports layers $rids, expected $wanted. Subscribers will all '
        'receive the one layer being sent.',
        name: 'swalvo_rtc',
        level: 900, // WARNING
      );
      return SwalvoSimulcastStatus.unsupported;
    } catch (error) {
      // Reading parameters back is a platform call and can fail on its own.
      // Unknown is reported as unsupported rather than enabled: claiming a
      // ladder that may not exist is the failure mode being fixed here.
      developer.log(
        'could not read back the $source sender parameters to confirm '
        'simulcast; assuming it is not active.',
        name: 'swalvo_rtc',
        level: 900, // WARNING
        error: error,
      );
      return SwalvoSimulcastStatus.unsupported;
    }
  }

  Future<void> unpublish(String source) async {
    final published = _published.remove(source);
    if (published == null) return;

    final simulcast = _simulcastTransceivers[source];
    if (simulcast != null &&
        simulcast.sender.senderId == published.sender.senderId) {
      // Stopped, not parked — see [_simulcastTransceivers] for why.
      _simulcastTransceivers.remove(source);
      try {
        await simulcast.stop();
      } catch (_) {
        // Already gone, usually because the connection is closing.
      }
    } else {
      try {
        await _pc?.removeTrack(published.sender);
      } catch (_) {
        // Already gone, usually because the connection is closing.
      }
    }
    await published.track.stop();
    await published.stream.dispose();

    // Serialized: publish()/unpublish() are called from outside any
    // chain task (app code, via SwalvoRoom), unlike _flushDeferredPublishes,
    // which calls _negotiatePublish directly because it already runs
    // inside one. See _serialized's doc comment.
    await _serialized(_negotiatePublish);
    _notify();
  }

  PublishedTrack? publishedTrack(String source) => _published[source];

  /// Mutes a published track without unpublishing it.
  ///
  /// `enabled = false` makes the platform send silence or black frames:
  /// the stream continues, the transceiver stays, and unmuting is
  /// instant. Stopping the track instead would release the device and
  /// then need a fresh capture and a renegotiation to undo.
  Future<void> setMuted(String source, bool muted) async {
    final published = _published[source];
    if (published == null) return;

    published.track.enabled = !muted;
    published.muted = muted;

    // The SFU is told separately so it can stop forwarding the silence to
    // every subscriber instead of paying to relay it.
    signaling.send({
      'type': ClientMessageType.trackMute,
      'trackId': published.track.id ?? '',
      'muted': muted,
    });
    _notify();
  }

  /// Swaps the device behind a published track without renegotiating.
  ///
  /// `replaceTrack` leaves the transceiver, the SSRC and every
  /// subscriber's view untouched, so nobody else in the room sees
  /// anything happen.
  Future<void> replaceTrack(String source, rtc.MediaStreamTrack next) async {
    final published = _published[source];
    if (published == null) return;

    await published.sender.replaceTrack(next);
    final previous = published.track;
    published.track = next;
    if (published.muted) {
      next.enabled = false;
    }
    await previous.stop();
    _notify();
  }

  // -------------------------------------------------------------------
  // Data channel
  // -------------------------------------------------------------------

  void _attachDataChannel(rtc.RTCDataChannel channel, {bool lossy = false}) {
    if (lossy) {
      _lossyChannel = channel;
    } else {
      _dataChannel = channel;
    }
    channel.onMessage = (message) {
      // The sender is whatever the SFU stamped on a v2 delivery frame,
      // never a field the sender controls. A legacy message carries no
      // sender at all, and saying nothing beats guessing.
      if (_data.isClosed) return;
      _data.add(decodeDataDelivery(message.binary));
    };
    channel.onDataChannelState = (state) {
      if (state == rtc.RTCDataChannelState.RTCDataChannelOpen) {
        _settleDataChannelWaiters(lossy: lossy);
      }
    };
    // A channel that arrives already open — restored on a live
    // connection, or opened before this listener was attached — never
    // fires `onDataChannelState` for us.
    if (channel.state == rtc.RTCDataChannelState.RTCDataChannelOpen) {
      _settleDataChannelWaiters(lossy: lossy);
    }
  }

  /// Opens this participant's data channel if nothing has already, so a
  /// participant that only wants [data] gets one even though it never
  /// published or called [sendData].
  ///
  /// The SFU fans data out over each recipient's *own* channel (spec
  /// §18), so a participant who never opened one does not merely fail to
  /// send: they never receive anything either, since there is no channel
  /// for the SFU to relay onto. A channel is still opened on demand
  /// rather than unconditionally, since most calls never touch data at
  /// all and an SCTP association for every participant regardless is a
  /// cost with nothing behind it.
  ///
  /// Against a server advertising `data.v2` the lossy channel is opened
  /// alongside, in the same negotiation, so lossy messages reach this
  /// participant on it rather than falling back to the reliable one.
  Future<void> ensureDataChannel() {
    // Without publishData the offer would be refused; [_applyGrants] opens
    // the channels if the grant arrives later.
    if (!_mayOpenDataChannels) return Future.value();
    final wantLossy = _supportsDataV2;
    if (_dataChannel != null && (!wantLossy || _lossyChannel != null)) {
      return Future.value();
    }
    // Single flight: two concurrent callers must not each create a channel.
    return _ensuringDataChannel ??= _openDataChannels(wantLossy)
        .whenComplete(() => _ensuringDataChannel = null);
  }

  Future<void>? _ensuringDataChannel;

  Future<void> _openDataChannels(bool wantLossy) async {
    final pc = await _ensurePeerConnection();
    var created = false;
    if (_dataChannel == null) {
      final channel = await pc.createDataChannel(
        _dataChannelLabel,
        rtc.RTCDataChannelInit()
          ..ordered = true
          ..protocol = dataChannelProtocol,
      );
      if (_dataChannel == null) {
        _attachDataChannel(channel);
        created = true;
      }
    }
    if (wantLossy && _lossyChannel == null) {
      final channel = await pc.createDataChannel(
        _lossyDataChannelLabel,
        _LossyDataChannelInit(),
      );
      if (_lossyChannel == null) {
        _attachDataChannel(channel, lossy: true);
        created = true;
      }
    }
    if (!created) return;

    // A data channel needs its own `m=application` section just like a
    // newly added track, but unlike publish()/unpublish() nothing else was
    // ever going to prompt an offer for a participant who only wants
    // [data]: it previously opened only by riding along behind some
    // unrelated publish's negotiation round, or never opened at all for a
    // participant that never published. Same race guard as publish() — a
    // caller here before the SFU's join-time offer has arrived must not
    // send a competing offer; see [_initialOfferHandled].
    await _initialOfferHandled.future;
    await _serialized(_negotiatePublish);
  }

  /// How long [sendData] waits for the data channel to open before giving
  /// up. Chosen to comfortably outlast one ordinary negotiation round
  /// trip without leaving a caller stuck for the length of a whole call:
  /// the data channel piggybacks on the same offer/answer machinery as
  /// every other negotiation here, so a channel that hasn't opened by
  /// then almost always means negotiation itself is stuck, and no amount
  /// of further waiting fixes that.
  static const _dataChannelOpenTimeout = Duration(seconds: 15);

  /// Resolves once the data channel is open.
  ///
  /// What [sendData] actually needs to wait for. A data channel needs its
  /// own `m=application` section, which costs a round trip before the
  /// first byte can go anywhere; a caller that does not wait for that and
  /// sends immediately either throws against a channel that is not open
  /// yet or, on platforms that buffer instead, has no way to know the
  /// payload has not actually left.
  ///
  /// Bounded by [_dataChannelOpenTimeout]: an unbounded wait here means
  /// that if negotiation itself never completes — a stuck round the
  /// caller has no other visibility into — [sendData] simply never
  /// returns, with no error and no way out short of the caller inventing
  /// its own timeout around a call that documents none.
  Future<void> _dataChannelOpened({bool lossy = false}) {
    final channel = lossy ? _lossyChannel : _dataChannel;
    if (channel?.state == rtc.RTCDataChannelState.RTCDataChannelOpen) {
      return Future.value();
    }
    final waiters = lossy ? _lossyChannelWaiters : _dataChannelWaiters;
    final completer = Completer<void>();
    waiters.add(completer);
    return completer.future.timeout(
      _dataChannelOpenTimeout,
      onTimeout: () {
        waiters.remove(completer);
        throw SwalvoException(
          SwalvoErrorCode.timeout,
          'The data channel did not open within '
          '${_dataChannelOpenTimeout.inSeconds}s.',
        );
      },
    );
  }

  void _settleDataChannelWaiters({bool lossy = false}) {
    final pending = lossy ? _lossyChannelWaiters : _dataChannelWaiters;
    if (pending.isEmpty) return;
    final waiters = List.of(pending);
    pending.clear();
    for (final waiter in waiters) {
      if (!waiter.isCompleted) waiter.complete();
    }
  }

  /// Fails everyone waiting on the data channel, because it is never
  /// going to open.
  ///
  /// Only for a connection that is finished — a terminal signaling
  /// failure, or teardown. A reconnect deliberately does *not* come
  /// through here: [resetPeerConnection] drops the channel, but rejoining
  /// recreates it and settles the wait normally, so a [sendData] made
  /// mid-blip still goes out afterwards instead of throwing at the caller.
  void _abortDataChannelWaiters(SwalvoException error) {
    if (_dataChannelWaiters.isEmpty && _lossyChannelWaiters.isEmpty) return;
    final waiters = [..._dataChannelWaiters, ..._lossyChannelWaiters];
    _dataChannelWaiters.clear();
    _lossyChannelWaiters.clear();
    for (final waiter in waiters) {
      if (!waiter.isCompleted) waiter.completeError(error);
    }
  }

  /// Sends a payload to everyone else in the room.
  ///
  /// Waits for the channel to finish opening rather than sending
  /// immediately: [rtc.RTCDataChannel.send] on a channel whose SCTP
  /// association has not yet come up either throws or, on platforms that
  /// buffer instead of rejecting, leaves the caller with no way to tell
  /// the payload actually left. Queuing the wait here means every payload
  /// sent before the channel opens still goes out, once it does, instead
  /// of being silently dropped.
  ///
  /// With no options against a server without `data.v2`, the bytes on the
  /// wire are exactly [payload], as before. Otherwise they are wrapped in
  /// a v2 envelope (phase7-contracts §1.2). `reliable: false` uses the
  /// lossy channel when the server supports it, and falls back to the
  /// reliable one (with a warning, once) when it does not.
  Future<void> sendData(
    List<int> payload, {
    String? topic,
    List<String>? destinationIdentities,
    bool reliable = true,
  }) async {
    final lossy = !reliable && _supportsDataV2;
    if (!reliable && !_supportsDataV2 && !_lossyFallbackWarned) {
      _lossyFallbackWarned = true;
      developer.log(
        'sendData(reliable: false): this server has no lossy data channel (no data.v2); sending reliably',
        name: 'swalvo_rtc',
        level: 900,
      );
    }
    final limit =
        lossy ? maxLossyDataPayloadBytes : maxReliableDataPayloadBytes;
    if (payload.length > limit) {
      throw SwalvoException(
        SwalvoErrorCode.invalidArgument,
        'Data payload is ${payload.length} bytes, over the $limit-byte '
        '${lossy ? 'lossy' : 'reliable'} limit.',
      );
    }
    final useEnvelope = _supportsDataV2 ||
        (topic != null && topic.isNotEmpty) ||
        (destinationIdentities != null && destinationIdentities.isNotEmpty) ||
        !reliable;
    // Encoded before waiting on anything, so a bad topic or destination
    // list fails at once rather than after a negotiation round trip.
    final bytes = useEnvelope
        ? encodeDataEnvelope(payload,
            topic: topic, destinationIdentities: destinationIdentities)
        : Uint8List.fromList(payload);

    if (!_mayOpenDataChannels) {
      throw const SwalvoException(
        SwalvoErrorCode.permissionDenied,
        'sendData() requires a token that grants publishData.',
      );
    }
    await ensureDataChannel();
    await _dataChannelOpened(lossy: lossy);

    final channel = lossy ? _lossyChannel : _dataChannel;
    if (channel == null) {
      throw const SwalvoException(
        SwalvoErrorCode.connectionFailed,
        'sendData() requires an active connection.',
      );
    }

    await channel.send(rtc.RTCDataChannelMessage.fromBinary(bytes));
  }

  // -------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------

  /// Tears the peer connection down, keeping signaling alive.
  ///
  /// Used on reconnect: the server allocates a fresh session on rejoin, so
  /// the old connection is not reusable, and leaving it open would let a
  /// caller see a connection that looks alive but forwards nothing.
  Future<void> resetPeerConnection() async {
    final pc = _pc;
    _pc = null;
    // Both belong to the connection just torn down. Nulling _pcCreating
    // stops *new* callers from joining a stale attempt; bumping the
    // generation is what stops that attempt itself from resurrecting
    // [_pc] once it finishes — see [_createPeerConnection].
    _pcCreating = null;
    _pcGeneration++;
    // A fresh generation means a fresh SFU session and a fresh join-time
    // offer to wait for — see [_initialOfferHandled]'s doc comment. A
    // completer already-completed for the *previous* connection would let
    // a post-reconnect publish() skip the wait entirely.
    _initialOfferHandled = Completer<void>();
    _glareRecoveryAttempted = false;
    // All three belong to the connection just discarded. Candidates held
    // for it name transceivers that no longer exist, and the recovery
    // budget refills for the new connection — a fresh session gets its own
    // single restart, rather than inheriting a spent one.
    _pendingRemoteCandidates.clear();
    _remoteDescriptionApplied = false;
    _iceRestartAttempted = false;
    _iceRestartInFlight = false;
    _cancelIceWatchdog();
    _dataChannel = null;
    _lossyChannel = null;
    _subscribed.clear();
    _pendingMedia.clear();
    _receivers.clear();
    final cryptors = e2ee;
    if (cryptors != null) unawaited(cryptors.resetConnection());
    _pendingSubscriptionStates.clear();
    _deferredPublishes.clear();
    // Their senders belonged to the connection being discarded.
    if (_published.isNotEmpty) _republishPending = true;

    if (pc != null) {
      // Handlers cleared before closing, so a state change fired during
      // teardown is not mistaken for a connection failure.
      pc.onIceCandidate = null;
      pc.onTrack = null;
      pc.onDataChannel = null;
      pc.onConnectionState = null;
      // `dispose()`, not `close()`: see the matching comment in
      // `_createPeerConnection` above. `dispose()` already calls `close()`
      // internally (flutter_webrtc's `PeerConnectionObserver.dispose()`),
      // so this isn't skipping anything `close()` alone would have done —
      // it's the only one of the two that also releases the native-side
      // observer registration.
      await pc.dispose();
    }
    // Back to having no transport at all, which is what `idle` means.
    // Left reading `connected` from the connection just torn down, the
    // next reconnect would look healthy for as long as it took the new
    // connection to report anything — exactly the window where an
    // application most wants the truth.
    _setMediaState(SwalvoMediaState.idle);
    _notify();
  }

  /// Puts every publication a reset discarded onto the current (new) peer
  /// connection: after a reconnect the server did not resume, or a media
  /// rejoin. No-op otherwise, so calling it on every join is safe.
  ///
  /// Each goes back through [publish], so the new SFU session hears its
  /// `track.publish` declaration and gets a sender of its own. A mute is
  /// carried over.
  Future<void> republishAfterRebuild() async {
    if (!_republishPending || _disposed) return;
    _republishPending = false;
    for (final previous in _published.values.toList()) {
      try {
        await publish(
          source: previous.source,
          stream: previous.stream,
          track: previous.track,
        );
        if (previous.muted) await setMuted(previous.source, true);
      } catch (error) {
        if (_disposed) return;
        _errors.add(SwalvoException(
          SwalvoErrorCode.mediaError,
          'Could not restore the ${previous.source} after reconnecting.',
          error,
        ));
      }
    }
  }

  /// Applies a live permission change (§1.4). Losing a publish right is
  /// not an error: the SFU already unpublished those tracks, so the local
  /// publications are stopped quietly. Gaining one needs nothing: the next
  /// publish works on the same connection.
  /// Data channels need publishData: the API refuses the offer otherwise,
  /// and the SFU closes the channel. Unknown grants keep the old behaviour.
  bool get _mayOpenDataChannels => _grants?.publishData ?? true;

  Future<void> _applyGrants(SwalvoGrants grants) async {
    final hadDataGrant = _mayOpenDataChannels;
    _grants = grants;
    if (!hadDataGrant && grants.publishData && _supportsDataV2) {
      // Granted mid-session: open what connect would have opened.
      unawaited(ensureDataChannel().catchError((Object error) {
        developer.log('could not open the data channels after a grant',
            name: 'swalvo_rtc', level: 900, error: error);
      }));
    }
    for (final published in _published.values.toList()) {
      // Source-aware, not just audio/video: screen share gates on
      // publishScreen, independently of publishVideo (agora-parity audit,
      // phase 2).
      if (grants.mayPublishSource(published.source)) continue;
      try {
        await unpublish(published.source);
      } catch (_) {
        // The SFU already dropped it; failing to tidy up locally is not
        // worth surfacing.
      }
    }
    if (!_grantChanges.isClosed) _grantChanges.add(grants);
    _notify();
  }

  /// The server muted one of our tracks (§1.6). Mirrors it locally so we
  /// stop sending and [PublishedTrack.muted] tells the truth. Unmuting is
  /// left to the user; a server unmute is not acted on.
  Future<void> _applyServerMute(String trackId) async {
    for (final published in _published.values) {
      if (published.track.id != trackId) continue;
      published.track.enabled = false;
      published.muted = true;
      if (!_serverMutes.isClosed) _serverMutes.add(published.source);
      _notify();
      return;
    }
  }

  /// Stops local media and drops the peer connection for a session the
  /// server ended on purpose. Signaling is already closed.
  Future<void> endSession() async {
    _cancelMediaRejoin();
    for (final published in _published.values) {
      await published.track.stop();
      await published.stream.dispose();
    }
    _published.clear();
    await resetPeerConnection();
  }

  /// The device's network changed. A reconnect waiting out its backoff
  /// runs now; otherwise a live media connection restarts ICE onto the
  /// new network rather than waiting for the old path to time out.
  Future<void> handleNetworkChange() async {
    if (_disposed) return;
    if (signaling.isReconnecting) {
      signaling.reconnectNow();
      return;
    }
    final pc = _pc;
    if (pc == null) return;
    await _serialized(() async {
      if (!identical(pc, _pc)) return;
      final state = await pc.getSignalingState();
      if (state != rtc.RTCSignalingState.RTCSignalingStateStable) return;
      final offer = await pc.createOffer({'iceRestart': true});
      await pc.setLocalDescription(offer);
      final local = await pc.getLocalDescription();
      signaling.send({
        'type': ClientMessageType.sdpOffer,
        'sdp': local?.sdp ?? offer.sdp ?? '',
      });
    });
  }

  /// ICE failed while signaling may well be fine: nothing else would
  /// notice, so rejoin (new SFU session, new peer connection, everything
  /// republished) with a bounded, jittered backoff.
  void _scheduleMediaRejoin() {
    if (_disposed || _mediaRejoinTimer != null || !signaling.autoReconnect) {
      return;
    }
    if (_mediaRejoinAttempts >= _mediaRejoinMaxAttempts) {
      _errors.add(const SwalvoException(
        SwalvoErrorCode.connectionFailed,
        'The media connection could not be re-established.',
      ));
      return;
    }
    _mediaRejoinAttempts++;
    final delay = _mediaRejoinAttempts == 1
        ? Duration.zero
        : Duration(
            milliseconds: Random().nextInt(
                min(1000 * pow(2, _mediaRejoinAttempts - 2).toInt(), 10000) +
                    1));
    _mediaRejoinTimer = Timer(delay, () {
      _mediaRejoinTimer = null;
      if (_disposed) return;
      signaling.rejoin();
    });
  }

  void _cancelMediaRejoin() {
    _mediaRejoinTimer?.cancel();
    _mediaRejoinTimer = null;
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _cancelMediaRejoin();
    _cancelIceWatchdog();
    _pendingRemoteCandidates.clear();
    for (final timer in _hideTimers.values) {
      timer.cancel();
    }
    _hideTimers.clear();

    await _messages?.cancel();
    await _lifecycle?.cancel();
    _abortDataChannelWaiters(const SwalvoException(
      SwalvoErrorCode.connectionFailed,
      'The connection was disposed before the data channel could open.',
    ));

    for (final published in _published.values) {
      await published.track.stop();
      await published.stream.dispose();
    }
    _published.clear();

    await resetPeerConnection();
    await e2ee?.dispose();
    await _changes.close();
    await _errors.close();
    await _data.close();
    await _mediaStates.close();
    await _grantChanges.close();
    await _serverMutes.close();
    await _speakerEvents.close();
    await _qualityEvents.close();
    await _subscriptionStateEvents.close();
  }

  void _notify() {
    if (_disposed || _changes.isClosed) return;
    _changes.add(null);
  }

  /// How long the connection may sit short of `connected` before ICE
  /// recovery runs.
  ///
  /// Comfortably inside the SFU's own never-connected deadline (pion/ice
  /// defaults: 5s disconnected + 25s failed = ~30s), so a recoverable path
  /// gets a second attempt while the server-side session is still alive.
  /// Long enough that an ordinary slow gather — a phone bringing up a TURN
  /// allocation on mobile data — finishes on its own first.
  static const _iceStallTimeout = Duration(seconds: 12);

  /// Arms the stall watchdog, replacing any previous one.
  ///
  /// Deliberately not a retry loop: it fires once per armed period, and
  /// recovery itself is one-shot per connection ([_iceRestartAttempted]),
  /// so a connection that cannot be recovered fails rather than churning.
  void _armIceWatchdog() {
    _iceWatchdog?.cancel();
    if (_disposed) return;
    final generation = _pcGeneration;
    _iceWatchdog = Timer(_iceStallTimeout, () {
      unawaited(_recoverStalledIce(generation));
    });
  }

  void _cancelIceWatchdog() {
    _iceWatchdog?.cancel();
    _iceWatchdog = null;
  }

  /// One controlled ICE restart for a connection that never got going.
  ///
  /// Reuses the existing offer path rather than building a second
  /// negotiation route, so glare handling, deferred publishes and the
  /// transceiver cache all behave exactly as they do for any other offer.
  /// The published tracks stay on their transceivers throughout — an ICE
  /// restart renegotiates the transport, not the media — which is what
  /// keeps this free of duplicate publishers.
  Future<void> _recoverStalledIce(int generation) async {
    if (_disposed) return;
    // A reset or reconnect replaced the connection under us; its own
    // watchdog governs it now.
    if (generation != _pcGeneration) return;
    if (_iceRestartAttempted || _iceRestartInFlight) return;
    if (_mediaState == SwalvoMediaState.connected) return;

    final pc = _pc;
    if (pc == null) return;

    _iceRestartAttempted = true;
    _iceRestartInFlight = true;
    debugPrint('[swalvo] ice: stalled in ${_mediaState.name} after '
        '${_iceStallTimeout.inSeconds}s, attempting one ICE restart '
        '(pending=${_pendingRemoteCandidates.length})');

    try {
      final state = await pc.getSignalingState();
      if (state != rtc.RTCSignalingState.RTCSignalingStateStable) {
        // A negotiation is already in flight; it will either connect us or
        // leave the connection to fail honestly. Starting a competing
        // offer here is how duplicate m-sections get created.
        debugPrint(
            '[swalvo] ice: skipping restart, negotiation already in flight');
        return;
      }
      final offer = await pc.createOffer({'iceRestart': true});
      await pc.setLocalDescription(offer);
      final local = await pc.getLocalDescription();
      if (generation != _pcGeneration || _disposed) return;
      signaling.send({
        'type': ClientMessageType.sdpOffer,
        'sdp': local?.sdp ?? offer.sdp ?? '',
      });
      debugPrint('[swalvo] ice: restart offer sent');
    } catch (error) {
      debugPrint('[swalvo] ice: restart failed: $error');
      _errors.add(SwalvoException(
        SwalvoErrorCode.connectionFailed,
        'The media connection stalled and could not be restarted.',
        error,
      ));
    } finally {
      _iceRestartInFlight = false;
    }
  }

  /// Translates the peer connection's own state into [SwalvoMediaState].
  ///
  /// `new` is reported as [SwalvoMediaState.connecting] rather than
  /// [SwalvoMediaState.idle]: by the time a connection exists to report
  /// `new`, an attempt is under way, and "idle" is reserved for having no
  /// connection at all. Distinguishing them is what lets an application
  /// tell "nobody has published yet" from "we are trying and it is not
  /// working".
  void _handleConnectionState(rtc.RTCPeerConnectionState state) {
    debugPrint('[swalvo] ice: peer connection state -> ${state.name}');
    switch (state) {
      case rtc.RTCPeerConnectionState.RTCPeerConnectionStateNew:
      case rtc.RTCPeerConnectionState.RTCPeerConnectionStateConnecting:
      case rtc.RTCPeerConnectionState.RTCPeerConnectionStateDisconnected:
        // Still trying. Give it a bounded window to get there by itself.
        _armIceWatchdog();
      case rtc.RTCPeerConnectionState.RTCPeerConnectionStateConnected:
        _mediaRejoinAttempts = 0;
        _cancelIceWatchdog();
      case rtc.RTCPeerConnectionState.RTCPeerConnectionStateFailed:
        _cancelIceWatchdog();
        // ICE gave up. Signaling may be perfectly healthy, in which case
        // nothing else would ever rebuild this connection.
        _scheduleMediaRejoin();
      case rtc.RTCPeerConnectionState.RTCPeerConnectionStateClosed:
        // Settled either way: nothing left for a watchdog to rescue.
        _cancelIceWatchdog();
    }

    _setMediaState(switch (state) {
      rtc.RTCPeerConnectionState.RTCPeerConnectionStateNew ||
      rtc.RTCPeerConnectionState.RTCPeerConnectionStateConnecting =>
        SwalvoMediaState.connecting,
      rtc.RTCPeerConnectionState.RTCPeerConnectionStateConnected =>
        SwalvoMediaState.connected,
      rtc.RTCPeerConnectionState.RTCPeerConnectionStateDisconnected =>
        SwalvoMediaState.interrupted,
      rtc.RTCPeerConnectionState.RTCPeerConnectionStateFailed =>
        SwalvoMediaState.failed,
      rtc.RTCPeerConnectionState.RTCPeerConnectionStateClosed =>
        SwalvoMediaState.closed,
    });
  }

  void _setMediaState(SwalvoMediaState next) {
    if (_disposed || _mediaState == next || _mediaStates.isClosed) return;
    _mediaState = next;
    _mediaStates.add(next);
    // Folded into the same change notification everything else uses, so a
    // widget rebuilding from the room picks this up without subscribing
    // to a second thing.
    _notify();
  }

  static String _key(String participantId, String trackId) =>
      '$participantId/$trackId';
}

/// The track id in the `a=msid:` line of the m-section with this `mid`.
///
/// `a=msid:<stream-id> <track-id>`; the stream-only form is legal and
/// names no track, and a section can carry no msid at all, so this
/// returns null rather than guessing. See [SwalvoEngine._remoteTrackIdFor]
/// for why this is read at all instead of trusting the platform's track
/// id.
String? _msidTrackIdForMid(String sdp, String mid) {
  final sections = sdp.split(RegExp(r'\r?\nm=')).skip(1);
  for (final section in sections) {
    final lines = section.split(RegExp(r'\r?\n'));
    if (!lines.any((line) => line.trim() == 'a=mid:$mid')) continue;

    final msidLine = lines.firstWhere(
      (line) => line.startsWith('a=msid:'),
      orElse: () => '',
    );
    if (msidLine.isEmpty) return null;
    final parts =
        msidLine.substring('a=msid:'.length).trim().split(RegExp(r'\s+'));
    return parts.length > 1 && parts[1].isNotEmpty ? parts[1] : null;
  }
  return null;
}

/// `{ordered: false, maxRetransmits: 0}` for the lossy channel.
///
/// flutter_webrtc's own `toMap()` only sends `maxRetransmits` when it is
/// above zero, which would leave the native channel retransmitting
/// forever; the native plugins do read an explicit 0. Flutter Web builds
/// its init from the fields with the same `> 0` check, so there the
/// channel is unordered but still retransmitted (documented).
class _LossyDataChannelInit extends rtc.RTCDataChannelInit {
  _LossyDataChannelInit() {
    ordered = false;
    maxRetransmits = 0;
    protocol = dataChannelProtocol;
  }

  @override
  Map<String, dynamic> toMap() => {...super.toMap(), 'maxRetransmits': 0};
}
