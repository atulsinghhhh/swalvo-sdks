import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/internal/engine.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';
import 'package:swalvo_rtc/src/room.dart';
import 'package:swalvo_rtc/src/types.dart';

import 'helpers/fake_socket.dart';
import 'helpers/fake_webrtc_platform.dart';

/// Phase 2 media quality, client side
/// (docs/architecture/phase2-media-contracts.md §2–§5): active speakers,
/// connection quality, subscription state, client pause, dynacast, and
/// `autoSubscribe`. Same rules as the web SDK's, asserted on what crosses
/// the wire and the platform channel rather than on internal fields.
void main() {
  late FakeSocket socket;
  late FakeWebRtcPlatform platform;

  setUp(() => platform = FakeWebRtcPlatform());
  tearDown(() => platform.dispose());

  SignalingClient clientFor({bool autoSubscribe = true}) {
    socket = FakeSocket();
    return SignalingClient(
      endpoint: 'ws://localhost:4000/v1/rtc',
      token: fakeToken({'rid': 'room-1', 'sub': 'alice'}),
      roomId: 'room-1',
      autoReconnect: false,
      autoSubscribe: autoSubscribe,
      socketFactory: (_) async => socket,
    );
  }

  Future<JoinedPayload> joinRoom(
    SignalingClient signaling, {
    List<Map<String, dynamic>> participants = const [],
  }) async {
    final joining = signaling.connect();
    await Future<void>.delayed(Duration.zero);
    socket.receive({
      'type': ServerMessageType.roomJoined,
      'roomId': 'room-1',
      'participants': participants,
    });
    return joining;
  }

  Future<void> settle() async {
    for (var i = 0; i < 4; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  List<String?> layersSent() => socket.sent
      .where((m) => m['type'] == ClientMessageType.subscriptionUpdate)
      .map((m) => m['layer'] as String?)
      .toList();

  Future<({SwalvoEngine engine, SignalingClient signaling, String pcId})>
      connectedEngine({
    bool adaptiveStream = true,
    bool autoSubscribe = true,
    bool dynacast = true,
  }) async {
    final signaling = clientFor(autoSubscribe: autoSubscribe);
    final engine = SwalvoEngine(
      signaling: signaling,
      iceServers: const [],
      adaptiveStream: adaptiveStream,
      autoSubscribe: autoSubscribe,
      dynacast: dynacast,
      localIdentity: 'alice',
    );
    engine.start();
    await joinRoom(signaling);
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await settle();
    return (
      engine: engine,
      signaling: signaling,
      pcId: platform.lastPeerConnectionId!,
    );
  }

  Future<void> subscribeBobCamera(String pcId) async {
    socket.receive({
      'type': ServerMessageType.trackPublished,
      'participantId': 'bob',
      'track': {'trackId': 'bob-cam', 'kind': 'video', 'source': 'camera'},
    });
    await settle();
    await platform.remoteTrack(pcId, trackId: 'bob-cam', streamId: 'bob-s');
    await settle();
  }

  group('parsing (never throws on a malformed frame)', () {
    test('speakers: clamps levels and skips entries with no id', () {
      final speakers = parseSpeakers({
        'speakers': [
          {'participantId': 'bob', 'level': 1.7},
          {'level': 0.5},
          'nonsense',
          {'participantId': 'carol', 'level': -2},
        ],
      });
      expect(speakers.map((s) => s.participantId), ['bob', 'carol']);
      expect(speakers.map((s) => s.level), [1.0, 0.0]);
      expect(parseSpeakers({'speakers': 'oops'}), isEmpty);
    });

    test('quality: drops scores this version does not know', () {
      expect(
        parseQualityUpdates({
          'updates': [
            {'participantId': 'bob', 'quality': 'good'},
            {'participantId': 'carol', 'quality': 'stellar'},
            {'quality': 'poor'},
          ],
        }),
        {'bob': 'good'},
      );
    });

    test('subscription.state: null without what it needs, layer validated', () {
      expect(
          parseSubscriptionState(
              {'publisherId': 'bob', 'trackId': 't', 'state': 'sleeping'}),
          isNull);
      final parsed = parseSubscriptionState({
        'publisherId': 'bob',
        'trackId': 't',
        'state': 'paused_bandwidth',
        'layer': 'ultra',
      });
      expect(parsed?.state, 'paused_bandwidth');
      expect(parsed?.layer, isNull);
    });

    test('publisher.layers: rid aliases resolve both ways', () {
      final parsed = parsePublisherLayers({
        'trackId': 'cam',
        'layers': [
          {'rid': 'q', 'active': true},
          {'rid': 'h', 'active': false},
          {'rid': 'f'},
        ],
      });
      expect(parsed!.layers, {'q': true, 'h': false});
      expect(layerActiveFor(parsed.layers, 'low'), isTrue);
      expect(layerActiveFor(parsed.layers, 'medium'), isFalse);
      expect(layerActiveFor(parsed.layers, 'high'), isNull);
      expect(layerActiveFor({'low': false}, 'q'), isFalse);
    });
  });

  group('autoSubscribe on the join', () {
    test('is omitted by default, so the join is unchanged', () async {
      final signaling = clientFor();
      await joinRoom(signaling);
      expect(
          socket
              .lastSent(ClientMessageType.roomJoin)!
              .containsKey('autoSubscribe'),
          isFalse);
      await signaling.dispose();
    });

    test('is sent as false when turned off', () async {
      final signaling = clientFor(autoSubscribe: false);
      await joinRoom(signaling);
      expect(
          socket.lastSent(ClientMessageType.roomJoin)!['autoSubscribe'], false);
      await signaling.dispose();
    });

    test('video starts pausedClient and nothing resumes it unasked', () async {
      final harness = await connectedEngine(autoSubscribe: false);
      await subscribeBobCamera(harness.pcId);

      final subscription = harness.engine.subscribedTracks.single;
      expect(
          subscription.subscriptionState, SwalvoSubscriptionState.pausedClient);
      expect(layersSent(), isEmpty,
          reason: 'subscribing must not undo the join asking for paused');

      // A view being laid out is what asks for it.
      harness.engine.requestLayer('bob', 'bob-cam', 'medium', automatic: true);
      expect(layersSent(), ['medium']);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('setVideoEnabled(true) starts a video nothing else asked for',
        () async {
      final harness =
          await connectedEngine(autoSubscribe: false, adaptiveStream: false);
      await subscribeBobCamera(harness.pcId);

      harness.engine.setVideoEnabled('bob', 'bob-cam', true);
      expect(layersSent(), ['auto']);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });
  });

  group('subscription state', () {
    test('a state that beats its track is parked and applied silently',
        () async {
      final harness = await connectedEngine();
      final events = <({String participantId, String trackId})>[];
      final sub = harness.engine.subscriptionStateEvents.listen(events.add);

      socket.receive({
        'type': ServerMessageType.subscriptionState,
        'publisherId': 'bob',
        'trackId': 'bob-cam',
        'state': 'paused_bandwidth',
        'layer': 'low',
      });
      await settle();
      await subscribeBobCamera(harness.pcId);

      final subscription = harness.engine.subscribedTracks.single;
      expect(subscription.subscriptionState,
          SwalvoSubscriptionState.pausedBandwidth);
      expect(subscription.layer, 'low');
      expect(events, isEmpty);

      socket.receive({
        'type': ServerMessageType.subscriptionState,
        'publisherId': 'bob',
        'trackId': 'bob-cam',
        'state': 'active',
        'layer': 'high',
      });
      await settle();
      expect(subscription.subscriptionState, SwalvoSubscriptionState.active);
      expect(events, hasLength(1));

      await sub.cancel();
      await harness.engine.dispose();
      await harness.signaling.dispose();
    });
  });

  group('client pause precedence', () {
    test('setVideoEnabled(false) outranks a pin, and resuming restores it',
        () async {
      final harness = await connectedEngine();
      harness.engine.requestLayer('bob', 'bob-cam', 'high');
      harness.engine.setVideoEnabled('bob', 'bob-cam', false);
      harness.engine.requestLayer('bob', 'bob-cam', 'low', automatic: true);
      harness.engine.setVideoEnabled('bob', 'bob-cam', true);

      expect(layersSent(), ['high', 'off', 'high']);
      expect(harness.engine.isVideoEnabled('bob', 'bob-cam'), isTrue);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('unpinning returns to the size adaptive streaming chose meanwhile',
        () async {
      final harness = await connectedEngine();
      harness.engine.requestLayer('bob', 'bob-cam', 'high');
      harness.engine.requestLayer('bob', 'bob-cam', 'low', automatic: true);
      harness.engine.requestLayer('bob', 'bob-cam', 'auto');

      expect(layersSent(), ['high', 'low']);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('hidden views pause after the delay; showing one resumes at once',
        () async {
      final harness = await connectedEngine();
      final viewA = Object();
      final viewB = Object();
      harness.engine.requestLayer('bob', 'bob-cam', 'medium', automatic: true);
      harness.engine.setViewVisibility('bob', 'bob-cam', viewA, true);
      harness.engine.setViewVisibility('bob', 'bob-cam', viewB, false);

      await Future<void>.delayed(
          SwalvoEngine.hideDelay + const Duration(milliseconds: 100));
      expect(layersSent(), ['medium'],
          reason: 'one visible view keeps the video flowing');

      harness.engine.setViewVisibility('bob', 'bob-cam', viewA, false);
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(layersSent(), ['medium'], reason: 'debounced, not immediate');
      await Future<void>.delayed(SwalvoEngine.hideDelay);
      expect(layersSent(), ['medium', 'off']);

      harness.engine.setViewVisibility('bob', 'bob-cam', viewB, true);
      expect(layersSent(), ['medium', 'off', 'medium']);

      // The last view going away counts as hidden too.
      harness.engine.removeView('bob', 'bob-cam', viewA);
      harness.engine.removeView('bob', 'bob-cam', viewB);
      await Future<void>.delayed(
          SwalvoEngine.hideDelay + const Duration(milliseconds: 100));
      expect(layersSent(), ['medium', 'off', 'medium', 'off']);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('a brief hide never pauses', () async {
      final harness = await connectedEngine();
      final view = Object();
      harness.engine.setViewVisibility('bob', 'bob-cam', view, false);
      await Future<void>.delayed(const Duration(milliseconds: 100));
      harness.engine.setViewVisibility('bob', 'bob-cam', view, true);
      await Future<void>.delayed(SwalvoEngine.hideDelay);
      expect(layersSent(), isEmpty);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('visibility is ignored with adaptiveStream off', () async {
      final harness = await connectedEngine(adaptiveStream: false);
      harness.engine.setViewVisibility('bob', 'bob-cam', Object(), false);
      await Future<void>.delayed(
          SwalvoEngine.hideDelay + const Duration(milliseconds: 100));
      expect(layersSent(), isEmpty);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });
  });

  group('publisher.layers (dynacast)', () {
    Future<void> publishCamera(
        ({
          SwalvoEngine engine,
          SignalingClient signaling,
          String pcId
        }) harness) async {
      final media = fakeLocalMedia(harness.pcId, trackId: 'camera-track');
      unawaited(harness.engine
          .publish(source: 'camera', stream: media.stream, track: media.track));
      await settle();
      socket.receive({'type': ServerMessageType.sdpAnswer, 'sdp': 'v=0'});
      await settle();
    }

    void sendLayers(Map<String, bool> layers,
        {String trackId = 'camera-track'}) {
      socket.receive({
        'type': ServerMessageType.publisherLayers,
        'trackId': trackId,
        'layers': [
          for (final entry in layers.entries)
            {'rid': entry.key, 'active': entry.value},
        ],
      });
    }

    List<bool?> activeFlags(int call) =>
        platform.setParametersCalls[call].encodings
            .map((e) => e['active'] as bool?)
            .toList();

    test('switches encodings off by rid, in either spelling', () async {
      final harness = await connectedEngine();
      await publishCamera(harness);

      sendLayers({'q': true, 'h': false, 'f': false});
      await settle();

      expect(platform.setParametersCalls, hasLength(1));
      expect(platform.setParametersCalls.single.encodings.map((e) => e['rid']),
          ['low', 'medium', 'high']);
      expect(activeFlags(0), [true, false, false]);

      // The same set again changes nothing, so nothing is sent.
      sendLayers({'low': true, 'medium': false, 'high': false});
      await settle();
      expect(platform.setParametersCalls, hasLength(1));

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('back-to-back updates apply in order, the last one winning', () async {
      final harness = await connectedEngine();
      await publishCamera(harness);

      sendLayers({'low': false, 'medium': false, 'high': false});
      sendLayers({'low': true, 'medium': true, 'high': false});
      await settle();

      expect(platform.setParametersCalls, hasLength(2));
      expect(activeFlags(0), [false, false, false]);
      expect(activeFlags(1), [true, true, false]);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('a refused setParameters is rolled back and retried next round',
        () async {
      final harness = await connectedEngine();
      await publishCamera(harness);

      platform.failSetParameters = true;
      sendLayers({'low': true, 'medium': true, 'high': false});
      await settle();
      expect(platform.setParametersCalls, hasLength(1));

      platform.failSetParameters = false;
      // The next negotiation round re-applies what is still wanted.
      socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 again'});
      await settle();
      expect(platform.setParametersCalls, hasLength(2));
      expect(activeFlags(1), [true, true, false]);

      await harness.engine.dispose();
      await harness.signaling.dispose();
    });

    test('is ignored with dynacast off, and for a track not published',
        () async {
      final off = await connectedEngine(dynacast: false);
      await publishCamera(off);
      sendLayers({'low': false, 'medium': false, 'high': false});
      sendLayers({'low': false}, trackId: 'somebody-else');
      await settle();
      expect(platform.setParametersCalls, isEmpty);

      await off.engine.dispose();
      await off.signaling.dispose();
    });
  });

  group('speakers and quality, through the room', () {
    Future<({SwalvoRoom room, SignalingClient signaling})> joinedRoom() async {
      final signaling = clientFor();
      final engine = SwalvoEngine(
        signaling: signaling,
        iceServers: const [],
        adaptiveStream: true,
        localIdentity: 'alice',
      );
      final room = SwalvoRoom.attach(
        signaling: signaling,
        engine: engine,
        roomId: 'room-1',
        localIdentity: 'alice',
      );
      final joined = await joinRoom(signaling, participants: [
        {'id': 'bob'},
      ]);
      room.applyInitialJoin(joined);
      await settle();
      return (room: room, signaling: signaling);
    }

    test('active speakers, isSpeaking and speaking transitions', () async {
      final harness = await joinedRoom();
      final room = harness.room;
      final lists = <List<String>>[];
      final transitions = <String>[];
      final s1 = room.activeSpeakerChanges
          .listen((list) => lists.add(list.map((p) => p.identity).toList()));
      final s2 = room.speakingChanges
          .listen((p) => transitions.add('${p.identity}:${p.isSpeaking}'));

      socket.receive({
        'type': ServerMessageType.speakersChanged,
        'speakers': [
          {'participantId': 'bob', 'level': 0.8},
          {'participantId': 'alice', 'level': 0.3},
          {'participantId': 'ghost', 'level': 0.9},
        ],
      });
      await settle();

      expect(room.activeSpeakers.map((p) => p.identity), ['bob', 'alice']);
      expect(room.remoteParticipants.single.isSpeaking, isTrue);
      expect(room.remoteParticipants.single.audioLevel, 0.8);
      expect(room.localParticipant.isSpeaking, isTrue);
      expect(transitions.toSet(), {'bob:true', 'alice:true'});

      // A level change without a set change is not a transition.
      socket.receive({
        'type': ServerMessageType.speakersChanged,
        'speakers': [
          {'participantId': 'bob', 'level': 0.4},
          {'participantId': 'alice', 'level': 0.3},
        ],
      });
      await settle();
      expect(transitions, hasLength(2));
      expect(room.remoteParticipants.single.audioLevel, 0.4);

      socket
          .receive({'type': ServerMessageType.speakersChanged, 'speakers': []});
      await settle();
      expect(room.activeSpeakers, isEmpty);
      expect(room.remoteParticipants.single.isSpeaking, isFalse);
      expect(room.remoteParticipants.single.audioLevel, 0);
      expect(transitions, hasLength(4));
      expect(lists.last, isEmpty);

      await s1.cancel();
      await s2.cancel();
      room.dispose();
      await settle();
    });

    test('connection quality, local participant included', () async {
      final harness = await joinedRoom();
      final room = harness.room;
      expect(room.connectionQuality, SwalvoConnectionQuality.unknown);

      final updates = <String>[];
      final sub = room.connectionQualityChanges.listen(
          (u) => updates.add('${u.participant.identity}:${u.quality.name}'));

      socket.receive({
        'type': ServerMessageType.qualityChanged,
        'updates': [
          {'participantId': 'alice', 'quality': 'good'},
          {'participantId': 'bob', 'quality': 'poor'},
        ],
      });
      await settle();

      expect(room.connectionQuality, SwalvoConnectionQuality.good);
      expect(room.localParticipant.connectionQuality,
          SwalvoConnectionQuality.good);
      expect(room.remoteParticipants.single.connectionQuality,
          SwalvoConnectionQuality.poor);
      expect(updates, ['alice:good', 'bob:poor']);

      // Unchanged scores are not re-announced.
      socket.receive({
        'type': ServerMessageType.qualityChanged,
        'updates': [
          {'participantId': 'bob', 'quality': 'poor'},
        ],
      });
      await settle();
      expect(updates, hasLength(2));

      await sub.cancel();
      room.dispose();
      await settle();
    });
  });
}
