import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;

import 'e2ee.dart';
import 'errors.dart';
import 'internal/engine.dart';
import 'internal/protocol.dart';
import 'internal/signaling_client.dart';
import 'types.dart';

/// Default capture constraints.
///
/// `ideal`, never `exact`: an exact resolution fails outright on a device
/// that cannot provide it, and "the call did not start because your front
/// camera is 640×480" is not an acceptable outcome.
/// `facingMode` is omitted on web: flutter_webrtc's web `getUserMedia` shim
/// only keeps it for a mobile-browser user agent and otherwise strips it
/// and logs a warning on every single call — desktop Chrome (including
/// headless Chromium) never matches, so it fired unconditionally. Mobile
/// camera switching goes through [Room.switchCamera] instead, which
/// doesn't depend on this constraint.
const _cameraConstraints = <String, dynamic>{
  'width': {'ideal': 1280},
  'height': {'ideal': 720},
  'frameRate': {'ideal': 30},
  if (!kIsWeb) 'facingMode': 'user',
};

/// All three are on by default because a call without them sounds bad in
/// the situations calls actually happen in: a phone speaker and mic in
/// the same room is an echo generator.
const _microphoneConstraints = <String, dynamic>{
  'echoCancellation': true,
  'noiseSuppression': true,
  'autoGainControl': true,
};

/// A joined room.
///
/// Returned by `Swalvo.join()`: never constructed directly. Owns the
/// participant roster and every room-scoped action. No SDP, ICE
/// candidate, or peer connection reaches this API.
///
/// Extends [ChangeNotifier], which is the idiomatic Flutter way to expose
/// changing state: an `AnimatedBuilder`, `ListenableBuilder` or
/// `provider` can rebuild from it directly. This is where the Flutter SDK
/// diverges from the TypeScript one by design: the web SDK's
/// `room.on('event', handler)` would work in Dart but would feel foreign.
/// The *concepts* are identical; only the subscription mechanism follows
/// the platform.
///
/// Typed streams are available too, for logic that belongs outside the
/// widget tree.
class SwalvoRoom extends ChangeNotifier {
  SwalvoRoom._({
    required SignalingClient signaling,
    required SwalvoEngine engine,
    required this.roomId,
    required String localIdentity,
    required String? localMetadata,
    Map<String, String>? localAttributes,
  })  : _signaling = signaling,
        _engine = engine,
        _localIdentity = localIdentity {
    _meta[localIdentity] = (
      metadata: localMetadata,
      attributes: Map.unmodifiable(localAttributes ?? const <String, String>{}),
    );
    _wire();
  }

  /// @internal
  ///
  /// Wires the room up to [signaling] and starts [engine] consuming it —
  /// before [signaling] is ever asked to connect. That ordering is load
  /// bearing: `_wire()` (called from the constructor) subscribes to
  /// `signaling.joins` and `signaling.messages`, and [SwalvoEngine.start]
  /// subscribes to `signaling.messages` too. Both are broadcast streams
  /// with no replay, so a message the SFU sends the instant `room.joined`
  /// resolves — an `sdp.offer`, most often — is only ever seen if a
  /// listener already existed when it arrived. Building the room and
  /// starting the engine only *after* `connect()` resolved, as this used
  /// to, left exactly that gap: the offer had nowhere to land and was
  /// dropped, and the subscriber transport it would have answered never
  /// came up.
  ///
  /// Call [applyInitialJoin] once `signaling.connect()` resolves.
  static SwalvoRoom attach({
    required SignalingClient signaling,
    required SwalvoEngine engine,
    required String roomId,
    required String localIdentity,
    String? localMetadata,
    Map<String, String>? localAttributes,
  }) {
    final room = SwalvoRoom._(
      signaling: signaling,
      engine: engine,
      roomId: roomId,
      localIdentity: localIdentity,
      localMetadata: localMetadata,
      localAttributes: localAttributes,
    );
    engine.start();
    return room;
  }

  /// @internal Applies the payload `signaling.connect()` resolved with.
  ///
  /// The `signaling.joins` listener `_wire()` already set up covers this
  /// same event — and every reconnect after it — since it was subscribed
  /// before `connect()` was even called. This call exists so the very
  /// first join's state (roster, `rtcServer`, `region`) is available the
  /// instant `Swalvo.join()` returns, rather than depending on exactly
  /// when that listener's microtask happens to run. [_handleJoined] is
  /// idempotent, so the two calls landing on the same payload is harmless.
  void applyInitialJoin(JoinedPayload joined) => _handleJoined(joined);

  final SignalingClient _signaling;
  final SwalvoEngine _engine;

  /// The room this connection was established for.
  final String roomId;

  final String _localIdentity;

  /// Metadata and attributes by identity, local participant included
  /// (phase7-contracts §2).
  final _meta =
      <String, ({String? metadata, Map<String, String> attributes})>{};

  final _connectionStateController =
      StreamController<SwalvoConnectionState>.broadcast();
  final _participantsController =
      StreamController<List<SwalvoParticipant>>.broadcast();
  final _errorController = StreamController<SwalvoException>.broadcast();
  final _activeSpeakersController =
      StreamController<List<SwalvoParticipant>>.broadcast();
  final _speakingController = StreamController<SwalvoParticipant>.broadcast();
  final _qualityController =
      StreamController<SwalvoConnectionQualityUpdate>.broadcast();
  final _subscriptionStateController =
      StreamController<SwalvoSubscriptionStateUpdate>.broadcast();

  /// Opens this participant's data channel the moment someone actually
  /// wants [data], including a participant who never publishes and never
  /// calls [sendData]. Without this, a purely receive-only participant
  /// had no channel for the SFU to relay anything onto, and hearing
  /// nothing looked exactly like nobody sending anything (see
  /// [SwalvoEngine.ensureDataChannel]). `onListen` rather than eagerly at
  /// construction: most calls never touch data at all, and an SCTP
  /// association nobody asked for is a cost with nothing behind it.
  late final _dataController = StreamController<List<int>>.broadcast(
    onListen: () => unawaited(_engine.ensureDataChannel()),
  );
  late final _dataMessageController =
      StreamController<SwalvoDataMessage>.broadcast(
    onListen: () => unawaited(_engine.ensureDataChannel()),
  );
  final _dataThrottledController =
      StreamController<SwalvoDataThrottled>.broadcast();
  final _metadataController =
      StreamController<SwalvoParticipantMetadataChanged>.broadcast();
  final _transcriptionSegmentController =
      StreamController<SwalvoTranscriptionSegment>.broadcast();
  final _transcriptionStateController =
      StreamController<SwalvoTranscriptionState>.broadcast();
  final _agentStateController =
      StreamController<SwalvoAgentStateChanged>.broadcast();

