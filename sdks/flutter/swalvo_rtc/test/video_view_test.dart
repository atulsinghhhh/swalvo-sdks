import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/internal/engine.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';
import 'package:swalvo_rtc/src/room.dart';
import 'package:swalvo_rtc/src/types.dart';
import 'package:swalvo_rtc/src/video_view.dart';

import 'helpers/fake_socket.dart';
import 'helpers/fake_webrtc_platform.dart';

/// Regression tests for the failure every integrator hits first: the
/// camera is on, the track exists, and the tile still shows a placeholder.
///
/// These drive a real [SwalvoRoom] and a real [SwalvoVideoView], then assert
/// on what reached the *renderer* — see
/// [FakeWebRtcPlatform.renderedStreamIds]. Asserting on room state alone is
/// what let this survive an earlier round of verification: every
/// participant flag was already correct while nothing was on screen.
///
/// Everything that awaits the SDK runs inside [WidgetTester.runAsync]. The
/// engine, the signaling client and the platform mock all cross real
/// asynchronous boundaries, and `testWidgets`' fake clock only advances on
/// a pump — awaiting them directly deadlocks rather than fails.
void main() {
  late FakeSocket socket;
  late FakeWebRtcPlatform platform;

  setUp(() => platform = FakeWebRtcPlatform());
  tearDown(() => platform.dispose());

  SignalingClient clientFor() {
    socket = FakeSocket();
    return SignalingClient(
      endpoint: 'ws://localhost:4000/v1/rtc',
      token: fakeToken({'rid': 'room-1', 'sub': 'alice'}),
      roomId: 'room-1',
      autoReconnect: false,
      socketFactory: (_) async => socket = FakeSocket(),
    );
  }

  /// A joined room whose peer connection is already established, which is
  /// the state an application is in by the time it enables a camera.
  Future<({SwalvoRoom room, SwalvoEngine engine, String pcId})> joinedRoom(
      {bool adaptiveStream = false}) async {
    final signaling = clientFor();
    final engine = SwalvoEngine(
        signaling: signaling,
        iceServers: const [],
        adaptiveStream: adaptiveStream);
    final room = SwalvoRoom.attach(
      signaling: signaling,
      engine: engine,
      roomId: 'room-1',
      localIdentity: 'alice',
    );

    final joining = signaling.connect();
    await Future<void>.delayed(Duration.zero);
    socket.receive({
      'type': ServerMessageType.roomJoined,
      'roomId': 'room-1',
      'participants': <Map<String, dynamic>>[],
    });
    room.applyInitialJoin(await joining);

    // The SFU offers first; answering it is what creates the peer
    // connection a publish then adds its track to.
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    for (var i = 0; i < 5; i++) {
      await Future<void>.delayed(Duration.zero);
    }

    return (room: room, engine: engine, pcId: platform.lastPeerConnectionId!);
  }

  /// The idiomatic application: rebuild the tile from the room, reading a
  /// fresh participant snapshot each time.
  Widget tileFor(SwalvoRoom room) => MaterialApp(
        home: ListenableBuilder(
          listenable: room,
          builder: (context, _) => SwalvoVideoView(
            participant: room.localParticipant,
            room: room,
            placeholder: const Text('placeholder'),
          ),
        ),
      );

  /// The same idiomatic tile, pointed at the first remote participant —
  /// what a live-stream viewer renders for the host.
  Widget remoteTileFor(SwalvoRoom room) => MaterialApp(
        home: ListenableBuilder(
          listenable: room,
          builder: (context, _) => SwalvoVideoView(
            participant: room.remoteParticipants.isEmpty
                ? null
                : room.remoteParticipants.first,
            room: room,
            placeholder: const Text('placeholder'),
          ),
        ),
      );

  /// Rebuilds, and lets every real asynchronous hop in between land.
  ///
  /// Two boundaries matter here and neither is on the fake clock: the
  /// renderer's `initialize()`, and the `videoRendererSetSrcObject`
  /// platform call that binding a stream turns into. Asserting after a
  /// bare `pump()` races both, which is a flake rather than a finding.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 5; i++) {
      await tester.pump();
      await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 1)));
    }
    await tester.pump();
  }

  /// Mounts [widget] and lets the renderer's asynchronous `initialize()`
  /// finish, so no assertion below can pass or fail merely because the
  /// texture wasn't ready yet.
  Future<void> mount(WidgetTester tester, Widget widget) async {
    await tester.pumpWidget(widget);
    await settle(tester);
  }

  testWidgets(
      'REGRESSION: a tile renders the camera that was enabled after it was built',
      (tester) async {
    final joined = (await tester.runAsync(joinedRoom))!;
    final room = joined.room;

    await mount(tester, tileFor(room));
    expect(find.text('placeholder'), findsOneWidget);
    expect(platform.renderedStreamIds.whereType<String>(), isEmpty);

    final media = fakeLocalMedia(joined.pcId);
    await tester.runAsync(() => joined.engine
        .publish(source: 'camera', stream: media.stream, track: media.track));
    await settle(tester);

    // The mechanism this guards: SwalvoRoom.notifyListeners() runs
    // synchronously, so SwalvoVideoView's own listener fires while
    // `widget.participant` is still the snapshot from before the publish.
    // The rebuild that follows carries the right snapshot but compares
    // equal to the old one (SwalvoParticipant.== is identity-only), so a
    // didUpdateWidget guarded on that comparison skipped the re-resolve
    // and the tile stayed on its placeholder indefinitely.
    expect(
      platform.renderedStreamIds.whereType<String>(),
      contains(media.stream.id),
      reason: 'the published stream must actually reach the renderer',
    );
    expect(find.text('placeholder'), findsNothing);

    room.dispose();
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  });

  testWidgets(
      'REGRESSION: a viewer\'s tile renders a remote publisher whose track '
      'arrived after the tile was built', (tester) async {
    final joined = (await tester.runAsync(joinedRoom))!;
    final room = joined.room;

    // The shape of every Live Stream: the viewer is in the room, the host
    // is already there, and the host's media arrives afterwards. Nothing
    // this side publishes at all — a viewer's grant forbids it — so the
    // local-camera path that the test above covers is not involved.
    socket.receive({
      'type': ServerMessageType.participantJoined,
      'participant': {'id': 'host-alice', 'tracks': <dynamic>[]},
    });
    await settle(tester);

    await mount(tester, remoteTileFor(room));
    expect(find.text('placeholder'), findsOneWidget);
    expect(platform.renderedStreamIds.whereType<String>(), isEmpty);

    // Both halves of a subscription, in the order the SFU sends them.
    socket.receive({
      'type': ServerMessageType.trackPublished,
      'participantId': 'host-alice',
      'track': {
        'trackId': 'host-camera-1',
        'kind': 'video',
        'source': 'camera',
        'muted': false,
      },
    });
    await tester.runAsync(() => platform.remoteTrack(
          joined.pcId,
          trackId: 'host-camera-1',
          streamId: 'host-stream-1',
        ));
    await settle(tester);

    // The boundary the live reproduction failed at. Against published
    // swalvo_rtc 0.1.8 the viewer decoded real RTP for the whole session
    // while its `<video>` never received a srcObject at all, because
    // SwalvoVideoView resolved the track from the stale participant
    // snapshot it was handed rather than from the room.
    expect(
      platform.renderedStreamIds.whereType<String>(),
      contains('host-stream-1'),
      reason: "the host's stream must actually reach the viewer's renderer",
    );
    expect(find.text('placeholder'), findsNothing);

    room.dispose();
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  });

  testWidgets('a tile drops back to the placeholder when the camera goes away',
      (tester) async {
    final joined = (await tester.runAsync(joinedRoom))!;
    final room = joined.room;
    final media = fakeLocalMedia(joined.pcId);

    await mount(tester, tileFor(room));
    await tester.runAsync(() => joined.engine
        .publish(source: 'camera', stream: media.stream, track: media.track));
    await settle(tester);
    expect(find.text('placeholder'), findsNothing);

    await tester.runAsync(() => joined.engine.unpublish('camera'));
    await settle(tester);

    // The same re-resolve in the other direction. A tile that kept its
    // last frame after the camera went away would be claiming something
    // is still being sent.
    expect(find.text('placeholder'), findsOneWidget);

    room.dispose();
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  });

  testWidgets('a participant the room no longer lists renders the placeholder',
      (tester) async {
    final joined = (await tester.runAsync(joinedRoom))!;
    final room = joined.room;

    // A snapshot of somebody this room's roster does not contain: the same
    // shape as a tile left holding a participant who has since left.
    const departed = SwalvoParticipant(identity: 'bob', isLocal: false);

    await mount(
      tester,
      MaterialApp(
        home: SwalvoVideoView(
          participant: departed,
          room: room,
          placeholder: const Text('placeholder'),
        ),
      ),
    );

    expect(find.text('placeholder'), findsOneWidget);

    room.dispose();
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  });

  testWidgets(
      'a hidden remote view pauses its video after the delay, and showing it resumes',
      (tester) async {
    final joined =
        (await tester.runAsync(() => joinedRoom(adaptiveStream: true)))!;
    final room = joined.room;
    final visible = ValueNotifier(true);

    socket.receive({
      'type': ServerMessageType.participantJoined,
      'participant': {'id': 'bob', 'tracks': <dynamic>[]},
    });
    socket.receive({
      'type': ServerMessageType.trackPublished,
      'participantId': 'bob',
      'track': {'trackId': 'bob-cam', 'kind': 'video', 'source': 'camera'},
    });
    await tester.runAsync(() => platform.remoteTrack(joined.pcId,
        trackId: 'bob-cam', streamId: 'bob-stream'));

    await mount(
      tester,
      MaterialApp(
        home: ListenableBuilder(
          listenable: Listenable.merge([room, visible]),
          builder: (context, _) => SwalvoVideoView(
            participant: room.remoteParticipants.first,
            room: room,
            visible: visible.value,
          ),
        ),
      ),
    );
    // Lets the size-based request out of its own debounce.
    await tester.pump(const Duration(milliseconds: 300));

    List<Object?> layers() => socket.sent
        .where((m) => m['type'] == ClientMessageType.subscriptionUpdate)
        .map((m) => m['layer'])
        .toList();
    expect(layers(), ['high'], reason: 'a full-width test surface');

    visible.value = false;
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(layers(), ['high'], reason: 'hiding is debounced');
    await tester.pump(SwalvoEngine.hideDelay);
    expect(layers(), ['high', 'off']);

    visible.value = true;
    await tester.pump();
    await tester.pump();
    expect(layers(), ['high', 'off', 'high'], reason: 'showing is immediate');

    // Unmounting the last view counts as hiding it.
    await tester.pumpWidget(const SizedBox());
    await tester.pump(SwalvoEngine.hideDelay);
    expect(layers(), ['high', 'off', 'high', 'off']);

    room.dispose();
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  });
}
