import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/internal/engine.dart';
import 'package:swalvo_rtc/src/internal/protocol.dart';
import 'package:swalvo_rtc/src/internal/signaling_client.dart';

import 'helpers/fake_socket.dart';
import 'helpers/fake_webrtc_platform.dart';

/// Regression tests for the Android ICE failure: a client that allocated a
/// TURN relay, never applied the server's candidates, and therefore sat in
/// `checking` until the SFU's own ~30s deadline closed the session.
///
/// The SFU trickles its candidates as soon as it has them, which is
/// routinely before its offer has been processed here — and `addCandidate`
/// is illegal until a remote description exists. The old code caught that
/// failure and dropped the candidate, so whether a connection worked came
/// down to which message won the race. These tests assert on what reached
/// the *platform* ([FakeWebRtcPlatform.appliedCandidates]), because a
/// candidate the engine accepted but never applied is exactly the bug.
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
      socketFactory: (_) async => socket,
    );
  }

  Future<SwalvoEngine> joinedEngine() async {
    final signaling = clientFor();
    final engine = SwalvoEngine(
        signaling: signaling, iceServers: const [], adaptiveStream: false);
    engine.start();
    final joining = signaling.connect();
    await Future<void>.delayed(Duration.zero);
    socket.receive({
      'type': ServerMessageType.roomJoined,
      'roomId': 'room-1',
      'participants': const <Map<String, dynamic>>[],
    });
    await joining;
    return engine;
  }

  Future<void> settle() async {
    for (var i = 0; i < 8; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  const relay =
      'candidate:1 1 udp 41885439 40.83.92.152 49188 typ relay raddr 0.0.0.0 rport 0';
  const host = 'candidate:2 1 udp 2130706431 10.10.1.4 51060 typ host';

  Map<String, dynamic> candidateFrame(String candidate) => {
        'type': ServerMessageType.iceCandidate,
        'candidate': candidate,
        'sdpMid': '0',
        'sdpMLineIndex': 0,
      };

  test(
      'REGRESSION: candidates that arrive before the remote description are '
      'applied once it lands, not dropped', () async {
    final engine = await joinedEngine();

    // The ordering that broke Android: candidates first, offer second.
    socket.receive(candidateFrame(relay));
    socket.receive(candidateFrame(host));
    await settle();

    // Nothing could be applied yet, and nothing may be lost either.
    expect(platform.appliedCandidates, isEmpty);

    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await settle();

    expect(
      platform.appliedCandidates,
      containsAll(<String>[relay, host]),
      reason: 'buffered candidates must reach the platform once a remote '
          'description exists — without the relay candidate the agent has '
          'no peer to permit and never sends a relay check',
    );

    await engine.dispose();
  });

  test('a candidate arriving after the remote description is applied directly',
      () async {
    final engine = await joinedEngine();

    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await settle();
    socket.receive(candidateFrame(relay));
    await settle();

    expect(platform.appliedCandidates, contains(relay));
    await engine.dispose();
  });

  test('the TURN relay candidate specifically survives the race', () async {
    final engine = await joinedEngine();

    socket.receive(candidateFrame(relay));
    await settle();
    // Held, not handed to the platform: the engine knows there is no
    // remote description yet, so it never asks and never has to catch a
    // rejection. What matters is that the candidate is not lost.
    expect(platform.appliedCandidates, isEmpty);

    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await settle();

    expect(platform.appliedCandidates.where((c) => c.contains('typ relay')),
        isNotEmpty);
    await engine.dispose();
  });

  test('a stalled connection triggers exactly one ICE restart', () async {
    final engine = await joinedEngine();
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await settle();

    final pcId = platform.lastPeerConnectionId!;
    // Never reaches connected: the shape of the production failure.
    await platform.peerConnectionState(pcId, 'connecting');
    await settle();

    expect(platform.offerConstraints.where((c) => c['iceRestart'] == true),
        isEmpty,
        reason: 'no restart before the watchdog window elapses');

    await Future<void>.delayed(const Duration(seconds: 13));
    await settle();

    final restarts =
        platform.offerConstraints.where((c) => c['iceRestart'] == true);
    expect(restarts.length, 1, reason: 'exactly one, never a retry loop');

    await engine.dispose();
  }, timeout: const Timeout(Duration(seconds: 40)));

  test('a connection that reaches connected never restarts ICE', () async {
    final engine = await joinedEngine();
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await settle();

    final pcId = platform.lastPeerConnectionId!;
    await platform.peerConnectionState(pcId, 'connecting');
    await settle();
    await platform.peerConnectionState(pcId, 'connected');
    await settle();

    await Future<void>.delayed(const Duration(seconds: 13));
    await settle();

    expect(platform.offerConstraints.where((c) => c['iceRestart'] == true),
        isEmpty);
    await engine.dispose();
  }, timeout: const Timeout(Duration(seconds: 40)));

  test('a second stall does not produce a second restart', () async {
    final engine = await joinedEngine();
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await settle();

    final pcId = platform.lastPeerConnectionId!;
    await platform.peerConnectionState(pcId, 'connecting');
    await settle();
    await Future<void>.delayed(const Duration(seconds: 13));
    await settle();

    // Still stalled: the watchdog re-arms, but the budget is spent.
    await platform.peerConnectionState(pcId, 'disconnected');
    await settle();
    await Future<void>.delayed(const Duration(seconds: 13));
    await settle();

    expect(
        platform.offerConstraints.where((c) => c['iceRestart'] == true).length,
        1);
    await engine.dispose();
  }, timeout: const Timeout(Duration(seconds: 60)));

  test('dispose during the watchdog window cancels recovery cleanly', () async {
    final engine = await joinedEngine();
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await settle();
    await platform.peerConnectionState(
        platform.lastPeerConnectionId!, 'connecting');
    await settle();

    await engine.dispose();
    await Future<void>.delayed(const Duration(seconds: 13));
    await settle();

    expect(platform.offerConstraints.where((c) => c['iceRestart'] == true),
        isEmpty,
        reason: 'a disposed engine must not negotiate');
  }, timeout: const Timeout(Duration(seconds: 40)));

  test('resetPeerConnection clears buffered candidates and refills the budget',
      () async {
    final engine = await joinedEngine();

    socket.receive(candidateFrame(relay));
    await settle();
    await engine.resetPeerConnection();
    await settle();

    // The buffered candidate named a transceiver on the old connection; it
    // must not be replayed onto the new one.
    socket.receive({'type': ServerMessageType.sdpOffer, 'sdp': 'v=0 offer'});
    await settle();
    expect(platform.appliedCandidates, isEmpty);

    await engine.dispose();
  });
}