  /// AI agents' last reported state, by identity (phase6-contracts §4.2).
  final _agentStates = <String, SwalvoAgentState>{};

  /// Agents whose state arrived before they joined the roster; reported
  /// the moment they do.
  final _pendingAgentStates = <String>{};

  final _subscriptions = <StreamSubscription<Object?>>[];

  /// Identities the server has reported, in join order.
  final _remoteIdentities = <String>[];

  SwalvoConnectionState _connectionState = SwalvoConnectionState.connecting;
  SwalvoDisconnectReason? _disconnectReason;

  /// The socket dropped with a resume token in hand, so the peer
  /// connection was kept; the next join decides whether it survives.
  bool _awaitingResume = false;
  String? _rtcServer;
  String? _region;
  bool _disposed = false;

  /// Connection state changes. Also reflected by [connectionState] and by
  /// [ChangeNotifier] notifications.
  Stream<SwalvoConnectionState> get connectionStateChanges =>
      _connectionStateController.stream;

  /// Fires whenever the roster or anyone's published tracks change.
  ///
  /// Each listener gets the *current* roster the moment it subscribes,
  /// not only future changes. [_emitParticipants]'s first call already
  /// happens synchronously while [join][Swalvo.join] itself is resolving
  /// — applying the server's initial roster — which is before any
  /// caller's code has had a chance to attach a listener. A plain
  /// broadcast stream simply drops that first event for anyone who
  /// wasn't already listening, which is nobody, since nobody can be:
  /// this getter doesn't exist until `join()` has already returned. That
  /// silently starved the single most common case for this stream — a
  /// viewer joining a room, or a live stream, where someone is already
  /// publishing — of the one event that mattered. [participants] and
  /// [remoteParticipants] were never affected; they just read current
  /// state directly. [Stream.multi] runs its callback once per listener
  /// (unlike a shared broadcast stream's single subscription), which is
  /// what makes seeding each one individually possible.
  Stream<List<SwalvoParticipant>> get participantChanges =>
      Stream.multi((controller) {
        if (_disposed) {
          controller.close();
          return;
        }
        controller.add(participants);
        final subscription = _participantsController.stream.listen(
          controller.add,
          onError: controller.addError,
          onDone: controller.close,
        );
        controller.onCancel = subscription.cancel;
      }, isBroadcast: true);

  /// Who the SFU counts as speaking right now, loudest first, local
  /// participant included (phase2-media-contracts §2). Empty against a
  /// server that does not report speakers.
  List<SwalvoParticipant> get activeSpeakers =>
      _participantsFor(_engine.activeSpeakerIds);

  /// Fires with the new [activeSpeakers] on every speaker update, at most
  /// about three times a second. Levels can change without the set
  /// changing, so a level meter listens here; a "speaking" ring wants
  /// [speakingChanges] or [SwalvoParticipant.isSpeaking].
  Stream<List<SwalvoParticipant>> get activeSpeakerChanges =>
      _activeSpeakersController.stream;

  /// A participant who started or stopped speaking, as a fresh snapshot
  /// (read [SwalvoParticipant.isSpeaking]). Only transitions, never a
  /// level change. [participantChanges] and the room's own notifications
  /// fire as well, so a widget rebuilding from the room needs neither.
  Stream<SwalvoParticipant> get speakingChanges => _speakingController.stream;

  /// This device's connection quality as the SFU scores it: the local
  /// participant's [SwalvoParticipant.connectionQuality], except that a
  /// failed media connection reads [SwalvoConnectionQuality.lost] whatever
  /// was last reported.
  SwalvoConnectionQuality get connectionQuality =>
      _engine.mediaState == SwalvoMediaState.failed
          ? SwalvoConnectionQuality.lost
          : _engine.qualityOf(_localIdentity);

  /// Someone's connection quality changed, local participant included
  /// (phase2-media-contracts §3). At most once a second per room.
  Stream<SwalvoConnectionQualityUpdate> get connectionQualityChanges =>
      _qualityController.stream;

  /// A subscribed video track was paused or resumed, or changed layer
  /// (phase2-media-contracts §4). The same state is on
  /// [SwalvoRenderableTrack.subscriptionState] in the next snapshot.
  Stream<SwalvoSubscriptionStateUpdate> get subscriptionStateChanges =>
      _subscriptionStateController.stream;

  /// Errors that arrive asynchronously rather than from a call you made;
  /// a reconnect giving up, for instance.
  Stream<SwalvoException> get errors => _errorController.stream;

  /// End-to-end encryption state changes (docs/rtc/e2ee): for
  /// [localParticipant] it describes what you send, for a remote
  /// participant whether you can decrypt them. `missingKey` and
  /// `decryptFailed` mean their media is being dropped — usually a wrong
  /// passphrase. Empty without `Swalvo(e2ee:)`.
  Stream<SwalvoE2EEStateUpdate> get e2eeStateChanges {
    final controller = _engine.e2ee;
    if (controller == null) return const Stream.empty();
    return controller.states
        .map((event) {
          final participant = event.local
              ? localParticipant
              : _participantById(event.participantId);
          return participant == null
              ? null
              : SwalvoE2EEStateUpdate(participant, event.state);
        })
        .where((update) => update != null)
        .cast<SwalvoE2EEStateUpdate>();
  }

  /// Whether this room is end-to-end encrypted (created with `e2ee: true`).
  bool get isE2EE => _engine.roomRequiresE2EE;

  /// True while this device encrypts what it sends.
  bool get isE2EEActive => _engine.isE2EEActive;

  /// Why the room is (or last was) `disconnected` or `failed`. Null while
  /// it is connected and has never dropped for good. `removed` and
  /// `roomClosed` come from the server and must not be answered with an
  /// automatic rejoin.
  SwalvoDisconnectReason? get disconnectReason => _disconnectReason;

