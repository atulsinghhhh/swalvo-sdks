import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
// ignore: implementation_imports
import 'package:flutter_webrtc/src/native/media_stream_impl.dart';
// ignore: implementation_imports
import 'package:flutter_webrtc/src/native/media_stream_track_impl.dart';

/// Fakes flutter_webrtc's native platform channel well enough for
/// [SwalvoEngine] to run its real SDP-negotiation and data-channel logic
/// against a scripted peer, instead of a live WebRTC stack.
///
/// This does not simulate ICE, DTLS or real media. It exists to prove the
/// SDK's own message-handling, negotiation-queue and data-channel logic
/// runs correctly end to end — the bugs this suite regression-tests were
/// all in that logic, not in flutter_webrtc or the native platform — not
/// to stand in for the live E2E media tests the fix ultimately needs
/// against a real SFU and real devices.
///
/// Modelled on flutter_webrtc's own
/// `test/unit/rtc_peerconnection_test.dart`: a peer connection's
/// `signalingState` and a data channel's `state` are only ever updated by
/// an event arriving on their respective `EventChannel`s
/// (`FlutterWebRTC/peerConnectionEvent<id>` and
/// `FlutterWebRTC/dataChannelEvent<peerConnectionId><flutterId>`), so a
/// test that needs a particular state has to deliver that event itself —
/// see [signalingState] and [openDataChannel].
class FakeWebRtcPlatform {
  FakeWebRtcPlatform() {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, _handle);
    // Subscribed to by flutter_webrtc itself, not by anything under test.
    _silenceEventChannel('FlutterWebRTC.Event');
  }

  static const _channel = MethodChannel('FlutterWebRTC.Method');
  static const _codec = StandardMethodCodec();

  int _pcCounter = 0;
  int _dcCounter = 0;
  int _senderCounter = 0;
  int _transceiverCounter = 0;
  int _textureCounter = 0;

  /// Every `transceiverInit` the SDK passed to `addTransceiver`, in order.
  ///
  /// This is the platform-channel payload itself, so a test asserting on it
  /// is asserting on what genuinely crossed the boundary into native code —
  /// the same map `PeerConnectionObserver.mapToEncoding` reads `rid`,
  /// `maxBitrate`, `maxFramerate` and `scaleResolutionDownBy` out of on
  /// Android.
  final transceiverInits = <Map<String, dynamic>>[];

  /// Every data channel the SDK created, in order.
  final createdDataChannels = <({
    String flutterId,
    int id,
    String label,
    Map<String, dynamic> init,
  })>[];

  /// Every `dataChannelSend`, in order: the channel and the exact bytes.
  final dataChannelSends = <({String flutterId, List<int> data})>[];

  /// Track ids passed to `rtpSenderReplaceTrack`, in order. Proves a
  /// republish reused its existing transceiver instead of adding an
  /// m-section.
  final replacedTracks = <String>[];

  /// Transceiver ids passed to `rtpTransceiverStop`, in order.
  final stoppedTransceivers = <String>[];

  /// Every `rtpSenderSetParameters` call, in order: the sender and the
  /// encodings exactly as they crossed the channel (`rid`, `active`, …).
  final setParametersCalls =
      <({String senderId, List<Map<String, dynamic>> encodings})>[];

  /// Makes `rtpSenderSetParameters` throw, as a platform refusing the
  /// change would.
  bool failSetParameters = false;

  /// Encodings per sender id, as the platform would report them back.
  final _senderEncodings = <String, List<Map<String, dynamic>>>{};

  /// m-sections the offer will describe, in order.
  final _mSections = <_MSection>[];
  final _transceiverMids = <String, String>{};

  final _localSdp = <String, String>{};
  final _localType = <String, String>{};

  /// The state `getSignalingState()` (the *live*, non-cached read) reports
  /// for each peer connection — driven by the actual `setLocalDescription`
  /// / `setRemoteDescription` calls received, exactly like a real
  /// RTCPeerConnection's signaling-state machine, not by an explicit event
  /// a test fires. [SwalvoEngine] reads this one to decide whether to
  /// negotiate or defer (see engine.dart's `_negotiatePublish` and
  /// `_handleOffer`) specifically because the *cached* `signalingState`
  /// getter (below, driven by [signalingState]) lags a real event's
  /// arrival on Flutter Web, which is the race the glare-recovery tests
  /// exist to catch.
  final _liveSignalingStates = <String, String>{};

  /// Every method invoked, in order — for asserting what the engine did
  /// (and did not do) without depending on its private fields.
  final calls = <String>[];

  // --- Phase 5: frame cryptor and codec preferences ---------------------

  /// The `keyProviderOptions` the SDK created its native key provider with.
  Map<String, dynamic>? keyProviderOptions;

  /// `keyProviderSetSharedKey` / `keyProviderSetKey` calls, in order.
  final keyCalls = <({String? participantId, int index, List<int> key})>[];

  /// `frameCryptorFactoryCreateFrameCryptor` arguments, in order.
  final frameCryptors = <Map<String, dynamic>>[];

  /// `frameCryptorSetEnabled` / `frameCryptorSetKeyIndex` / `frameCryptorDispose`, in order.
  final frameCryptorCalls = <({String method, Map<String, dynamic> args})>[];

  /// `setCodecPreferences` by transceiver id: the mime types, in order.
  final codecPreferences = <String, List<String>>{};

  /// What `getRtpSenderCapabilities` reports, by kind.
  final senderCapabilities = <String, List<Map<String, dynamic>>>{};

  /// Transceivers addTrack created, as `getTransceivers` reports them.
  final _addTrackTransceivers = <Map<String, dynamic>>[];

  /// Delivers a frame cryptor state change, as the native side would.
  Future<void> cryptorState(
          String frameCryptorId, String participantId, String state) =>
      _sendEvent(
        'FlutterWebRTC/frameCryptorEvent$frameCryptorId',
        {
          'event': 'frameCryptionStateChanged',
          'participantId': participantId,
          'state': state
        },
      );

  /// The `type` of every `setLocalDescription` call, in order — `offer`,
  /// `answer`, or `rollback`. `calls` alone can't distinguish these, and
  /// the glare-recovery tests need to prove a rollback specifically
  /// happened, not merely that *some* local description was set.
  final localDescriptionTypes = <String>[];

  /// The peer connection id `createPeerConnection` most recently minted.
  String? lastPeerConnectionId;

  /// Every stream id handed to `videoRendererSetSrcObject`, in order, with
  /// `null` for a detach.
  ///
  /// This is the boundary a video tile is actually judged at: a widget can
  /// hold the right track, in the right state, and still render nothing if
  /// the stream never reaches the renderer's texture. Asserting on the
  /// widget tree alone cannot tell those apart — see `video_view_test.dart`.
  final renderedStreamIds = <String?>[];

  /// Candidate strings that actually reached the platform. The boundary a
  /// remote candidate is judged at: an engine that buffers correctly gets
  /// its candidates here, one that drops them does not.
  final appliedCandidates = <String>[];

  /// How many candidates the platform refused for want of a remote
  /// description. Non-zero is normal — it is the race being survived.
  int rejectedCandidates = 0;

  /// Every `createOffer` constraint map, in order. `{'iceRestart': true}`
  /// marks an ICE restart.
  final offerConstraints = <Map<String, dynamic>>[];

  /// Peer connections that have had a remote description applied.
  final _remoteDescriptionSet = <String>{};

  /// Accepts `listen`/`cancel` on an EventChannel and delivers nothing.
  ///
  /// An EventChannel with no handler throws MissingPluginException the
  /// moment something subscribes, which fails a test for a reason that
  /// has nothing to do with what it is asserting.
  void _silenceEventChannel(String name) {
    final channel = MethodChannel(name, _codec);
    _silenced.add(channel);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (_) async => null);
  }

  final _silenced = <MethodChannel>[];

  /// Detaches the mock handlers. Call from `tearDown`.
  void dispose() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
    for (final channel in _silenced) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    }
    _silenced.clear();
  }

  Future<dynamic> _handle(MethodCall call) async {
    calls.add(call.method);
    final args = (call.arguments as Map?)?.cast<String, dynamic>() ?? const {};
    final peerConnectionId = args['peerConnectionId'] as String?;

    switch (call.method) {
      case 'createPeerConnection':
        // A real platform call crosses a genuine async boundary (native
        // code, or in a real browser a JS interop round trip), wide
        // enough for two callers racing to create one to both find
        // nothing there yet. A same-isolate mock otherwise resolves this
        // in roughly the same microtask it was called from, which closes
        // that window and would make the race this helper exists to
        // reproduce (see engine_test.dart's "concurrent callers" group)
        // impossible to hit deterministically.
        await Future<void>.delayed(Duration.zero);
        _pcCounter++;
        final id = 'pc-$_pcCounter';
        // RTCPeerConnection subscribes to this as soon as it is
        // constructed. Unhandled, it throws MissingPluginException into
        // the zone — invisible to a plain `test`, but a `testWidgets`
        // treats it as an unexpected framework error and fails whatever
        // was actually being asserted. Registering a handler only
        // satisfies `listen`; [_sendEvent] posts to the channel
        // directly, so the events tests deliver still arrive.
        _silenceEventChannel('FlutterWebRTC/peerConnectionEvent$id');
        lastPeerConnectionId = id;
        _liveSignalingStates[id] = 'stable';
        return {'peerConnectionId': id, 'sessionId': 'session-$_pcCounter'};

      case 'setLocalDescription':
        final description =
            (args['description'] as Map).cast<String, dynamic>();
        final type = description['type'] as String;
        localDescriptionTypes.add(type);
        _liveSignalingStates[peerConnectionId!] = switch (type) {
          'offer' => 'have-local-offer',
          'pranswer' => 'have-local-pranswer',
          'answer' || 'rollback' => 'stable',
          _ => _liveSignalingStates[peerConnectionId] ?? 'stable',
        };
        if (type == 'rollback') {
          // A real rollback discards the pending local offer rather than
          // replacing it with new SDP; nothing meaningful to store.
          return null;
        }
        _localSdp[peerConnectionId] = description['sdp'] as String;
        _localType[peerConnectionId] = type;
        return null;

      case 'getLocalDescription':
        final sdp = _localSdp[peerConnectionId];
        if (sdp == null) return null;
        return {'sdp': sdp, 'type': _localType[peerConnectionId]};

      case 'createOffer':
        offerConstraints.add(
          (args['constraints'] as Map?)?.cast<String, dynamic>() ?? const {},
        );
        return {'sdp': _buildOfferSdp(), 'type': 'offer'};

      case 'createAnswer':
        return {
          'sdp': 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\n',
          'type': 'answer',
        };

      case 'addTrack':
        _senderCounter++;
        final senderId = 'sender-$_senderCounter';
        // A sender from addTrack has exactly one encoding and no RID —
        // that is the whole reason simulcast cannot be bolted on
        // afterwards. Modelled faithfully, because a fake that handed back
        // three RIDs here would make the broken implementation pass.
        _senderEncodings[senderId] = const [];
        _mSections.add(_MSection(
          kind: 'video',
          mid: '${_mSections.length}',
          direction: 'sendrecv',
          rids: const [],
        ));
        final addedSender = {
          'senderId': senderId,
          'ownsTrack': true,
          'dtmfSenderId': 'dtmf-$_senderCounter',
          'track': {
            'id': args['trackId'],
            'label': 'fake',
            'kind': 'video',
            'enabled': true,
          },
          'rtpParameters': {
            'transactionId': 't-$_senderCounter',
            'encodings': const [],
            'headerExtensions': const [],
            'codecs': const [],
            'rtcp': const {'cname': '', 'reducedSize': false},
          },
        };
        _addTrackTransceivers.add({
          'transceiverId': 'track-transceiver-$_senderCounter',
          'direction': 'sendrecv',
          'mid': '${_mSections.length - 1}',
          'sender': addedSender,
          'receiver': {
            'receiverId': 'track-receiver-$_senderCounter',
            'track': {
              'id': 'recv-$senderId',
              'label': 'fake',
              'kind': 'video',
              'enabled': true
            },
            'rtpParameters': {
              'transactionId': 'rt-$_senderCounter',
              'encodings': const [],
              'headerExtensions': const [],
              'codecs': const [],
              'rtcp': const {'cname': '', 'reducedSize': false},
            },
          },
        });
        return addedSender;

      case 'addTransceiver':
        _senderCounter++;
        _transceiverCounter++;
        final transceiverSenderId = 'sender-$_senderCounter';
        final transceiverId = 'transceiver-$_transceiverCounter';
        final init =
            (args['transceiverInit'] as Map?)?.cast<String, dynamic>() ??
                const {};
        final encodings = ((init['sendEncodings'] as List?) ?? const [])
            .map((encoding) => (encoding as Map).cast<String, dynamic>())
            .toList(growable: false);

        // Recorded verbatim so a test can assert on exactly what the SDK
        // asked the platform for — RIDs, scale factors, bitrates and frame
        // rates — rather than on the SDK's own notion of what it sent.
        transceiverInits.add(init);
        _senderEncodings[transceiverSenderId] = encodings;

        final mid = '${_mSections.length}';
        _transceiverMids[transceiverId] = mid;
        _mSections.add(_MSection(
          kind: (args['mediaType'] as String?) == 'audio' ? 'audio' : 'video',
          mid: mid,
          direction:
              (init['direction'] as String?)?.replaceAll('Only', 'only') ??
                  'sendrecv',
          rids: encodings
              .map((encoding) => encoding['rid'] as String?)
              .whereType<String>()
              .toList(growable: false),
        ));

        return {
          'transceiverId': transceiverId,
          'direction': init['direction'] ?? 'sendrecv',
          'mid': mid,
          'sender': {
            'senderId': transceiverSenderId,
            'ownsTrack': true,
            'dtmfSenderId': 'dtmf-$_senderCounter',
            'track': {
              'id': args['trackId'],
              'label': 'fake',
              'kind': 'video',
              'enabled': true,
            },
            'rtpParameters': {
              'transactionId': 't-$_senderCounter',
              'encodings': encodings,
              'headerExtensions': const [],
              'codecs': const [],
              'rtcp': const {'cname': '', 'reducedSize': false},
            },
          },
          'receiver': {
            'receiverId': 'receiver-$_transceiverCounter',
            'track': {
              'id': 'recv-${args['trackId']}',
              'label': 'fake',
              'kind': 'video',
              'enabled': true,
            },
            'rtpParameters': {
              'transactionId': 'rt-$_transceiverCounter',
              'encodings': const [],
              'headerExtensions': const [],
              'codecs': const [],
              'rtcp': const {'cname': '', 'reducedSize': false},
            },
          },
        };

      case 'rtpTransceiverSetDirection':
        final transceiverId = args['transceiverId'] as String;
        final mid = _transceiverMids[transceiverId];
        if (mid != null) {
          for (final section in _mSections) {
            if (section.mid == mid) {
              section.direction =
                  (args['direction'] as String).replaceAll('Only', 'only');
            }
          }
        }
        return null;

      case 'rtpTransceiverStop':
        final transceiverId = args['transceiverId'] as String;
        stoppedTransceivers.add(transceiverId);
        final mid = _transceiverMids[transceiverId];
        if (mid != null) {
          for (final section in _mSections) {
            if (section.mid == mid) section.direction = 'inactive';
          }
        }
        return null;

      case 'rtpSenderReplaceTrack':
        replacedTracks.add(args['trackId'] as String? ?? '');
        return null;

      case 'rtpSenderSetParameters':
        final parameters =
            (args['parameters'] as Map?)?.cast<String, dynamic>() ?? const {};
        final encodings = ((parameters['encodings'] as List?) ?? const [])
            .map((encoding) => (encoding as Map).cast<String, dynamic>())
            .toList(growable: false);
        setParametersCalls.add((
          senderId: args['rtpSenderId'] as String? ?? '',
          encodings: encodings,
        ));
        if (failSetParameters) {
          throw PlatformException(
            code: 'rtpSenderSetParametersFailed',
            message: 'refused by the fake',
          );
        }
        return {'result': true};

      case 'createDataChannel':
        _dcCounter++;
        createdDataChannels.add((
          flutterId: 'dc-$_dcCounter',
          id: _dcCounter,
          label: args['label'] as String? ?? '',
          init: (args['dataChannelDict'] as Map?)?.cast<String, dynamic>() ??
              const <String, dynamic>{},
        ));
        return {'id': _dcCounter, 'flutterId': 'dc-$_dcCounter'};

      case 'getSignalingState':
        return {'state': _liveSignalingStates[peerConnectionId] ?? 'stable'};

      case 'setRemoteDescription':
        final description =
            (args['description'] as Map).cast<String, dynamic>();
        final type = description['type'] as String;
        _remoteDescriptionSet.add(peerConnectionId!);
        _liveSignalingStates[peerConnectionId] = switch (type) {
          'offer' => 'have-remote-offer',
          'pranswer' => 'have-remote-pranswer',
          'answer' => 'stable',
          _ => _liveSignalingStates[peerConnectionId] ?? 'stable',
        };
        return null;

      case 'addCandidate':
        // The real platform refuses a candidate before a remote
        // description exists, which is exactly the window the SFU
        // trickles into. Modelling it is what makes the buffer-and-drain
        // behaviour testable at all — a fake that silently accepts
        // everything cannot tell a dropped candidate from an applied one.
        if (_remoteDescriptionSet.contains(peerConnectionId)) {
          appliedCandidates.add(
            ((args['candidate'] as Map).cast<String, dynamic>()['candidate']
                    as String?) ??
                '',
          );
          return null;
        }
        rejectedCandidates++;
        throw PlatformException(
          code: 'addCandidateFailed',
          message: 'The remote description was null',
        );

      case 'setConfiguration':
      case 'addStream':
      case 'removeStream':
      case 'peerConnectionDispose':
      case 'peerConnectionClose':
      // A texture id is all `RTCVideoRenderer.initialize()` wants back;
      // everything after it is bookkeeping against that number.
      case 'createVideoRenderer':
        final textureId = ++_textureCounter;
        // The renderer subscribes to this the moment it has an id, and an
        // unhandled EventChannel fails the test with a
        // MissingPluginException that has nothing to do with what is
        // being asserted.
        _silenceEventChannel('FlutterWebRTC/Texture$textureId');
        return {'textureId': textureId};

      case 'videoRendererSetSrcObject':
        // flutter_webrtc sends the empty string, not null, to detach —
        // recorded as null so a test can say "nothing is bound" without
        // knowing that.
        final streamId = args['streamId'] as String?;
        renderedStreamIds
            .add(streamId == null || streamId.isEmpty ? null : streamId);
        return null;

      case 'dataChannelSend':
        dataChannelSends.add((
          flutterId: args['dataChannelId'] as String? ?? '',
          data: List<int>.from(args['data'] as List),
        ));
        return null;

      case 'videoRendererDispose':
      case 'dataChannelClose':
      case 'dataChannelDispose':
        return null;

      case 'getTransceivers':
        return {'transceivers': _addTrackTransceivers};

      case 'getRtpSenderCapabilities':
        return {
          'codecs': senderCapabilities[args['kind']] ?? const [],
          'headerExtensions': const [],
          'fecMechanisms': const [],
        };

      case 'setCodecPreferences':
        codecPreferences[args['transceiverId'] as String] =
            ((args['codecs'] as List?) ?? const [])
                .map((codec) => (codec as Map)['mimeType'] as String)
                .toList(growable: false);
        return null;

      case 'frameCryptorFactoryCreateKeyProvider':
        keyProviderOptions =
            (args['keyProviderOptions'] as Map).cast<String, dynamic>();
        return {'keyProviderId': 'key-provider-1'};

      case 'keyProviderSetSharedKey':
      case 'keyProviderSetKey':
        keyCalls.add((
          participantId: args['participantId'] as String?,
          index: args['keyIndex'] as int,
          key: List<int>.from(args['key'] as List),
        ));
        return {'result': true};

      case 'keyProviderRatchetSharedKey':
      case 'keyProviderRatchetKey':
        return {
          'result': Uint8List.fromList(const [9, 9, 9])
        };

      case 'keyProviderDispose':
        return null;

      case 'frameCryptorFactoryCreateFrameCryptor':
        frameCryptors.add(args);
        final id = 'frame-cryptor-${frameCryptors.length}';
        _silenceEventChannel('FlutterWebRTC/frameCryptorEvent$id');
        return {'frameCryptorId': id};

      case 'frameCryptorSetEnabled':
      case 'frameCryptorSetKeyIndex':
      case 'frameCryptorDispose':
        frameCryptorCalls.add((method: call.method, args: args));
        return {'result': true};

      default:
        return null;
    }
  }

  /// Delivers a `signalingState` event for [peerConnectionId], as the
  /// native side would after every `setLocalDescription` /
  /// `setRemoteDescription`. `SwalvoEngine._negotiatePublish` reads
  /// `RTCPeerConnection.signalingState`, which flutter_webrtc only ever
  /// updates from an event like this one — never from the method-channel
  /// response of the call that changed it.
  Future<void> signalingState(String peerConnectionId, String state) {
    // Also drives the live-read path ([_liveSignalingStates]), so a test
    // that forces a state this way (rather than through an actual
    // setLocalDescription/setRemoteDescription call) is visible to
    // getSignalingState() too, not only the cached property.
    _liveSignalingStates[peerConnectionId] = state;
    return _sendEvent(
      'FlutterWebRTC/peerConnectionEvent$peerConnectionId',
      {'event': 'signalingState', 'state': state},
    );
  }

  /// Delivers a `peerConnectionState` event for [peerConnectionId]:
  /// `new`, `connecting`, `connected`, `disconnected`, `failed` or
  /// `closed`.
  ///
  /// The only route to this state. flutter_webrtc updates
  /// `RTCPeerConnection.connectionState` and fires `onConnectionState`
  /// from this event alone, never from a method-channel response — which
  /// is the whole reason the SDK could not report media health before it
  /// listened for it.
  Future<void> peerConnectionState(String peerConnectionId, String state) {
    return _sendEvent(
      'FlutterWebRTC/peerConnectionEvent$peerConnectionId',
      {'event': 'peerConnectionState', 'state': state},
    );
  }

  /// Delivers a `dataChannelStateChanged: open` event for the most
  /// recently created data channel, as the native side would once the
  /// SCTP association finishes coming up.
  Future<void> openDataChannel(String peerConnectionId) {
    return _sendEvent(
      'FlutterWebRTC/dataChannelEvent$peerConnectionId'
      'dc-$_dcCounter',
      {
        'event': 'dataChannelStateChanged',
        'id': _dcCounter,
        'flutterId': 'dc-$_dcCounter',
        'state': 'open',
      },
    );
  }

  /// Opens one specific data channel (by label), as the native side would.
  Future<void> openDataChannelLabeled(String peerConnectionId, String label) {
    final channel = createdDataChannels.lastWhere((c) => c.label == label);
    return _sendEvent(
      'FlutterWebRTC/dataChannelEvent$peerConnectionId${channel.flutterId}',
      {
        'event': 'dataChannelStateChanged',
        'id': channel.id,
        'flutterId': channel.flutterId,
        'state': 'open',
      },
    );
  }

  /// Delivers a binary message on the data channel with [label].
  Future<void> receiveDataChannelMessage(
      String peerConnectionId, String label, List<int> bytes) {
    final channel = createdDataChannels.lastWhere((c) => c.label == label);
    return _sendEvent(
      'FlutterWebRTC/dataChannelEvent$peerConnectionId${channel.flutterId}',
      {
        'event': 'dataChannelReceiveMessage',
        'id': channel.id,
        'type': 'binary',
        'data': Uint8List.fromList(bytes),
      },
    );
  }

  /// Builds an offer describing the transceivers that were actually created.
  ///
  /// # What this models, and what it cannot
  ///
  /// It follows RFC 8853 for the parts that matter here: a send transceiver
  /// carrying RIDs gets one `a=rid:<id> send` line per layer and a single
  /// `a=simulcast:send <ids>` line, and a transceiver without RIDs gets
  /// neither. That is enough to make the distinction the SDK was previously
  /// getting wrong *visible in the SDP*, which is the only place the claim
  /// "this publishes simulcast" can be checked at all — an encodings list
  /// in Dart memory is exactly what the broken implementation had.
  ///
  /// It is a model of libwebrtc, not libwebrtc. It cannot prove that a real
  /// encoder produces three streams, that a device has the capacity to, or
  /// that Chrome writes these lines the same way. Those need a device; see
  /// `docs/rtc/test-matrix.md`. What it does prove is that the SDK asks for
  /// a ladder that would appear in the SDP, and would catch the regression
  /// this file exists for: `addTrack` plus `setParameters` produces an
  /// m-section with no `a=rid:` lines at all.
  String _buildOfferSdp() {
    final buffer = StringBuffer()
      ..write('v=0\r\n')
      ..write('o=- 0 0 IN IP4 0.0.0.0\r\n')
      ..write('s=-\r\n')
      ..write('t=0 0\r\n');

    for (final section in _mSections) {
      buffer
        ..write('m=${section.kind} 9 UDP/TLS/RTP/SAVPF 96\r\n')
        ..write('c=IN IP4 0.0.0.0\r\n')
        ..write('a=mid:${section.mid}\r\n')
        ..write('a=rtpmap:96 VP8/90000\r\n');

      if (section.rids.isNotEmpty) {
        // The extensions carrying mid/rid on every packet. Without these
        // negotiated, a receiver cannot tell one layer from another and
        // rejects the extra SSRCs outright — which is precisely how the
        // SFU integration test failed before the harness set them.
        buffer
          ..write('a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid\r\n')
          ..write(
              'a=extmap:2 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id\r\n');
        for (final rid in section.rids) {
          buffer.write('a=rid:$rid send\r\n');
        }
        buffer.write('a=simulcast:send ${section.rids.join(';')}\r\n');
      }

      buffer.write('a=${section.direction}\r\n');
    }

    return buffer.toString();
  }

  /// Delivers an `onTrack` event for [peerConnectionId], as the native
  /// side does when the SFU's media for a remote publisher arrives.
  ///
  /// No `transceiver` is sent, which is deliberate rather than lazy: with
  /// no mid to look up, [SwalvoEngine]'s `_remoteTrackIdFor` falls back to
  /// the track's own id, so [trackId] here is the id the engine matches
  /// against what `track.published` announced. That is the same fallback
  /// a real platform takes on a section whose mid has not settled yet.
  Future<void> remoteTrack(
    String peerConnectionId, {
    required String trackId,
    required String streamId,
    String kind = 'video',
  }) {
    final track = {
      'id': trackId,
      'label': 'remote',
      'kind': kind,
      'enabled': true,
    };
    return _sendEvent(
      'FlutterWebRTC/peerConnectionEvent$peerConnectionId',
      {
        'event': 'onTrack',
        'streams': [
          {
            'streamId': streamId,
            'ownerTag': 'remote',
            'audioTracks': kind == 'audio' ? [track] : <dynamic>[],
            'videoTracks': kind == 'video' ? [track] : <dynamic>[],
          },
        ],
        'track': track,
        'receiver': {
          'receiverId': 'receiver-$trackId',
          'track': track,
          // Fully formed, not an empty map: RTCRtpParameters.fromMap
          // iterates each of these lists unconditionally and throws on a
          // missing key, which fails the test somewhere unrelated to what
          // it asserts.
          'rtpParameters': <String, dynamic>{
            'transactionId': 'txn-1',
            'rtcp': {'cname': 'remote', 'reducedSize': false},
            'headerExtensions': <dynamic>[],
            'encodings': <dynamic>[],
            'codecs': <dynamic>[],
          },
        },
      },
    );
  }

  Future<void> _sendEvent(String channel, Map<String, dynamic> event) async {
    final data = _codec.encodeSuccessEnvelope(event);
    await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .handlePlatformMessage(channel, data, (ByteData? _) {});
  }
}

/// A local track that needs no camera, no microphone and no platform
/// call — just enough for [SwalvoEngine.publish] to have something to
/// hand `RTCPeerConnection.addTrack`.
({MediaStreamNative stream, MediaStreamTrackNative track}) fakeLocalMedia(
  String peerConnectionId, {
  String trackId = 'local-track-1',
  String kind = 'video',
}) {
  final stream = MediaStreamNative('stream-$trackId', 'local');
  final track =
      MediaStreamTrackNative(trackId, 'fake', kind, true, peerConnectionId);
  return (stream: stream, track: track);
}

/// One m-section of the offer [FakeWebRtcPlatform] generates.
class _MSection {
  _MSection({
    required this.kind,
    required this.mid,
    required this.direction,
    required this.rids,
  });

  final String kind;
  final String mid;
  String direction;

  /// The simulcast layer ids this section declares. Empty for a sender
  /// created through `addTrack`, which can never carry any.
  final List<String> rids;
}