  /// What this participant may currently do: the token's grants, updated
  /// live by the server. Null when the token carries none and the server
  /// has not said. The server enforces these regardless; use them to decide
  /// which controls to show.
  SwalvoGrants? get grants => _engine.grants;

  /// Fires when the server changes [grants] mid-session. If a publish
  /// right was withdrawn, the SDK has already stopped those local tracks
  /// (no error). A right gained takes effect at once: a viewer promoted to
  /// the stage can call [enableCamera] without reconnecting.
  Stream<SwalvoGrants> get grantChanges => _engine.grantChanges;

  /// The local tracks the server muted (moderation), by kind. The track is
  /// already muted locally; unmuting is left to the user.
  Stream<SwalvoTrackKind> get localTracksMutedByServer =>
      _engine.serverMutes.map(trackKindFromSource);

  /// Non-fatal conditions, such as a token refresh that failed.
  Stream<SwalvoWarning> get warnings => _signaling.warnings;

  /// Tells the SDK the device's network just changed, so it recovers now
  /// rather than after a timeout: a pending reconnect runs at once, and a
  /// live media connection restarts ICE onto the new network. Call it from
  /// your connectivity listener (connectivity_plus, say). Safe at any time.
  Future<void> handleNetworkChange() => _engine.handleNetworkChange();

  /// Payloads other participants sent with [sendData], without sender
  /// or topic. See [dataMessages] for both.
  Stream<List<int>> get data => _dataController.stream;

  /// Data messages with their sender and topic (phase7-contracts §1).
  ///
  /// [SwalvoDataMessage.participant] is the sender as the SFU attests it,
  /// or null for a message from the server (`POST /v1/rooms/:id/data`) or
  /// from a client too old to send v2 envelopes. Listening opens this
  /// device's data channels, as [data] does.
  ///
  /// Data messages are **not** end-to-end encrypted, even in an E2EE
  /// room: they are protected by DTLS to the SFU only.
  Stream<SwalvoDataMessage> get dataMessages => _dataMessageController.stream;

  /// The server dropped some of this device's data messages for going over
  /// the rate limit. Also logged as a warning.
  Stream<SwalvoDataThrottled> get dataThrottled =>
      _dataThrottledController.stream;

  /// Someone's [SwalvoParticipant.metadata] or
  /// [SwalvoParticipant.attributes] changed, local participant included.
  Stream<SwalvoParticipantMetadataChanged> get participantMetadataChanges =>
      _metadataController.stream;

  /// Live captions (phase6-contracts §4.1), while a transcription runs or
  /// an AI agent speaks. Interim segments share a `segmentId` and replace
  /// each other; the final one closes it, and a final with empty `text`
  /// means the interim was withdrawn and should be cleared.
  Stream<SwalvoTranscriptionSegment> get transcriptionSegments =>
      _transcriptionSegmentController.stream;

  /// The room's transcription started, stopped or failed (§4.3).
  Stream<SwalvoTranscriptionState> get transcriptionStateChanges =>
      _transcriptionStateController.stream;

  /// An AI agent in the room is listening, thinking, speaking or has ended
  /// (§4.2). A state that arrives before the agent joins the roster is
  /// reported when it joins. Also on [SwalvoParticipant.agentState].
  Stream<SwalvoAgentStateChanged> get agentStateChanges =>
      _agentStateController.stream;

  /// Whether the server supports data messages v2: topics, targeting,
  /// sender attribution and the lossy channel. False against an older
  /// server, where [sendData] options still work but recipients see an
  /// envelope they cannot parse.
  bool get supportsDataV2 => _engine.supportsDataV2;

  /// Whether the *signaling* connection is up. See
  /// [SwalvoConnectionState]: this says nothing about whether media is
  /// flowing, and reads `connected` for a room whose transport has
  /// failed. Pair it with [mediaState] before telling a user a call is
  /// working.
  SwalvoConnectionState get connectionState => _connectionState;

  /// Whether media can actually flow, read from the peer connection.
  ///
  /// The question [connectionState] cannot answer. A room that joined
  /// normally and then could not establish a transport — UDP blocked,
  /// TURN unreachable, the SFU never answering — reads
  /// `connectionState: connected` and `mediaState: failed`, and the
  /// second one is the diagnosis.
  ///
  /// [SwalvoMediaState.idle] until something is published or subscribed:
  /// no peer connection exists before then, and reporting a health for a
  /// connection that was never attempted would be an invention.
  SwalvoMediaState get mediaState => _engine.mediaState;

  /// Changes to [mediaState].
  ///
  /// Each listener is given the current value on subscribe, for the same
  /// reason [participantChanges] is: the interesting transition routinely
  /// happens while an application is still wiring itself up, and a plain
  /// broadcast stream drops it.
  Stream<SwalvoMediaState> get mediaStateChanges => Stream.multi((controller) {
        if (_disposed) {
          controller.close();
          return;
        }
        controller.add(_engine.mediaState);
        final subscription = _engine.mediaStates.listen(
          controller.add,
          onError: controller.addError,
          onDone: controller.close,
        );
        controller.onCancel = subscription.cancel;
      }, isBroadcast: true);

  /// The RTC server serving this room, by name. For support and
  /// diagnostics; never an address.
  String? get rtcServer => _rtcServer;

  /// The region the room was allocated in.
  String? get region => _region;

  /// This device's participant.
  SwalvoParticipant get localParticipant {
    final videoTracks = <SwalvoTrackKind, SwalvoRenderableTrack>{};
    final live = <SwalvoTrackKind>{};

    for (final published in _engine.publishedTracks) {
      final kind = trackKindFromSource(published.source);
      if (!published.muted) {
        live.add(kind);
      }
      if (!_isAudioKind(kind) && !published.muted) {
        videoTracks[kind] = SwalvoRenderableTrack(
          trackId: published.track.id ?? '',
          stream: published.stream,
          kind: kind,
        );
      }
    }

    final meta = _meta[_localIdentity];
    return SwalvoParticipant(
      identity: _localIdentity,
      isLocal: true,
      metadata: meta?.metadata,
      attributes: meta?.attributes ?? const {},
      videoTracks: videoTracks,
      liveSources: live,
      isSpeaking: _engine.isSpeaking(_localIdentity),
      audioLevel: _engine.audioLevelOf(_localIdentity),
      connectionQuality: _engine.qualityOf(_localIdentity),
      agentState: _agentStates[_localIdentity],
    );
  }

  /// Everyone else currently in the room.
  List<SwalvoParticipant> get remoteParticipants =>
      _remoteIdentities.map(_buildRemoteParticipant).toList(growable: false);

  /// Local participant first, then remotes: the order a grid renders in.
  List<SwalvoParticipant> get participants =>
      [localParticipant, ...remoteParticipants];

  SwalvoParticipant _buildRemoteParticipant(String identity) {
    final videoTracks = <SwalvoTrackKind, SwalvoRenderableTrack>{};
    final live = <SwalvoTrackKind>{};

    for (final subscription in _engine.subscribedTracks) {
      if (subscription.participantId != identity) continue;
      final kind = trackKindFromSource(subscription.source);
      if (subscription.muted) continue;

      live.add(kind);
      if (!_isAudioKind(kind)) {
        videoTracks[kind] = SwalvoRenderableTrack(
          trackId: subscription.trackId,
          stream: subscription.stream,
          kind: kind,
          subscriptionState: subscription.subscriptionState,
          layer: subscription.layer,
        );
      }
    }

    final meta = _meta[identity];
    return SwalvoParticipant(
      identity: identity,
      isLocal: false,
      metadata: meta?.metadata,
      attributes: meta?.attributes ?? const {},
      videoTracks: videoTracks,
      liveSources: live,
      isSpeaking: _engine.isSpeaking(identity),
      audioLevel: _engine.audioLevelOf(identity),
      connectionQuality: _engine.qualityOf(identity),
      agentState: _agentStates[identity],
    );
  }

  /// Snapshots for [ids], in order, skipping anyone the roster does not
  /// (yet, or any more) list.
  List<SwalvoParticipant> _participantsFor(Iterable<String> ids) {
    final result = <SwalvoParticipant>[];
    for (final id in ids) {
      final participant = _participantById(id);
      if (participant != null) result.add(participant);
    }
    return result;
  }

  SwalvoParticipant? _participantById(String id) {
    if (id == _localIdentity) return localParticipant;
    if (_remoteIdentities.contains(id)) return _buildRemoteParticipant(id);
    return null;
  }

  // ---------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------

  /// Captures and publishes the camera.
  ///
  /// Throws [SwalvoPermissionException] when the OS refuses access, rather
  /// than resolving to a silent black frame.
  Future<void> enableCamera() async {
    final existing = _engine.publishedTrack('camera');
    // Before capture: an E2EE room never lights the camera of a client
    // that could only send it in the clear.
    if (existing == null) _engine.assertMayPublish();
    if (existing != null) {
      // Already publishing: unmute instead of capture again. A second
      // capture of the same device is slower and, on some platforms,
      // fails outright.
      await _engine.setMuted('camera', false);
      _emitParticipants();
      return;
    }

    await _guardMedia(SwalvoPermission.camera, () async {
      final stream = await rtc.navigator.mediaDevices
          .getUserMedia({'video': _cameraConstraints, 'audio': false});
      final track = stream.getVideoTracks().first;
      await _engine.publish(source: 'camera', stream: stream, track: track);
    });
    _emitParticipants();
  }

  /// Stops publishing and releases the camera.
  Future<void> disableCamera() async {
    await _guardMedia(
      SwalvoPermission.camera,
      () => _engine.unpublish('camera'),
    );
    _emitParticipants();
  }

  Future<void> enableMicrophone() async {
    final existing = _engine.publishedTrack('microphone');
    if (existing == null) _engine.assertMayPublish();
    if (existing != null) {
      await _engine.setMuted('microphone', false);
      _emitParticipants();
      return;
    }

    await _guardMedia(SwalvoPermission.microphone, () async {
      // Video explicitly false: spec §13 requires that an audio-only call
      // never asks for camera permission.
      final stream = await rtc.navigator.mediaDevices
          .getUserMedia({'audio': _microphoneConstraints, 'video': false});
      final track = stream.getAudioTracks().first;
      await _engine.publish(source: 'microphone', stream: stream, track: track);
    });
    _emitParticipants();
  }

  Future<void> disableMicrophone() async {
    await _guardMedia(
      SwalvoPermission.microphone,
      () => _engine.unpublish('microphone'),
    );
    _emitParticipants();
  }

  /// Mutes the microphone without unpublishing it.
  ///
  /// Preferable to `disableMicrophone()` for a mute button: the track
  /// stays published, so unmuting is instant and other participants keep
  /// the tile, not seeing it disappear and come back.
  Future<void> setMicrophoneMuted(bool muted) async {
    await _engine.setMuted('microphone', muted);
    _emitParticipants();
  }

  /// Mutes the camera without unpublishing it. See [setMicrophoneMuted].
  Future<void> setCameraMuted(bool muted) async {
    await _engine.setMuted('camera', muted);
    _emitParticipants();
  }

  /// Starts screen sharing.
  ///
  /// Both platforms show a system consent dialog first, and both can have
  /// it dismissed: that surfaces as a [SwalvoException], not a silent
  /// no-op. On iOS this additionally requires a Broadcast Upload
  /// Extension in the host app; see docs/sdk/flutter.md#screen-sharing.
  ///
  /// With [audio] true the capture also asks for the shared audio, which
  /// is published as [SwalvoTrackKind.screenShareAudio] when the platform
  /// returns any. Today that is Flutter Web on Chrome/Edge (a tab, or the
  /// whole system on Windows/ChromeOS). flutter_webrtc's native iOS and
  /// Android capturers return no audio track, so there it is video only;
  /// check [SwalvoParticipant.isScreenShareAudioEnabled] afterwards.
  Future<void> enableScreenShare({bool audio = false}) async {
    _engine.assertMayPublish();
    await _guardMedia(SwalvoPermission.camera, () async {
      final stream = await rtc.navigator.mediaDevices
          .getDisplayMedia({'video': true, 'audio': audio});
      final tracks = stream.getVideoTracks();
      if (tracks.isEmpty) {
        throw const SwalvoException(
          SwalvoErrorCode.mediaError,
          'Screen capture returned no video track.',
        );
      }
      await _engine.publish(
          source: 'screenShare', stream: stream, track: tracks.first);
      final audioTracks =
          audio ? stream.getAudioTracks() : const <rtc.MediaStreamTrack>[];
      if (audioTracks.isNotEmpty) {
        try {
          await _engine.publish(
              source: 'screenShareAudio',
              stream: stream,
              track: audioTracks.first);
        } catch (error) {
          // The video is already out; losing the audio is not worth
          // failing the share over, but it is worth saying.
          developer.log('could not publish screen share audio',
              name: 'swalvo_rtc', level: 900, error: error);
        }
      } else if (audio) {
        developer.log(
            'enableScreenShare(audio: true): this platform returned no audio track',
            name: 'swalvo_rtc',
            level: 800);
      }
    });
    _emitParticipants();
  }

  /// Stops the screen share, and its audio with it.
  Future<void> disableScreenShare() async {
    await _guardMedia(SwalvoPermission.camera, () async {
      if (_engine.publishedTrack('screenShareAudio') != null) {
        await _engine.unpublish('screenShareAudio');
      }
      await _engine.unpublish('screenShare');
    });
    _emitParticipants();
  }

  /// Switches between the front and rear camera.
  ///
  /// A phone-only concern with no web equivalent, and common enough to
  /// deserve a first-class method rather than device enumeration.
  ///
  /// Uses the platform's in-place switch where available, which keeps the
  /// same track and sender, so nobody else in the room observes anything.
  Future<void> switchCamera() async {
    final published = _engine.publishedTrack('camera');
    if (published == null) {
      throw const SwalvoException(
        SwalvoErrorCode.deviceNotFound,
        'No camera is currently publishing — call enableCamera() first.',
      );
    }

    try {
      await rtc.Helper.switchCamera(published.track);
    } catch (error) {
      throw SwalvoException(
        SwalvoErrorCode.mediaError,
        'Could not switch camera.',
        error,
      );
    }
    _emitParticipants();
  }

  /// Sends a payload to everyone else in the room over the data channel.
  ///
  /// Rides WebRTC instead of the signaling socket, so it gets the same
  /// NAT traversal and DTLS encryption as media (but never E2EE, even in
  /// an E2EE room) and does not compete with negotiation for the control
  /// connection (spec §18).
  ///
  /// * [topic] (at most 255 UTF-8 bytes) arrives as
  ///   [SwalvoDataMessage.topic].
  /// * [destinationIdentities] (at most 64) limits delivery to those
  ///   participants; unknown identities are skipped. Empty or null means
  ///   everyone.
  /// * [reliable] `false` sends on the lossy channel: unordered, never
  ///   retransmitted, at most 1,200 bytes. Against a server without
  ///   `data.v2` it falls back to the reliable channel.
  ///
  /// Reliable payloads are limited to 64 KiB. A limit broken throws
  /// [SwalvoErrorCode.invalidArgument] before anything is sent.
  Future<void> sendData(
    List<int> payload, {
    String? topic,
    List<String>? destinationIdentities,
    bool reliable = true,
  }) async {
    try {
      await _engine.sendData(
        payload,
        topic: topic,
        destinationIdentities: destinationIdentities,
        reliable: reliable,
      );
    } catch (error) {
      if (error is SwalvoException) rethrow;
      throw SwalvoException(
        SwalvoErrorCode.mediaError,
        'Could not send data.',
        error,
      );
    }
  }

  /// Replaces this participant's metadata (at most 4 KiB of UTF-8).
  ///
  /// Needs the token grant `perms.updateOwnMetadata`; without it this
  /// throws [SwalvoErrorCode.permissionDenied] and sends nothing. The new
  /// value is applied when the server confirms it, as a
  /// [participantMetadataChanges] event, never optimistically.
  Future<void> setMetadata(String metadata) async {
    _assertMayUpdateMetadata();
    final bytes = utf8.encode(metadata).length;
    if (bytes > maxMetadataBytes) {
      throw SwalvoException(
        SwalvoErrorCode.invalidArgument,
        'Metadata is $bytes bytes, over the $maxMetadataBytes-byte limit.',
      );
    }
    _sendParticipantUpdate({'metadata': metadata});
  }

  /// Sets attributes on this participant. Keys given replace their
  /// current values; keys not given are kept.
  ///
  /// At most 32 keys, 64-character keys and 1 KiB values. Needs
  /// `perms.updateOwnMetadata`, as [setMetadata] does.
  Future<void> setAttributes(Map<String, String> attributes) async {
    _assertMayUpdateMetadata();
    if (attributes.length > maxAttributeCount) {
      throw SwalvoException(
        SwalvoErrorCode.invalidArgument,
        'At most $maxAttributeCount attributes, not ${attributes.length}.',
      );
    }
    attributes.forEach((key, value) {
      final keyLength = key.runes.length;
      if (keyLength == 0 || keyLength > maxAttributeKeyLength) {
        throw SwalvoException(
          SwalvoErrorCode.invalidArgument,
          'Attribute keys must be 1-$maxAttributeKeyLength characters: "$key".',
        );
      }
      final valueBytes = utf8.encode(value).length;
      if (valueBytes > maxAttributeValueBytes) {
        throw SwalvoException(
          SwalvoErrorCode.invalidArgument,
          'The value of attribute "$key" is $valueBytes bytes, over the $maxAttributeValueBytes-byte limit.',
        );
      }
    });
    _sendParticipantUpdate({'attributes': attributes});
  }

  void _assertMayUpdateMetadata() {
    if (_engine.grants?.updateOwnMetadata != true) {
      throw const SwalvoException(
        SwalvoErrorCode.permissionDenied,
        'This token does not grant perms.updateOwnMetadata, so this participant cannot change its own metadata or attributes.',
      );
    }
  }

  void _sendParticipantUpdate(Map<String, dynamic> fields) {
    if (_connectionState != SwalvoConnectionState.connected) {
      throw const SwalvoException(
        SwalvoErrorCode.connectionFailed,
        'Updating metadata requires a connected room.',
      );
    }
    _signaling.send({'type': ClientMessageType.participantUpdate, ...fields});
  }

  /// Asks the SFU for a specific simulcast layer of a subscribed track.
  ///
  /// A preference, not a command: the SFU will not hand over a layer the
  /// publisher is not sending, and congestion control may hold the
  /// subscriber below what was asked for. [SwalvoVideoView] calls this on
  /// your behalf when `adaptiveStream` is on.
  ///
  /// # Precedence
  ///
  /// Calling this **pins** the track. Adaptive streaming will not move it
  /// afterwards, however the tile is resized, so a call here is not quietly
  /// undone by the next layout pass. Pass [SwalvoVideoLayer.auto] to release
  /// the pin and hand the track back to adaptive streaming — or, with
  /// adaptive streaming off, to hand the choice back to the SFU.
  ///
  /// Works with `adaptiveStream: false` too. That combination means "I will
  /// manage quality myself", which is a reasonable thing to want; it used
  /// to be ignored.
  /// [layer] is `'low'`, `'medium'`, `'high'`, or `'auto'`. Kept a plain
  /// String rather than an enum so existing callers keep compiling.
  void requestLayer(
    SwalvoParticipant participant,
    SwalvoTrackKind kind,
    String layer,
  ) {
    final track = participant.videoTrackFor(kind);
    if (track == null) return;
    _engine.requestLayer(participant.identity, track.trackId, layer);
  }

  /// Pauses (`false`) or resumes (`true`) a remote participant's video.
  ///
  /// The SFU stops forwarding it to this device — no renegotiation, the
  /// track stays subscribed — and stops counting this device's demand for
  /// it, so the publisher may stop encoding layers only it was receiving
  /// (phase2-media-contracts §4, §5). Audio is unaffected.
  ///
  /// Outranks everything: a paused track stays paused however its views
  /// are sized or shown, and whatever [requestLayer] pinned. Resuming hands
  /// it back to that pin, to adaptive streaming, or to the SFU. Survives a
  /// reconnect, like a pin.
  void setVideoEnabled(
    SwalvoParticipant participant,
    SwalvoTrackKind kind,
    bool enabled,
  ) {
    final track = participant.videoTrackFor(kind);
    if (track == null || participant.isLocal) return;
    _engine.setVideoEnabled(participant.identity, track.trackId, enabled);
  }

  /// Whether [setVideoEnabled] has paused this participant's video.
  bool isVideoEnabled(SwalvoParticipant participant, SwalvoTrackKind kind) {
    final track = participant.videoTrackFor(kind);
    if (track == null) return true;
    return _engine.isVideoEnabled(participant.identity, track.trackId);
  }

  /// @internal From [SwalvoVideoView]: whether one view of a remote video is
  /// visible. See [SwalvoEngine.setViewVisibility].
  void setViewVisibility(
    String participantId,
    String trackId,
    Object view,
    bool visible,
  ) =>
      _engine.setViewVisibility(participantId, trackId, view, visible);

  /// @internal From [SwalvoVideoView]: one view of a remote video went away.
  void removeView(String participantId, String trackId, Object view) =>
      _engine.removeView(participantId, trackId, view);

  /// Whether a source this device publishes is genuinely sending a
  /// simulcast ladder.
  ///
  /// Read back from the negotiated sender, not from what was requested. A
  /// platform that refuses the ladder publishes one full-quality layer and
  /// reports [SwalvoSimulcastStatus.unsupported] here, having already logged
  /// a warning — subscribers then cannot drop to a cheaper layer, which is
  /// what makes a large call expensive for everyone in it.
  SwalvoSimulcastStatus simulcastStatusFor(SwalvoTrackKind kind) =>
      _engine.simulcastStatusFor(switch (kind) {
        SwalvoTrackKind.camera => 'camera',
        SwalvoTrackKind.microphone => 'microphone',
        SwalvoTrackKind.screenShare => 'screenShare',
        SwalvoTrackKind.screenShareAudio => 'screenShareAudio',
        SwalvoTrackKind.unknown => 'unknown',
      });

  /// @internal Adaptive streaming's own layer request, from
  /// [SwalvoVideoView]. Never overrides an application's pin.
  void requestLayerAutomatically(
    SwalvoParticipant participant,
    SwalvoTrackKind kind,
    SwalvoVideoLayer layer,
  ) {
    final track = participant.videoTrackFor(kind);
    if (track == null) return;
    _engine.requestLayer(
      participant.identity,
      track.trackId,
      layer.wireName,
      automatic: true,
    );
  }

  /// Leaves the room and releases all local media.
  Future<void> leave() async {
    try {
      _disconnectReason ??= SwalvoDisconnectReason.clientInitiated;
      await _signaling.close();
    } catch (_) {
      // Already gone. Leaving is the one operation that must never throw:
      // an app tearing a screen down has nothing useful to do with the
      // failure, and rethrowing here strands the UI.
    }
    _setConnectionState(SwalvoConnectionState.disconnected);
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;

    // Order matters. Cancel subscriptions before closing the controllers,
    // or a late event tries to add to a closed stream and throws from a
    // zone the app cannot catch.
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    _subscriptions.clear();

    _connectionStateController.close();
    _participantsController.close();
    _errorController.close();
    _dataController.close();
    _dataMessageController.close();
    _dataThrottledController.close();
    _metadataController.close();
    _transcriptionSegmentController.close();
    _transcriptionStateController.close();
    _agentStateController.close();
    _activeSpeakersController.close();
    _speakingController.close();
    _qualityController.close();
    _subscriptionStateController.close();

    // Both teardowns are async and ChangeNotifier.dispose() is not, so
    // they are explicitly unawaited, not silently dropped: the
    // teardown is fire-and-forget by design, and saying so keeps the
    // unawaited_futures lint meaningful everywhere else.
    unawaited(_engine.dispose());
    unawaited(_signaling.dispose());
    super.dispose();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  void _wire() {
    _subscriptions.add(_engine.changes.listen((_) => _emitParticipants()));
    _subscriptions.add(_engine.errors.listen(_emitError));
    _subscriptions.add(_engine.speakerEvents.listen((event) {
      if (_disposed) return;
      _activeSpeakersController.add(_participantsFor(event.speakers));
      if (event.changed.isEmpty) return;
      for (final participant in _participantsFor(event.changed)) {
        _speakingController.add(participant);
      }
      // Speaking is on the snapshot, so a transition is a roster change.
      // A level-only update is not: rebuilding every tile three times a
      // second for a meter only one widget draws is the wrong trade.
      _emitParticipants();
    }));
    _subscriptions.add(_engine.qualityEvents.listen((ids) {
      if (_disposed) return;
      for (final participant in _participantsFor(ids)) {
        _qualityController.add(SwalvoConnectionQualityUpdate(
            participant, participant.connectionQuality));
      }
      _emitParticipants();
    }));
    _subscriptions.add(_engine.subscriptionStateEvents.listen((event) {
      if (_disposed) return;
      final participant = _participantById(event.participantId);
      if (participant == null) return;
      for (final kind in const [
        SwalvoTrackKind.camera,
        SwalvoTrackKind.screenShare,
        SwalvoTrackKind.unknown,
      ]) {
        final track = participant.videoTrackFor(kind);
        if (track == null || track.trackId != event.trackId) continue;
        _subscriptionStateController.add(SwalvoSubscriptionStateUpdate(
          participant: participant,
          kind: kind,
          state: track.subscriptionState,
          layer: track.layer,
        ));
      }
    }));
    _subscriptions.add(_engine.data.listen((message) {
      if (_disposed) return;
      _dataController.add(message.payload);
      final sender = message.senderIdentity;
      final topic = message.topic;
      _dataMessageController.add(SwalvoDataMessage(
        payload: message.payload,
        participant: sender == null || sender.isEmpty
            ? null
            : (_remoteIdentities.contains(sender)
                ? _buildRemoteParticipant(sender)
                : null),
        topic: topic == null || topic.isEmpty ? null : topic,
      ));
    }));

    _subscriptions.add(_signaling.messages.listen((message) {
      switch (message['type']) {
        case ServerMessageType.participantJoined:
          final participant = message['participant'] as Map<String, dynamic>?;
          final identity = participant?['id'] as String?;
          if (identity != null && !_remoteIdentities.contains(identity)) {
            _remoteIdentities.add(identity);
            _storeMeta(ServerParticipant.fromJson(participant!));
            _emitParticipants();
            _flushPendingAgentState(identity);
          }
        case ServerMessageType.participantLeft:
          final participant = message['participant'] as Map<String, dynamic>?;
          final identity = participant?['id'] as String?;
          if (identity != null && _remoteIdentities.remove(identity)) {
            _meta.remove(identity);
            _agentStates.remove(identity);
            _pendingAgentStates.remove(identity);
            _emitParticipants();
          }
        case ServerMessageType.participantUpdated:
          _applyParticipantUpdated(message);
        case ServerMessageType.dataThrottled:
          final channel = message['channel'] == 'lossy'
              ? SwalvoDataChannelKind.lossy
              : SwalvoDataChannelKind.reliable;
          developer.log(
            'data messages throttled by the server on the ${channel.name} channel; some were dropped',
            name: 'swalvo_rtc',
            level: 900,
          );
          if (!_disposed) {
            _dataThrottledController.add(SwalvoDataThrottled(channel));
          }
        case ServerMessageType.transcriptionSegment:
          final segment = SwalvoTranscriptionSegment.fromJson(message);
          if (segment != null && !_disposed) {
            _transcriptionSegmentController.add(segment);
          }
        case ServerMessageType.transcriptionState:
          final state = SwalvoTranscriptionState.fromJson(message);
          if (state != null && !_disposed) {
            _transcriptionStateController.add(state);
          }
        case ServerMessageType.agentState:
          _applyAgentState(message);
      }
    }));

    _subscriptions.add(_signaling.joins.listen(_handleJoined));

    _subscriptions.add(_signaling.lifecycle.listen((state) {
      switch (state) {
        case SignalingReconnecting(:final resuming):
          _setConnectionState(SwalvoConnectionState.reconnecting);
          if (resuming) {
            // The server may re-bind our SFU session, in which case this
            // peer connection never stopped carrying media. Kept until the
            // join says either way.
            _awaitingResume = true;
          } else {
            // Nothing to resume: the server allocates a fresh session on
            // rejoin, so the old peer connection is not reusable.
            _awaitingResume = false;
            unawaited(_engine.resetPeerConnection());
          }
        case SignalingClosed():
          _disconnectReason ??= SwalvoDisconnectReason.clientInitiated;
          _setConnectionState(SwalvoConnectionState.disconnected);
        case SignalingFailed(:final error, :final reason):
          _disconnectReason = reason;
          _setConnectionState(SwalvoConnectionState.failed);
          _emitError(error);
        case SignalingEnded(:final reason):
          // Removed, or the room closed (§1.5). Not an error, and no
          // reconnect: release the devices and report why.
          _disconnectReason = reason;
          unawaited(_engine.endSession());
          _setConnectionState(SwalvoConnectionState.disconnected);
      }
    }));
  }

  /// Runs on the first join (via [applyInitialJoin]) and on every
  /// reconnect (via the `signaling.joins` subscription in [_wire]).
  ///
  /// A reconnect re-runs the join, so the reported roster is
  /// authoritative. Replacing rather than merging is what stops a
  /// participant who left during an outage from lingering. Applying the
  /// engine's side ([SwalvoEngine.applyJoinedState]) here too, rather than
  /// leaving it to whoever handles `sdp.offer`, is what restores tracks
  /// published right before a reconnect: the SFU's post-reconnect roster
  /// already lists them, and this is where that roster becomes the
  /// engine's own state, ahead of any renegotiation.
  void _handleJoined(JoinedPayload payload) {
    final wasAwaitingResume = _awaitingResume;
    _awaitingResume = false;
    if (!payload.resumed) {
      if (wasAwaitingResume) {
        // The server started a fresh session after all; the kept peer
        // connection belongs to one that no longer exists. The reset's
        // synchronous part clears the engine's per-connection state before
        // the roster below is applied.
        unawaited(_engine.resetPeerConnection());
      }
      // No-op unless a reset discarded live publications.
      unawaited(_engine.republishAfterRebuild());
    }
    _applyJoined(payload);
    _engine.applyJoinedState(payload);
    _setConnectionState(SwalvoConnectionState.connected);
    _emitParticipants();
    for (final identity in _pendingAgentStates.toList()) {
      _flushPendingAgentState(identity);
    }
  }

  /// `agent.state` (phase6-contracts §4.2). Unknown states are ignored. A
  /// state for someone not yet in the roster is held (latest wins) until
  /// they join; `ended` for someone not in it is dropped.
  void _applyAgentState(Map<String, dynamic> message) {
    final identity = message['participantId'];
    final state = SwalvoAgentState.fromWire(message['state']);
    if (identity is! String || identity.isEmpty || state == null) return;
    final known =
        identity == _localIdentity || _remoteIdentities.contains(identity);
    if (!known) {
      if (state == SwalvoAgentState.ended) {
        _agentStates.remove(identity);
        _pendingAgentStates.remove(identity);
      } else {
        _agentStates[identity] = state;
        _pendingAgentStates.add(identity);
      }
      return;
    }
    // A repeated frame is not a change (same as the JS and native SDKs).
    if (_agentStates[identity] == state) return;
    _agentStates[identity] = state;
    _emitAgentState(identity);
  }

  void _flushPendingAgentState(String identity) {
    if (!_pendingAgentStates.remove(identity)) return;
    _emitAgentState(identity);
  }

  void _emitAgentState(String identity) {
    if (_disposed) return;
    final state = _agentStates[identity];
    final participant = _participantById(identity);
    if (state == null || participant == null) return;
    _agentStateController.add(SwalvoAgentStateChanged(participant, state));
    _emitParticipants();
  }

  void _applyJoined(JoinedPayload payload) {
    _rtcServer = payload.rtcServer;
    _region = payload.region;
    _remoteIdentities
      ..clear()
      ..addAll(payload.participants.map((participant) => participant.id));
    _meta.removeWhere((identity, _) =>
        identity != _localIdentity && !_remoteIdentities.contains(identity));
    _agentStates.removeWhere((identity, _) =>
        identity != _localIdentity &&
        !_remoteIdentities.contains(identity) &&
        !_pendingAgentStates.contains(identity));
    for (final participant in payload.participants) {
      _storeMeta(participant);
    }
  }

  /// Records what `room.joined` / `participant.joined` said about someone.
  void _storeMeta(ServerParticipant participant) {
    final previous = _meta[participant.id];
    _meta[participant.id] = (
      metadata: participant.metadata ?? previous?.metadata,
      attributes: participant.attributes != null
          ? Map.unmodifiable(participant.attributes!)
          : (previous?.attributes ?? const <String, String>{}),
    );
  }

  /// `participant.updated` (phase7-contracts §2): replaces whichever of
  /// the two fields it carries, and reports a change only when there was
  /// one.
  void _applyParticipantUpdated(Map<String, dynamic> message) {
    final identity = message['participantId'] as String?;
    if (identity == null || identity.isEmpty) return;
    if (identity != _localIdentity && !_remoteIdentities.contains(identity)) {
      return;
    }
    final previous = _meta[identity] ??
        (metadata: null, attributes: const <String, String>{});
    final metadata = message.containsKey('metadata')
        ? (message['metadata'] is String ? message['metadata'] as String : null)
        : previous.metadata;
    final attributes =
        parseAttributes(message['attributes']) ?? previous.attributes;
    if (metadata == previous.metadata &&
        mapEquals(attributes, previous.attributes)) {
      return;
    }
    _meta[identity] =
        (metadata: metadata, attributes: Map.unmodifiable(attributes));
    if (_disposed) return;
    final participant = _participantById(identity);
    if (participant != null) {
      _metadataController.add(SwalvoParticipantMetadataChanged(
        participant: participant,
        previousMetadata: previous.metadata,
        previousAttributes: previous.attributes,
      ));
    }
    _emitParticipants();
  }

  static bool _isAudioKind(SwalvoTrackKind kind) =>
      kind == SwalvoTrackKind.microphone ||
      kind == SwalvoTrackKind.screenShareAudio;

  void _setConnectionState(SwalvoConnectionState next) {
    if (_disposed || _connectionState == next) return;
    _connectionState = next;
    _connectionStateController.add(next);
    notifyListeners();
  }

  void _emitParticipants() {
    if (_disposed) return;
    _participantsController.add(participants);
    notifyListeners();
  }

  void _emitError(SwalvoException error) {
    if (_disposed) return;
    _errorController.add(error);
  }

  /// Runs a media operation and translates whatever the platform throws
  /// into Swalvo's vocabulary.
  Future<void> _guardMedia(
    SwalvoPermission permission,
    Future<void> Function() action,
  ) async {
    try {
      await action();
    } catch (error) {
      throw translateMediaError(permission, error);
    }
  }
}

/// Metadata and attribute limits (phase7-contracts §2).
const maxMetadataBytes = 4096;
const maxAttributeCount = 32;
const maxAttributeKeyLength = 64;
const maxAttributeValueBytes = 1024;

/// Turns a platform media failure into a Swalvo error.
///
/// The native layer reports a denied permission as a `PlatformException`
/// whose message varies by OS and OS version, so this matches on the
/// substance instead of an exact code. Getting it wrong in the safe
/// direction, reporting a generic media error, is better than telling a
/// user to visit Settings when the real problem is a camera another app is
/// holding.
SwalvoException translateMediaError(SwalvoPermission permission, Object error) {
  if (error is SwalvoException) return error;

  final text = error.toString().toLowerCase();

  if (text.contains('permission') ||
      text.contains('denied') ||
      text.contains('notallowed')) {
    return SwalvoPermissionException(
      permission,
      // The platform doesn't tell us whether this was permanent, and
      // guessing "permanent" would send users to Settings unnecessarily.
      permanentlyDenied: false,
      cause: error,
    );
  }

  if (text.contains('notfound') || text.contains('no device')) {
    return SwalvoException(
      SwalvoErrorCode.deviceNotFound,
      'No ${permission.name} is available on this device.',
      error,
    );
  }

  return SwalvoException(
    SwalvoErrorCode.mediaError,
    'Could not change the ${permission.name}.',
    error,
  );
}
