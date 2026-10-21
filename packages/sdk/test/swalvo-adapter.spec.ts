import { SwalvoAdapter } from '../src/internal/sfu/swalvo-adapter';
import { createLogger } from '../src/logger';
import { RTCError } from '../src/errors';
import type { RemoteParticipant } from '../src/participant';
import type { RemoteTrack, TrackKind } from '../src/track';
import { sdpNegotiatesSimulcast } from '../src/internal/sfu/simulcast';
import {
  FakeMediaStreamTrack,
  FakeRTCPeerConnection,
  FakeWebSocket,
  fakeToken,
  flush,
  installFakeMediaDevices,
  installFakeWebRTC,
} from './helpers/fake-webrtc';

const ENDPOINT = 'ws://localhost:4000/v1/rtc';

const TOKEN = fakeToken({
  jti: 'rtc-token-1',
  sub: 'alice',
  pid: 'project-1',
  env: 'DEVELOPMENT',
  rid: 'room-1',
  rnm: 'demo-room',
  perms: {
    join: true,
    subscribe: true,
    publish: true,
    publishAudio: true,
    publishVideo: true,
    publishData: true,
  },
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
  aud: 'raven-rtc',
  iss: 'raven',
});

/**
 * Adapters a test has connected, torn down afterwards.
 *
 * The signaling client keeps retrying a dropped socket on a jittered
 * timer. Leave one running and it opens sockets during whichever test
 * happens to be executing next, where `FakeWebSocket.latest` then points
 * at a stranger.
 */
const connectedAdapters: SwalvoAdapter[] = [];

/** Waits for the signaling client's jittered backoff to open a new socket. */
async function waitForNewSocket(previousCount: number): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (FakeWebSocket.instances.length > previousCount) {
      await flush();
      return FakeWebSocket.latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the signaling client never reconnected');
}

/** Connects an adapter and completes the join handshake. */
async function connectAdapter(
  options: {
    autoReconnect?: boolean;
    participants?: { id: string; tracks?: unknown[] }[];
    adaptiveStream?: boolean;
    preferredVideoCodec?: 'h264' | 'vp8' | 'vp9' | 'av1';
  } = {},
): Promise<{ adapter: SwalvoAdapter; socket: FakeWebSocket }> {
  const adapter = new SwalvoAdapter(createLogger('silent'), options.autoReconnect ?? true, {
    adaptiveStream: options.adaptiveStream ?? true,
    preferredVideoCodec: options.preferredVideoCodec,
  });
  const connecting = adapter.connect(ENDPOINT, TOKEN, [{ urls: 'stun:localhost:3478' }]);

  await flush();
  const socket = FakeWebSocket.latest;
  socket.receive({
    type: 'room.joined',
    roomId: 'room-1',
    participants: options.participants ?? [],
    rtcServer: 'sfu-local-01',
    region: 'local',
  });

  await connecting;
  connectedAdapters.push(adapter);
  return { adapter, socket };
}

/**
 * Answers every offer the adapter has outstanding, the way the SFU would,
 * until negotiation goes quiet.
 *
 * A publish made while a round is in flight legitimately takes a second
 * round trip — the point of the chain is that the two never overlap, not
 * that they collapse into one. Bounded, so a test can't hang on a bug.
 */
async function settleNegotiation(socket: FakeWebSocket, pc: FakeRTCPeerConnection): Promise<void> {
  for (let round = 0; round < 8; round++) {
    await flush();
    if (pc.signalingState !== 'have-local-offer') {
      return;
    }
    socket.receive({ type: 'sdp.answer', sdp: `v=0 fake-server-answer-${round}` });
  }
  throw new Error('negotiation never settled');
}

/**
 * An offer shaped like the one Swalvo's SFU sends at join: a recvonly
 * m-section per kind, each carrying an msid of the SFU's own.
 *
 * `Manager.AddParticipant` adds those two transceivers up front so a first
 * publish costs no extra renegotiation. `addTrack` then reuses them, and
 * the m-section keeps the SFU's msid — which is the whole reason a
 * publication id has to be read back off the SDP.
 */
function sfuJoinOffer(tag = 'sfu-join'): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:0',
    `a=msid:${tag}-audio-stream ${tag}-audio-slot`,
    'a=recvonly',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=mid:1',
    `a=msid:${tag}-video-stream ${tag}-video-slot`,
    'a=recvonly',
  ].join('\r\n');
}

/** Answers an SFU offer, which is what brings the PeerConnection into being. */
async function receiveOffer(socket: FakeWebSocket, sdp = 'v=0 fake-server-offer'): Promise<FakeRTCPeerConnection> {
  socket.receive({ type: 'sdp.offer', sdp });
  await flush();
  return FakeRTCPeerConnection.latest;
}

/**
 * An offer shaped the way the SFU's are: one m-section per subscription,
 * publisher's track id sitting in `a=msid:`. That's where the remote track
 * id actually lives.
 */
function offerWithMsid(sections: Array<{ mid: string; streamId: string; trackId: string }>): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    ...sections.flatMap(({ mid, streamId, trackId }) => [
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      `a=mid:${mid}`,
      `a=msid:${streamId} ${trackId}`,
      'a=sendonly',
    ]),
  ].join('\r\n');
}

describe('SwalvoAdapter', () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = installFakeWebRTC();
    installFakeMediaDevices();
  });

  afterEach(async () => {
    while (connectedAdapters.length > 0) {
      await connectedAdapters.pop()?.disconnect();
    }
    teardown();
  });

  describe('connecting', () => {
    it('opens the signaling socket with the token and joins the room', async () => {
      const { socket } = await connectAdapter();

      expect(socket.url).toContain(encodeURIComponent(TOKEN));
      expect(socket.lastSent('room.join')).toMatchObject({ roomId: 'room-1' });
    });

    it('takes its identity from the token, not from the server', async () => {
      const { adapter } = await connectAdapter();
      expect(adapter.localParticipant.identity).toBe('alice');
    });

    it('reports the participants already in the room', async () => {
      const { adapter } = await connectAdapter({
        participants: [{ id: 'bob' }, { id: 'carol' }],
      });

      expect([...adapter.remoteParticipants.keys()].sort()).toEqual(['bob', 'carol']);
    });

    it('fails with a typed error when the server rejects the token', async () => {
      const adapter = new SwalvoAdapter(createLogger('silent'), false);
      const connecting = adapter.connect(ENDPOINT, TOKEN);

      await flush();
      FakeWebSocket.latest.receive({
        type: 'error',
        code: 'TOKEN_EXPIRED',
        message: 'RTC token has expired',
      });

      await expect(connecting).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
      expect(adapter.connectionState).toBe('failed');
    });

    it('rejects a token that names no room before opening a socket', async () => {
      const adapter = new SwalvoAdapter(createLogger('silent'), false);

      await expect(adapter.connect(ENDPOINT, fakeToken({ sub: 'alice' }))).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it("passes the mint response's ICE servers to the PeerConnection", async () => {
      // A developer forwards `iceServers` from the token response. They
      // have to reach the connection, or NAT traversal drops back to host
      // candidates and nothing else.
      const { socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      expect(pc.configuration?.iceServers).toEqual([{ urls: 'stun:localhost:3478' }]);
    });
  });

  describe('negotiation', () => {
    it("answers the SFU's offer", async () => {
      const { socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      expect(pc.remoteDescription?.sdp).toBe('v=0 fake-server-offer');
      expect(String(socket.lastSent('sdp.answer')?.sdp)).toContain('fake-client-answer');
    });

    it('forwards local ICE candidates to the server', async () => {
      const { socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      pc.emitIceCandidate({
        candidate: 'candidate:1 1 udp 2130706431 10.0.0.1 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'abc',
      });

      expect(socket.lastSent('ice.candidate')).toEqual({
        type: 'ice.candidate',
        candidate: 'candidate:1 1 udp 2130706431 10.0.0.1 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'abc',
      });
    });

    it('does not forward the end-of-candidates signal', async () => {
      const { socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      const before = socket.sentMessages().length;

      pc.onicecandidate?.({ candidate: null } as RTCPeerConnectionIceEvent);

      expect(socket.sentMessages()).toHaveLength(before);
    });

    it('applies remote ICE candidates', async () => {
      const { socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      socket.receive({
        type: 'ice.candidate',
        candidate: 'candidate:2 1 udp 1 192.0.2.1 3478 typ srflx',
        sdpMid: '0',
      });
      await flush();

      expect(pc.appliedCandidates).toHaveLength(1);
      expect(pc.appliedCandidates[0].candidate).toContain('srflx');
    });

    it('reports connected once the PeerConnection is', async () => {
      // Not when the WebSocket opens. Signaling being up tells you nothing
      // about whether media can flow.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      expect(adapter.connectionState).not.toBe('connected');

      pc.setConnectionState('connected');
      expect(adapter.connectionState).toBe('connected');
    });

    it('ignores a transient ICE disconnect rather than flapping the state', async () => {
      // WebRTC's `disconnected` is recoverable by definition. A UI that
      // flashes "reconnecting" at every little blip is worse than one that
      // holds its nerve.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      pc.setConnectionState('connected');

      pc.setConnectionState('disconnected');

      expect(adapter.connectionState).toBe('connected');
    });
  });

  describe('remote participants and tracks', () => {
    it('emits participantJoined and participantLeft', async () => {
      const { adapter, socket } = await connectAdapter();
      const joined: string[] = [];
      const left: string[] = [];
      adapter.on('participantJoined', (participant: RemoteParticipant) => joined.push(participant.identity));
      adapter.on('participantLeft', (participant: RemoteParticipant) => left.push(participant.identity));

      socket.receive({ type: 'participant.joined', participant: { id: 'bob' } });
      await flush();
      socket.receive({ type: 'participant.left', participant: { id: 'bob' } });
      await flush();

      expect(joined).toEqual(['bob']);
      expect(left).toEqual(['bob']);
      expect(adapter.remoteParticipants.has('bob')).toBe(false);
    });

    /**
     * Layer preference, and who wins when two things want different layers.
     *
     * The rules are the same three on both SDKs
     * (`sdks/flutter/swalvo_rtc/test/simulcast_test.dart` asserts the
     * identical set), because a developer moving between them should not
     * have to relearn whose choice sticks.
     */
    describe('layer preference precedence', () => {
      async function subscribedTrack(options: { adaptiveStream?: boolean } = {}) {
        const { adapter, socket } = await connectAdapter({
          participants: [{ id: 'bob' }],
          adaptiveStream: options.adaptiveStream,
        });
        const pc = await receiveOffer(socket);

        let track: RemoteTrack | undefined;
        adapter.on('trackSubscribed', (subscribed: RemoteTrack) => {
          track = subscribed;
        });

        socket.receive({
          type: 'track.published',
          participantId: 'bob',
          track: { trackId: 'bob-cam', kind: 'video', source: 'camera', muted: false, simulcast: true },
        });
        await flush();
        pc.emitTrack(new FakeMediaStreamTrack('video', 'bob-cam'));
        await flush();

        if (!track) throw new Error('the track never subscribed');
        return { adapter, socket, track };
      }

      const layersSent = (socket: FakeWebSocket) =>
        socket
          .sentMessages()
          .filter((message) => message.type === 'subscription.update')
          .map((message) => message.layer);

      it('sends an explicit request on to the SFU', async () => {
        const { socket, track } = await subscribedTrack();

        track.setLayer('low');
        await flush();

        expect(socket.lastSent('subscription.update')).toMatchObject({
          publisherId: 'bob',
          trackId: 'bob-cam',
          layer: 'low',
        });
      });

      it('lets an explicit request stand against adaptive streaming', async () => {
        const { adapter, socket, track } = await subscribedTrack();

        // A spotlighted speaker the application pinned to high.
        track.setLayer('high');
        await flush();

        // Adaptive streaming then measures a small tile and wants low.
        adapter.requestLayer(track, 'low', { automatic: true });
        await flush();

        expect(layersSent(socket)).toEqual(['high']);
        expect(adapter.pinnedLayer(track)).toBe('high');
      });

      it('releases the pin on auto', async () => {
        const { adapter, socket, track } = await subscribedTrack();

        track.setLayer('high');
        track.setLayer('auto');
        await flush();
        expect(adapter.pinnedLayer(track)).toBeUndefined();

        adapter.requestLayer(track, 'low', { automatic: true });
        await flush();

        expect(layersSent(socket)).toEqual(['high', 'auto', 'low']);
      });

      it('honours an explicit request with adaptiveStream off', async () => {
        // "I will manage quality myself" is a reasonable thing to want.
        const { socket, track } = await subscribedTrack({ adaptiveStream: false });

        track.setLayer('low');
        await flush();

        expect(layersSent(socket)).toEqual(['low']);
      });

      it('drops automatic requests entirely with adaptiveStream off', async () => {
        const { adapter, socket, track } = await subscribedTrack({ adaptiveStream: false });

        adapter.requestLayer(track, 'low', { automatic: true });
        await flush();

        expect(layersSent(socket)).toEqual([]);
      });

      it('does not re-send a layer the SFU already has', async () => {
        const { adapter, socket, track } = await subscribedTrack();

        for (let i = 0; i < 5; i++) {
          adapter.requestLayer(track, 'medium', { automatic: true });
        }
        await flush();

        // A tile laid out repeatedly at the same size is the normal case,
        // not the exception.
        expect(layersSent(socket)).toEqual(['medium']);
      });
    });

    it('subscribes a track announced before its media arrives', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(socket);

      const subscribed: { kind: TrackKind; from: string }[] = [];
      adapter.on('trackSubscribed', (track: RemoteTrack, participant: RemoteParticipant) =>
        subscribed.push({ kind: track.kind, from: participant.identity }),
      );

      socket.receive({
        type: 'track.published',
        participantId: 'bob',
        track: { trackId: 'bob-cam', kind: 'video', source: 'camera', muted: false, simulcast: false },
      });
      await flush();
      pc.emitTrack(new FakeMediaStreamTrack('video', 'bob-cam'));
      await flush();

      expect(subscribed).toEqual([{ kind: 'camera', from: 'bob' }]);
      expect(adapter.remoteParticipants.get('bob')?.tracks).toHaveLength(1);
    });

    /**
     * The regression that quietly stopped browser-to-browser subscriptions
     * ever completing.
     *
     * `RTCTrackEvent.track.id` is not the remote track id. Chrome mints a
     * fresh local one and ignores the `msid` entirely. Matching on it meant
     * every arriving track got parked as "media arrived early" and no
     * subscription ever finished. And it failed in silence rather than
     * loudly, which is why nothing but a real browser caught it.
     */
    it('matches an arriving track by its SDP msid, not by the local track id the browser minted', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(socket, offerWithMsid([{ mid: '1', streamId: 'bob-stream', trackId: 'bob-cam' }]));

      const subscribed: Array<{ kind: string; from: string }> = [];
      adapter.on('trackSubscribed', (track: RemoteTrack, participant: RemoteParticipant) =>
        subscribed.push({ kind: track.kind, from: participant.identity }),
      );

      socket.receive({
        type: 'track.published',
        participantId: 'bob',
        track: { trackId: 'bob-cam', kind: 'video', source: 'camera', muted: false, simulcast: false },
      });
      await flush();

      // Chrome's actual behaviour. The arriving track's own id has nothing
      // whatsoever to do with what the SFU labelled it.
      pc.emitTrack(new FakeMediaStreamTrack('video', 'chrome-minted-local-id'), '1');
      await flush();

      expect(subscribed).toEqual([{ kind: 'camera', from: 'bob' }]);
    });

    it('picks the right m-section when a publisher has two video tracks', async () => {
      // A camera and a screen share are both video, so scanning every
      // `a=msid:` line rather than the transceiver's own m-section ends up
      // labelling a screen share as somebody's face.
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(
        socket,
        offerWithMsid([
          { mid: '0', streamId: 'bob-stream', trackId: 'bob-cam' },
          { mid: '1', streamId: 'bob-stream', trackId: 'bob-screen' },
        ]),
      );

      const subscribed: Array<{ kind: string; from: string }> = [];
      adapter.on('trackSubscribed', (track: RemoteTrack, participant: RemoteParticipant) =>
        subscribed.push({ kind: track.kind, from: participant.identity }),
      );

      for (const track of [
        { trackId: 'bob-cam', source: 'camera' },
        { trackId: 'bob-screen', source: 'screenShare' },
      ]) {
        socket.receive({
          type: 'track.published',
          participantId: 'bob',
          track: { ...track, kind: 'video', muted: false, simulcast: false },
        });
      }
      await flush();

      pc.emitTrack(new FakeMediaStreamTrack('video', 'local-a'), '1');
      await flush();

      expect(subscribed).toEqual([{ kind: 'screenShare', from: 'bob' }]);
    });

    it('falls back to the local track id when the SDP carries no msid', async () => {
      // A stack reporting no mid, or an offer with no msid, still has to
      // work instead of dropping the track. The fallback is the old
      // behaviour, and that's correct wherever the ids do agree.
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(socket);

      const subscribed: string[] = [];
      adapter.on('trackSubscribed', (_track: RemoteTrack, participant: RemoteParticipant) =>
        subscribed.push(participant.identity),
      );

      socket.receive({
        type: 'track.published',
        participantId: 'bob',
        track: { trackId: 'bob-cam', kind: 'video', source: 'camera', muted: false, simulcast: false },
      });
      await flush();
      pc.emitTrack(new FakeMediaStreamTrack('video', 'bob-cam'));
      await flush();

      expect(subscribed).toEqual(['bob']);
    });

    it('subscribes a track whose media arrives before its announcement', async () => {
      // `ontrack` and `track.published` race and either can win. A
      // subscription that only worked in one order would drop tracks at
      // random.
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(socket);

      const subscribed: string[] = [];
      adapter.on('trackSubscribed', (_track: RemoteTrack, participant: RemoteParticipant) =>
        subscribed.push(participant.identity),
      );

      pc.emitTrack(new FakeMediaStreamTrack('video', 'bob-cam'));
      await flush();
      expect(subscribed).toEqual([]);

      socket.receive({
        type: 'track.published',
        participantId: 'bob',
        track: { trackId: 'bob-cam', kind: 'video', source: 'camera', muted: false, simulcast: false },
      });
      await flush();

      expect(subscribed).toEqual(['bob']);
    });

    it('reports a screen share as a screen share, not a camera', async () => {
      // The whole reason the source gets declared over signaling. Both are
      // video, and codec kind can't tell them apart (spec §16).
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(socket);

      let kind: TrackKind | undefined;
      adapter.on('trackSubscribed', (track: RemoteTrack) => {
        kind = track.kind;
      });

      socket.receive({
        type: 'track.published',
        participantId: 'bob',
        track: { trackId: 'bob-screen', kind: 'video', source: 'screenShare', muted: false, simulcast: false },
      });
      await flush();
      pc.emitTrack(new FakeMediaStreamTrack('video', 'bob-screen'));
      await flush();

      expect(kind).toBe('screenShare');
    });

    it("reflects the publisher's mute, not the browser's data-arrival flag", async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(socket);

      let track: RemoteTrack | undefined;
      adapter.on('trackSubscribed', (subscribed: RemoteTrack) => {
        track = subscribed;
      });
      const muteEvents: string[] = [];
      adapter.on('trackMuted', () => muteEvents.push('muted'));
      adapter.on('trackUnmuted', () => muteEvents.push('unmuted'));

      socket.receive({
        type: 'track.published',
        participantId: 'bob',
        track: { trackId: 'bob-cam', kind: 'video', source: 'camera', muted: false, simulcast: false },
      });
      await flush();
      pc.emitTrack(new FakeMediaStreamTrack('video', 'bob-cam'));
      await flush();

      expect(track?.isMuted).toBe(false);

      socket.receive({ type: 'track.muted', participantId: 'bob', trackId: 'bob-cam' });
      await flush();
      expect(track?.isMuted).toBe(true);

      socket.receive({ type: 'track.unmuted', participantId: 'bob', trackId: 'bob-cam' });
      await flush();
      expect(track?.isMuted).toBe(false);
      expect(muteEvents).toEqual(['muted', 'unmuted']);
    });

    it("drops a departed participant's tracks without waiting for the browser", async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(socket);

      socket.receive({
        type: 'track.published',
        participantId: 'bob',
        track: { trackId: 'bob-cam', kind: 'video', source: 'camera', muted: false, simulcast: false },
      });
      await flush();
      pc.emitTrack(new FakeMediaStreamTrack('video', 'bob-cam'));
      await flush();

      const unsubscribed: string[] = [];
      adapter.on('trackUnsubscribed', (_track: RemoteTrack, participant: RemoteParticipant) =>
        unsubscribed.push(participant.identity),
      );

      socket.receive({ type: 'participant.left', participant: { id: 'bob' } });
      await flush();

      expect(unsubscribed).toEqual(['bob']);
    });

    it('reconciles the room on rejoin instead of duplicating participants', async () => {
      // A reconnect re-runs the join, so the participant list turns up all
      // over again. Append it and every tile in the UI doubles.
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const events: string[] = [];
      adapter.on('participantJoined', (p: RemoteParticipant) => events.push(`+${p.identity}`));
      adapter.on('participantLeft', (p: RemoteParticipant) => events.push(`-${p.identity}`));

      socket.receive({
        type: 'room.joined',
        roomId: 'room-1',
        participants: [{ id: 'bob' }, { id: 'carol' }],
      });
      await flush();

      // bob was already known and stays put. carol is new.
      expect(events).toEqual(['+carol']);
      expect([...adapter.remoteParticipants.keys()].sort()).toEqual(['bob', 'carol']);
    });
  });

  describe('publishing', () => {
    describe('preferredVideoCodec', () => {
      const vp8 = { mimeType: 'video/VP8', clockRate: 90000 };
      const rtx = { mimeType: 'video/rtx', clockRate: 90000, sdpFmtpLine: 'apt=96' };
      const h264 = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1' };
      const original = (globalThis as { RTCRtpSender?: unknown }).RTCRtpSender;
      beforeEach(() => {
        (globalThis as { RTCRtpSender?: unknown }).RTCRtpSender = {
          getCapabilities: () => ({ codecs: [vp8, rtx, h264], headerExtensions: [] }),
        };
      });
      afterEach(() => {
        (globalThis as { RTCRtpSender?: unknown }).RTCRtpSender = original;
      });

      it('puts the preferred codec first on the camera transceiver', async () => {
        // Live-stream hosts set 'h264' so the stream's HLS/RTMP output can
        // copy their encoding instead of re-encoding it.
        const { adapter, socket } = await connectAdapter({ preferredVideoCodec: 'h264' });
        await receiveOffer(socket);
        await adapter.enableCamera(true);
        await flush();
        const transceiver = FakeRTCPeerConnection.latest.transceivers.at(-1);
        expect(transceiver?.codecPreferences?.map((c) => c.mimeType)).toEqual(['video/H264', 'video/VP8', 'video/rtx']);
      });

      it("leaves the browser's order alone when no codec is preferred", async () => {
        const { adapter, socket } = await connectAdapter();
        await receiveOffer(socket);
        await adapter.enableCamera(true);
        await flush();
        expect(FakeRTCPeerConnection.latest.transceivers.at(-1)?.codecPreferences).toBeUndefined();
      });
    });

    it('declares the track source, adds it, and offers', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      const track = await adapter.enableCamera(true);
      await flush();

      expect(track?.kind).toBe('camera');
      expect(pc.addedTracks).toHaveLength(1);
      expect(socket.lastSent('track.publish')).toMatchObject({ source: 'camera' });
      expect(String(socket.lastSent('sdp.offer')?.sdp)).toContain('fake-client-offer');
    });

    it('declares three simulcast layers on the transceiver it creates for a camera', async () => {
      // Spec §15. Quarter-pixel steps, which is the ladder browsers
      // actually implement well.
      //
      // This test used to assert on `sender.setParametersCalls`, and passed
      // for months while the SDK published exactly one layer. That is the
      // trap: `setParameters` was *called*, and the call is specified to be
      // rejected, so asserting on the call proved only that the SDK tried.
      // The encodings have to be on the transceiver at creation or they
      // never reach the SDP at all.
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      await adapter.enableCamera(true);
      await flush();

      const pc = FakeRTCPeerConnection.latest;
      expect(pc.transceiverInits).toHaveLength(1);

      const encodings = pc.transceiverInits[0].sendEncodings ?? [];
      expect(encodings.map((encoding) => encoding.rid)).toEqual(['low', 'medium', 'high']);
      expect(encodings.map((encoding) => encoding.scaleResolutionDownBy)).toEqual([4, 2, 1]);
      expect(encodings.map((encoding) => encoding.maxBitrate)).toEqual([150_000, 500_000, 1_500_000]);
      expect(encodings.map((encoding) => encoding.maxFramerate)).toEqual([15, 30, 30]);
    });

    it('sends an offer whose SDP actually negotiates simulcast', async () => {
      // The falsifiable form of the claim. `getParameters()` reporting three
      // encodings is what a broken implementation looks like too; the SDP is
      // the only artefact the far side ever sees, and the SFU answers
      // `a=simulcast:recv` off exactly these lines
      // (services/sfu/internal/room/simulcast_integration_test.go).
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      await adapter.enableCamera(true);
      await flush();

      const sdp = String(socket.lastSent('sdp.offer')?.sdp);
      expect(sdp).toContain('a=simulcast:send low;medium;high');
      expect(sdp).toContain('a=rid:low send');
      expect(sdp).toContain('a=rid:medium send');
      expect(sdp).toContain('a=rid:high send');
      expect(sdpNegotiatesSimulcast(sdp)).toBe(true);
    });

    it('reports simulcast as enabled only after reading the negotiated sender back', async () => {
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      await adapter.enableCamera(true);
      await flush();

      expect(adapter.simulcastStatus('camera')).toBe('enabled');
    });

    it('does not simulcast a screen share', async () => {
      // Screen content is usually text, and dropping resolution wrecks
      // legibility in a way it never does for a face.
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      await adapter.enableScreenShare(true);
      await flush();

      expect(FakeRTCPeerConnection.latest.transceiverInits).toHaveLength(0);
      expect(String(socket.lastSent('sdp.offer')?.sdp)).not.toContain('a=simulcast:send');
      expect(adapter.simulcastStatus('screenShare')).toBe('notApplicable');
    });

    it('does not simulcast audio', async () => {
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      await adapter.enableMicrophone(true);
      await flush();

      expect(FakeRTCPeerConnection.latest.transceiverInits).toHaveLength(0);
      expect(adapter.simulcastStatus('microphone')).toBe('notApplicable');
    });

    it('gives a re-enabled camera a fresh transceiver, stopping the old one', async () => {
      // Reviving the old transceiver with replaceTrack kept its SSRCs and
      // msid, so the SFU never saw a new track and every subscriber lost
      // the camera after a disable/enable cycle. The old one is stopped
      // instead — a real browser recycles its m-section for the next one,
      // so the SDP stays bounded (verified in a real browser by
      // apps/api/test/rtc-two-browser.e2e-spec.ts).
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      await adapter.enableCamera(true);
      await flush();
      const pc = FakeRTCPeerConnection.latest;
      const first = pc.transceivers.find((t) => t.rids.length > 0)!;

      await adapter.enableCamera(false);
      await flush();
      expect(first.direction).toBe('stopped');

      await adapter.enableCamera(true);
      await flush();

      expect(pc.transceiverInits).toHaveLength(2);
      const live = pc.transceivers.filter((t) => t.rids.length > 0 && t.direction !== 'stopped');
      expect(live).toHaveLength(1);
      expect(live[0]).not.toBe(first);
      expect(live[0].direction).toBe('sendonly');
    });

    it('unmutes an already-published track rather than capturing again', async () => {
      // A second getUserMedia on the same device is slower, and on some
      // platforms it just fails.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      const first = await adapter.enableCamera(true);
      await first?.mute();
      const second = await adapter.enableCamera(true);
      await flush();

      expect(second).toBe(first);
      expect(pc.addedTracks).toHaveLength(1);
      expect(first?.isMuted).toBe(false);
      expect(socket.lastSent('track.mute')).toMatchObject({ muted: false });
    });

    it('stops the device and renegotiates when disabled', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      const track = await adapter.enableCamera(true);
      await flush();
      const mediaStreamTrack = track!.mediaStreamTrack as unknown as FakeMediaStreamTrack;

      await adapter.enableCamera(false);
      await flush();

      expect(mediaStreamTrack.stopped).toBe(true);
      // A simulcast camera leaves the connection by stopping its own
      // transceiver (see unpublish), which also flags a renegotiation.
      const camera = pc.transceivers.find((t) => t.rids.length > 0);
      expect(camera?.direction).toBe('stopped');
      expect(camera?.sender.track).toBeNull();
      expect(adapter.localParticipant.tracks).toHaveLength(0);
    });

    it('unpublishes when the user stops a screen share from the browser bar', async () => {
      // The track simply ends and nothing tells the application. Leave it
      // published and everyone else stares at a frozen last frame.
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      const track = await adapter.enableScreenShare(true);
      await flush();

      const unpublished: string[] = [];
      adapter.on('localTrackUnpublished', (unpublishedTrack) => unpublished.push(unpublishedTrack.kind));

      (track!.mediaStreamTrack as unknown as FakeMediaStreamTrack).end();
      await flush();

      expect(unpublished).toEqual(['screenShare']);
    });

    it('defers an offer while the server has one in flight', async () => {
      // Two offers on one PeerConnection is glare. The server refuses
      // ours, so deferring skips the round trip altogether.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      pc.signalingState = 'have-remote-offer';

      await adapter.enableCamera(true);
      await flush();

      expect(socket.lastSent('sdp.offer')).toBeUndefined();

      // Answering the server's next offer puts us back to stable and
      // flushes the deferred publish.
      pc.signalingState = 'stable';
      socket.receive({ type: 'sdp.offer', sdp: 'v=0 second-server-offer' });
      await flush();
      await flush();

      expect(String(socket.lastSent('sdp.offer')?.sdp)).toContain('fake-client-offer');
    });

    it('publishes a microphone and a camera back to back as one renegotiation', async () => {
      // The developer-facing contract: no waiting between the two calls,
      // and no second round trip for the second track.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      await adapter.enableMicrophone(true);
      await adapter.enableCamera(true);
      await flush();

      expect(pc.activeSenders('audio')).toHaveLength(1);
      expect(pc.activeSenders('video')).toHaveLength(1);
      expect(pc.refusedDescriptions).toEqual([]);

      // The camera was added while the microphone's offer was still out,
      // so it rides the next round rather than racing this one. No
      // competing offer, and nothing dropped.
      expect(pc.signalingState).toBe('have-local-offer');
      expect(socket.sentMessages().filter((message) => message.type === 'sdp.offer')).toHaveLength(1);

      await settleNegotiation(socket, pc);

      expect(pc.signalingState).toBe('stable');
      for (const transceiver of pc.getTransceivers()) {
        expect(transceiver.currentDirection).toBe('sendrecv');
      }
    });

    it('does not offer into an incompatible signaling state when the sfu offers mid-createOffer', async () => {
      // The race this whole chain exists for. `createOffer()` yields, and
      // the SFU's offer lands in exactly that gap. The old code had
      // already checked `signalingState` and went on to call
      // `setLocalDescription`, which threw "Called in wrong state:
      // have-remote-offer" and left a sender with no m-section.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      const errors: Error[] = [];
      adapter.on('mediaError', (error) => errors.push(error));

      // Freeze the interfering round with its remote description applied
      // and its answer not yet built. That is the exact window.
      let releaseAnswer = () => undefined as void;
      pc.pauseCreateAnswer = new Promise<void>((resolve) => {
        releaseAnswer = resolve;
      });

      let interfered = false;
      pc.beforeCreateOffer = async () => {
        if (interfered) {
          return;
        }
        interfered = true;
        // Delivered exactly like the socket would, and *applied* before
        // createOffer resolves. Without the await this is not the race:
        // the offer would sit on a microtask until after our own
        // setLocalDescription had already gone through.
        socket.receive({ type: 'sdp.offer', sdp: 'v=0 server-offer-mid-flight' });
        await flush();
      };

      await adapter.enableCamera(true);
      await flush();

      // Let the frozen round finish, then let everything drain.
      releaseAnswer();
      pc.pauseCreateAnswer = undefined;
      await flush();
      await flush();
      await flush();

      // Nothing was ever handed to the connection in a state it could not
      // take. This is the assertion the old code failed: it called
      // setLocalDescription(offer) in have-remote-offer.
      expect(pc.refusedDescriptions).toEqual([]);
      expect(errors).toEqual([]);
      // The interfering offer got answered, and our own publish still made
      // it out afterwards.
      expect(socket.lastSent('sdp.answer')).toBeDefined();
      expect(socket.lastSent('sdp.offer')).toBeDefined();
      expect(pc.activeSenders('video')).toHaveLength(1);
      await settleNegotiation(socket, pc);
      expect(pc.getTransceivers().every((t) => t.currentDirection === 'sendrecv')).toBe(true);
    });

    it('rolls its own offer back when the sfu offers at the same time, and re-offers after', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      await adapter.enableCamera(true);
      await flush();
      expect(pc.signalingState).toBe('have-local-offer');

      // Glare: the SFU offers while our offer is still out. The SFU wins.
      socket.receive({ type: 'sdp.offer', sdp: 'v=0 glare-server-offer' });
      await flush();

      expect(pc.descriptions).toEqual(expect.arrayContaining([{ side: 'local', type: 'rollback' }]));
      expect(socket.lastSent('sdp.answer')).toBeDefined();

      // And our change is re-offered rather than dropped.
      await flush();
      const offers = socket.sentMessages().filter((message) => message.type === 'sdp.offer');
      expect(offers.length).toBeGreaterThanOrEqual(2);
      expect(pc.activeSenders('video')).toHaveLength(1);
    });

    it('never applies an answer in a state that cannot take one', async () => {
      // "Failed to set remote answer sdp: Called in wrong state: stable"
      // came from applying an answer whose offer no longer existed —
      // rolled back for glare, or superseded. Dropping it is right; what
      // matters is that it is never handed to the PeerConnection.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      const offerSdp = pc.remoteDescription?.sdp;

      const errors: Error[] = [];
      adapter.on('mediaError', (error) => errors.push(error));

      expect(pc.signalingState).toBe('stable');
      socket.receive({ type: 'sdp.answer', sdp: 'v=0 answer-to-a-dead-offer' });
      await flush();

      expect(errors).toEqual([]);
      expect(pc.remoteDescription?.sdp).toBe(offerSdp);
      expect(pc.signalingState).toBe('stable');
      // Not "it threw and we swallowed it" — the connection was never
      // asked in the first place.
      expect(pc.refusedDescriptions).toEqual([]);
    });

    it('re-offers when the sfu refuses a publish as glare', async () => {
      // The server-side half of the same tie-break. This used to be
      // logged and dropped, which is how a camera ended up with a sender
      // and no m-section to send on.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      await adapter.enableCamera(true);
      await flush();
      const before = socket.sentMessages().filter((message) => message.type === 'sdp.offer').length;

      socket.receive({ type: 'error', code: 'NEGOTIATION_GLARE', message: 'negotiation in progress' });
      await flush();
      await flush();

      // Nothing sent yet. The SFU's message says "answer it, then retry",
      // and retrying before that offer arrives is how this turns into an
      // offer/refusal loop that trips the connection's rate limit.
      expect(socket.sentMessages().filter((message) => message.type === 'sdp.offer')).toHaveLength(before);

      // Whatever round the server was in ends by offering us one.
      socket.receive({ type: 'sdp.offer', sdp: 'v=0 server-offer-after-glare' });
      await flush();
      await flush();

      const after = socket.sentMessages().filter((message) => message.type === 'sdp.offer').length;
      expect(after).toBeGreaterThan(before);
      expect(pc.activeSenders('video')).toHaveLength(1);
    });

    it('coalesces mic, camera and screen share published in rapid succession', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      await Promise.all([adapter.enableMicrophone(true), adapter.enableCamera(true), adapter.enableScreenShare(true)]);
      await flush();

      expect(pc.activeSenders('audio')).toHaveLength(1);
      expect(pc.activeSenders('video')).toHaveLength(2);
      expect(socket.sentMessages().filter((message) => message.type === 'sdp.offer')).toHaveLength(1);
      expect(
        socket
          .sentMessages()
          .filter((message) => message.type === 'track.publish')
          .map((message) => message.source),
      ).toEqual(expect.arrayContaining(['microphone', 'camera', 'screenShare']));
    });

    it('shares one operation between overlapping enableCamera calls', async () => {
      // Two clicks on the same button used to mean two getUserMedia
      // prompts, two senders, and one of them orphaned in the map.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      const [first, second] = await Promise.all([adapter.enableCamera(true), adapter.enableCamera(true)]);
      await flush();

      expect(pc.activeSenders('video')).toHaveLength(1);
      expect(first).toBeDefined();
      // The second call found the track already published and unmuted it.
      expect(second).toBe(first);
    });

    it("stops offering once the sfu's own offer has carried the change", async () => {
      // The loop this cost us. Swalvo's SFU adds a receive slot for a track
      // as soon as the client declares it, so its next offer often carries
      // a just-published camera. An SDK that keeps its own "something
      // changed" flag cannot tell, so it re-offers, collides with the next
      // SFU offer, rolls back, and goes round again: 48 rounds on one join
      // against the real SFU, until the connection's rate limit tripped.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      pc.offerCoversPendingChanges = true;

      await adapter.enableCamera(true);
      await flush();

      // Our offer went out, and the SFU offers at the same moment.
      socket.receive({ type: 'sdp.offer', sdp: 'v=0 sfu-offer-carrying-the-camera' });
      await flush();
      await flush();
      await flush();

      const offers = socket.sentMessages().filter((message) => message.type === 'sdp.offer').length;

      // Several more rounds of the SFU offering, which is what a busy room
      // looks like. Nothing new of ours to negotiate, so nothing new sent.
      for (let round = 0; round < 5; round++) {
        socket.receive({ type: 'sdp.offer', sdp: `v=0 sfu-offer-${round}` });
        await flush();
        await flush();
      }

      expect(socket.sentMessages().filter((message) => message.type === 'sdp.offer')).toHaveLength(offers);
      expect(pc.signalingState).toBe('stable');
      expect(pc.activeSenders('video')).toHaveLength(1);
    });

    it("offers again when the wire still carries somebody else's msid", async () => {
      // Swalvo's SFU identifies a published track by the id in the SDP
      // `msid` and matches it to the `track.publish` declaration that says
      // camera or screen share. The SFU pre-creates a receive slot for a
      // declared track, `addTrack` reuses that transceiver, and if the
      // SFU's own next offer covers the m-line then the browser is
      // satisfied while the wire still names the SFU's msid. RTP flows and
      // the SFU has no idea whose track it is — a screen share arrives
      // labelled as a camera. So "the browser is happy" is not the whole
      // invariant; our ids have to be on the wire.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      // The m-section keeps announcing a track that is not ours, however
      // many descriptions get applied.
      pc.msidOverrides.set('0', 'a-track-the-sfu-made-up');
      pc.offerCoversPendingChanges = true;

      await adapter.enableScreenShare(true);
      await flush();
      await flush();

      // An offer went out to put our id on the wire, even though the
      // browser's own negotiation-needed bit was clear.
      expect(socket.lastSent('sdp.offer')).toBeDefined();

      // And it stops once the id is there: no offer/answer treadmill.
      pc.msidOverrides.delete('0');
      await settleNegotiation(socket, pc);
      const offers = socket.sentMessages().filter((m) => m.type === 'sdp.offer').length;
      for (let round = 0; round < 4; round++) {
        socket.receive({ type: 'sdp.offer', sdp: `v=0 sfu-offer-${round}` });
        await flush();
        await flush();
      }
      expect(socket.sentMessages().filter((m) => m.type === 'sdp.offer')).toHaveLength(offers);
    });

    it('declares the source under the publication id the wire actually carries', async () => {
      // A publication's identity in this protocol is the track id in the
      // SDP `a=msid:` line: the SFU keys its published-track map, its
      // source declaration, its mute lookups and the id it announces to
      // subscribers on exactly that. The SFU also pre-creates a recvonly
      // transceiver per kind, `addTrack` reuses it, and the m-section can
      // keep an msid the browser will not rewrite — so the declared id and
      // the wire id came apart, the SFU matched nothing, and it inferred
      // the source from the codec kind. A screen share inferred that way
      // is a camera.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      // What a reused transceiver looks like: the m-section announces an
      // id that is not the track's.
      pc.msidOverrides.set('0', 'id-the-sfu-put-there');

      const share = await adapter.enableScreenShare(true);
      await flush();
      await flush();

      const localId = share!.mediaStreamTrack.id;
      const declarations = socket
        .sentMessages()
        .filter((message) => message.type === 'track.publish')
        .map((message) => ({ trackId: message.trackId, source: message.source }));

      // Declared again under the wire id, still as a screen share.
      expect(declarations).toContainEqual({
        trackId: 'id-the-sfu-put-there',
        source: 'screenShare',
      });
      // And the correction arrived after the first, hopeful, declaration.
      expect(declarations.at(-1)).toEqual({
        trackId: 'id-the-sfu-put-there',
        source: 'screenShare',
      });
      expect(localId).not.toBe('id-the-sfu-put-there');
    });

    it('sends the corrected id on the same socket before the description it describes', async () => {
      // Ordering is the whole reason this needs no delay: one socket,
      // FIFO, so a declaration queued before the answer reaches the SFU
      // before the media that answer unblocks.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      pc.msidOverrides.set('0', 'wire-id');

      await adapter.enableCamera(true);
      await flush();
      await flush();

      const order = socket
        .sentMessages()
        .map((message, index) => ({ index, type: message.type, trackId: message.trackId }));
      const corrected = order.find((m) => m.type === 'track.publish' && m.trackId === 'wire-id');
      const description = order.filter((m) => m.type === 'sdp.offer' || m.type === 'sdp.answer').at(-1);

      expect(corrected).toBeDefined();
      expect(description).toBeDefined();
      expect(corrected!.index).toBeLessThan(description!.index);
    });

    it('mutes by the corrected publication id, not the local track id', async () => {
      // Mute lookups are keyed on the same id, so they were missing the
      // track for exactly the same reason.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      pc.msidOverrides.set('0', 'wire-id');

      await adapter.enableCamera(true);
      await settleNegotiation(socket, pc);

      // Enabling an already-published kind unmutes it over signaling.
      await adapter.enableCamera(true);
      await flush();

      expect(socket.lastSent('track.mute')).toMatchObject({ trackId: 'wire-id', muted: false });
    });

    it('leaves the id alone when the wire already agrees', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      const camera = await adapter.enableCamera(true);
      await settleNegotiation(socket, pc);

      const declarations = socket.sentMessages().filter((message) => message.type === 'track.publish');
      expect(declarations).toHaveLength(1);
      expect(declarations[0]).toMatchObject({
        trackId: camera!.mediaStreamTrack.id,
        source: 'camera',
      });
    });

    it('keeps a camera and a screen share apart, by id and by source', async () => {
      // Two video m-sections, one of them reusing the SFU's slot. Reading
      // the msid by mid is what keeps them from being labelled alike.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      pc.msidOverrides.set('0', 'sfu-video-slot');

      const camera = await adapter.enableCamera(true);
      await settleNegotiation(socket, pc);
      const share = await adapter.enableScreenShare(true);
      await settleNegotiation(socket, pc);

      const bySource = new Map(
        socket
          .sentMessages()
          .filter((message) => message.type === 'track.publish')
          .map((message) => [message.source as string, message.trackId as string]),
      );

      // The reused slot's id belongs to whichever track landed on it, and
      // the other keeps its own. Either way the two are distinct and each
      // carries its own source.
      expect(bySource.get('camera')).toBeDefined();
      expect(bySource.get('screenShare')).toBeDefined();
      expect(bySource.get('camera')).not.toBe(bySource.get('screenShare'));
      expect([camera!.mediaStreamTrack.id, 'sfu-video-slot']).toContain(bySource.get('camera'));
      expect([share!.mediaStreamTrack.id, 'sfu-video-slot']).toContain(bySource.get('screenShare'));
    });

    it('refuses to publish a track it did not create', async () => {
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      const foreign = {
        kind: 'camera' as TrackKind,
        mediaStreamTrack: new FakeMediaStreamTrack('video', 'foreign'),
        delegate: {},
      };

      await expect(adapter.publish(foreign as never)).rejects.toBeInstanceOf(RTCError);
    });
  });

  describe('data channel', () => {
    it('opens a channel on demand and sends the payload', async () => {
      // Not opened at connect. A channel costs an SCTP association and
      // most calls never send a byte.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      expect(pc.dataChannels).toHaveLength(0);

      const sending = adapter.sendData(new TextEncoder().encode('hello') as Uint8Array<ArrayBuffer>);
      await flush();

      // Creating the channel needs an `m=application` section, so the
      // adapter offers on its own initiative.
      expect(pc.dataChannels).toHaveLength(1);
      expect(pc.dataChannels[0].label).toBe('raven-data');
      expect(socket.lastSent('sdp.offer')).toBeDefined();

      // The channel opens with the round trip, and the queued payload goes.
      socket.receive({ type: 'sdp.answer', sdp: 'v=0 fake-server-answer' });
      await sending;

      expect(pc.dataChannels[0].readyState).toBe('open');
      expect(pc.dataChannels[0].sent).toHaveLength(1);
    });

    it('rejects a payload over the size limit', async () => {
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      const tooBig = new Uint8Array(64 * 1024 + 1) as Uint8Array<ArrayBuffer>;
      await expect(adapter.sendData(tooBig)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });

    it('emits data the SFU forwarded, with no attributed sender', async () => {
      // The transport carries no sender identity at all, since the SFU
      // fans data out over each recipient's own channel. Attributing it
      // would mean trusting a field the sender controls.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      const received: { payload: Uint8Array; from?: RemoteParticipant }[] = [];
      adapter.on('dataReceived', (payload, from) => received.push({ payload, from }));

      const channel = pc.emitDataChannel('raven-data');
      channel.receive(new TextEncoder().encode('ping').buffer as ArrayBuffer);

      expect(received).toHaveLength(1);
      expect(new TextDecoder().decode(received[0].payload)).toBe('ping');
      expect(received[0].from).toBeUndefined();
    });

    it('ignores a channel with an unexpected label', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      const received: unknown[] = [];
      adapter.on('dataReceived', (payload) => received.push(payload));

      const channel = pc.emitDataChannel('someone-elses-channel');
      channel.receive(new TextEncoder().encode('nope').buffer as ArrayBuffer);

      expect(received).toHaveLength(0);
    });
  });

  describe('publication identity across a source lifecycle', () => {
    /**
     * The SFU's view of this participant's publications, built the way the
     * SFU builds it.
     *
     * `track.publish` declares a source against a publication id; the RTP
     * stream announces an id of its own in the SDP `msid`. The SFU matches
     * the two and, failing that, infers the source from the codec kind —
     * which cannot tell a screen share from a camera. Asserting on this
     * rather than on what the SDK meant is the point: it is the server's
     * conclusion that consumers read.
     */
    function sfuView(socket: FakeWebSocket, pc: FakeRTCPeerConnection) {
      const declared = new Map<string, string>();
      for (const message of socket.sentMessages()) {
        if (message.type === 'track.publish') {
          declared.set(message.trackId as string, message.source as string);
        }
      }

      const wireIds = new Map<string, string>();
      let mid: string | undefined;
      for (const line of (pc.localDescription?.sdp ?? '').split(/\r?\n/)) {
        if (line.startsWith('a=mid:')) {
          mid = line.slice('a=mid:'.length).trim();
        }
        if (line.startsWith('a=msid:') && mid) {
          const trackId = line.slice('a=msid:'.length).trim().split(/\s+/)[1];
          if (trackId) {
            wireIds.set(mid, trackId);
          }
        }
      }

      return pc
        .getTransceivers()
        .filter((transceiver) => transceiver.sender.track !== null)
        .map((transceiver) => {
          const publicationId = wireIds.get(transceiver.mid) ?? transceiver.sender.track!.id;
          const kind = transceiver.sender.track!.kind;
          return {
            publicationId,
            kind,
            source: declared.get(publicationId) ?? (kind === 'audio' ? 'microphone' : 'camera'),
            guessed: !declared.has(publicationId),
          };
        });
    }

    /** Joins, then answers the SFU's slot-bearing offer. */
    async function joined(): Promise<{
      adapter: SwalvoAdapter;
      socket: FakeWebSocket;
      pc: FakeRTCPeerConnection;
    }> {
      const { adapter, socket } = await connectAdapter({ autoReconnect: true });
      socket.receive({ type: 'sdp.offer', sdp: sfuJoinOffer() });
      await flush();
      return { adapter, socket, pc: FakeRTCPeerConnection.latest };
    }

    async function rejoin(socket: FakeWebSocket): Promise<{ socket: FakeWebSocket; pc: FakeRTCPeerConnection }> {
      const before = FakeWebSocket.instances.length;
      socket.close(1006);
      await flush();
      const next = await waitForNewSocket(before);
      next.receive({
        type: 'room.joined',
        roomId: 'room-1',
        participants: [],
        rtcServer: 'sfu-local-01',
        region: 'local',
      });
      await flush();
      // The new session offers its own slots, as the old one did.
      next.receive({ type: 'sdp.offer', sdp: sfuJoinOffer('sfu-rejoin') });
      await flush();
      return { socket: next, pc: FakeRTCPeerConnection.latest };
    }

    it('classifies a camera and a screen share unambiguously, and keeps doing so', async () => {
      // 1. join
      const { adapter, socket, pc } = await joined();

      // 2. publish camera — this is the publish that reuses the SFU's
      // video slot and inherits its msid.
      await adapter.enableCamera(true);
      await settleNegotiation(socket, pc);

      // 3. publish screen share
      await adapter.enableScreenShare(true);
      await settleNegotiation(socket, pc);

      // 4. two video publications. 5/6. one camera, one screen share,
      // neither of them guessed.
      let view = sfuView(socket, pc);
      expect(view.filter((publication) => publication.kind === 'video')).toHaveLength(2);
      expect(view.map((publication) => publication.source).sort()).toEqual(['camera', 'screenShare']);
      expect(view.every((publication) => !publication.guessed)).toBe(true);
      expect(new Set(view.map((publication) => publication.publicationId)).size).toBe(2);

      // 9. reconnect. 10. the sources survive it.
      const rejoined = await rejoin(socket);
      await settleNegotiation(rejoined.socket, rejoined.pc);

      view = sfuView(rejoined.socket, rejoined.pc);
      expect(view.filter((publication) => publication.kind === 'video')).toHaveLength(2);
      expect(view.map((publication) => publication.source).sort()).toEqual(['camera', 'screenShare']);
      expect(view.every((publication) => !publication.guessed)).toBe(true);

      // 11. stop the screen share.
      await adapter.enableScreenShare(false);
      await settleNegotiation(rejoined.socket, rejoined.pc);
      expect(sfuView(rejoined.socket, rejoined.pc).map((publication) => publication.source)).toEqual(['camera']);

      // 12. start it again. 13. still classified as a screen share.
      await adapter.enableScreenShare(true);
      await settleNegotiation(rejoined.socket, rejoined.pc);
      view = sfuView(rejoined.socket, rejoined.pc);
      expect(view.map((publication) => publication.source).sort()).toEqual(['camera', 'screenShare']);
      expect(view.every((publication) => !publication.guessed)).toBe(true);
    });

    it('camera, stopped, then a screen share onto the freed slot', async () => {
      const { adapter, socket, pc } = await joined();

      await adapter.enableCamera(true);
      await settleNegotiation(socket, pc);
      await adapter.enableCamera(false);
      await settleNegotiation(socket, pc);
      await adapter.enableScreenShare(true);
      await settleNegotiation(socket, pc);

      const view = sfuView(socket, pc);
      expect(view.map((publication) => publication.source)).toEqual(['screenShare']);
      expect(view.every((publication) => !publication.guessed)).toBe(true);
    });

    it('screen share, stopped, then a camera onto the freed slot', async () => {
      const { adapter, socket, pc } = await joined();

      await adapter.enableScreenShare(true);
      await settleNegotiation(socket, pc);
      await adapter.enableScreenShare(false);
      await settleNegotiation(socket, pc);
      await adapter.enableCamera(true);
      await settleNegotiation(socket, pc);

      const view = sfuView(socket, pc);
      expect(view.map((publication) => publication.source)).toEqual(['camera']);
      expect(view.every((publication) => !publication.guessed)).toBe(true);
    });

    it('camera and screen share published concurrently', async () => {
      const { adapter, socket, pc } = await joined();

      await Promise.all([adapter.enableCamera(true), adapter.enableScreenShare(true)]);
      await settleNegotiation(socket, pc);

      const view = sfuView(socket, pc);
      expect(view.map((publication) => publication.source).sort()).toEqual(['camera', 'screenShare']);
      expect(view.every((publication) => !publication.guessed)).toBe(true);
      expect(new Set(view.map((publication) => publication.publicationId)).size).toBe(2);
    });

    it('reconnects while screen sharing', async () => {
      const { adapter, socket, pc } = await joined();
      await adapter.enableScreenShare(true);
      await settleNegotiation(socket, pc);

      const rejoined = await rejoin(socket);
      await settleNegotiation(rejoined.socket, rejoined.pc);

      const view = sfuView(rejoined.socket, rejoined.pc);
      expect(view).toHaveLength(1);
      expect(view[0].kind).toBe('video');
      expect(view[0].source).toBe('screenShare');
      expect(view[0].guessed).toBe(false);
    });

    it('a microphone still classifies as a microphone through the same reuse', async () => {
      const { adapter, socket, pc } = await joined();

      await adapter.enableMicrophone(true);
      await settleNegotiation(socket, pc);

      const view = sfuView(socket, pc);
      expect(view).toHaveLength(1);
      expect(view[0].kind).toBe('audio');
      expect(view[0].source).toBe('microphone');
      expect(view[0].guessed).toBe(false);
    });
  });

  describe('data channel bootstrap', () => {
    it('sends data in an empty room with no media published', async () => {
      // The developer-facing contract: join, then send. No camera, no
      // microphone, no knowledge of SDP. Before this, the first send threw
      // "The data channel is not open yet" and only worked if a media
      // publish happened to renegotiate the channel along the way.
      const { adapter, socket } = await connectAdapter();

      const sending = adapter.sendData(new TextEncoder().encode('hello') as Uint8Array<ArrayBuffer>);
      await flush();

      const pc = FakeRTCPeerConnection.latest;
      expect(pc.senders).toHaveLength(0);
      expect(pc.dataChannels).toHaveLength(1);
      expect(socket.lastSent('sdp.offer')).toBeDefined();

      socket.receive({ type: 'sdp.answer', sdp: 'v=0 fake-server-answer' });
      await sending;

      expect(pc.dataChannels[0].readyState).toBe('open');
      expect(pc.dataChannels[0].sent).toHaveLength(1);
    });

    it('queues payloads sent before the channel opens, in order', async () => {
      const { adapter, socket } = await connectAdapter();

      const sends = [
        adapter.sendData(new TextEncoder().encode('one') as Uint8Array<ArrayBuffer>),
        adapter.sendData(new TextEncoder().encode('two') as Uint8Array<ArrayBuffer>),
        adapter.sendData(new TextEncoder().encode('three') as Uint8Array<ArrayBuffer>),
      ];
      await flush();

      const pc = FakeRTCPeerConnection.latest;
      // Exactly one channel, however many concurrent senders there are: a
      // second would be an SCTP stream the SFU closes as unrecognised.
      expect(pc.dataChannels).toHaveLength(1);
      expect(pc.dataChannels[0].sent).toHaveLength(0);

      socket.receive({ type: 'sdp.answer', sdp: 'v=0 fake-server-answer' });
      await Promise.all(sends);

      const decoded = pc.dataChannels[0].sent.map((payload) => new TextDecoder().decode(payload as Uint8Array));
      expect(decoded).toEqual(['one', 'two', 'three']);
    });

    it('sends straight away once the channel is open', async () => {
      const { adapter, socket } = await connectAdapter();
      const first = adapter.sendData(new TextEncoder().encode('first') as Uint8Array<ArrayBuffer>);
      await flush();
      socket.receive({ type: 'sdp.answer', sdp: 'v=0 fake-server-answer' });
      await first;

      const pc = FakeRTCPeerConnection.latest;
      const offersBefore = socket.sentMessages().filter((message) => message.type === 'sdp.offer').length;

      await adapter.sendData(new TextEncoder().encode('second') as Uint8Array<ArrayBuffer>);

      expect(pc.dataChannels).toHaveLength(1);
      expect(pc.dataChannels[0].sent).toHaveLength(2);
      // No renegotiation for a channel that already exists.
      expect(socket.sentMessages().filter((message) => message.type === 'sdp.offer')).toHaveLength(offersBefore);
    });

    it('opens a channel for a participant that only listens for data', async () => {
      // The SFU fans data out over each recipient's own channel, so a
      // participant with no channel cannot receive. Nothing in this test
      // ever sends.
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      adapter.ensureDataChannel();
      await flush();

      const pc = FakeRTCPeerConnection.latest;
      expect(pc.dataChannels).toHaveLength(1);
      expect(socket.lastSent('sdp.offer')).toBeDefined();

      // Idempotent: a page with three `dataReceived` listeners still has
      // one channel.
      adapter.ensureDataChannel();
      adapter.ensureDataChannel();
      await flush();
      expect(pc.dataChannels).toHaveLength(1);
    });

    it('rejects rather than hanging when the connection dies before the channel opens', async () => {
      // Waiting internally must not turn a dead connection into a promise
      // that never settles.
      const { adapter, socket } = await connectAdapter({ autoReconnect: false });
      const sending = adapter.sendData(new TextEncoder().encode('hello') as Uint8Array<ArrayBuffer>);
      await flush();

      socket.close(1006);

      await expect(sending).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    });

    it('works after media has already been published', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      await adapter.enableCamera(true);
      await settleNegotiation(socket, pc);

      const sending = adapter.sendData(new TextEncoder().encode('with-media') as Uint8Array<ArrayBuffer>);
      await settleNegotiation(socket, pc);
      await sending;

      expect(pc.dataChannels).toHaveLength(1);
      expect(pc.dataChannels[0].sent).toHaveLength(1);
      expect(pc.activeSenders('video')).toHaveLength(1);
    });
  });

  describe('restoring local media after a reconnect', () => {
    /** Drops the socket and completes the rejoin the SDK does on its own. */
    async function reconnect(
      socket: FakeWebSocket,
      participants: { id: string; tracks?: unknown[] }[] = [],
    ): Promise<{ socket: FakeWebSocket; pc: FakeRTCPeerConnection }> {
      const before = FakeWebSocket.instances.length;
      socket.close(1006);
      await flush();
      const next = await waitForNewSocket(before);
      next.receive({
        type: 'room.joined',
        roomId: 'room-1',
        participants,
        rtcServer: 'sfu-local-01',
        region: 'local',
      });
      await flush();
      return { socket: next, pc: FakeRTCPeerConnection.latest };
    }

    it('re-publishes the microphone and camera onto the replacement connection', async () => {
      // The reported failure: signaling and ICE recovered, the new
      // connection had no senders at all, and the room went quiet while
      // the SDK still reported both tracks published.
      const { adapter, socket } = await connectAdapter({ autoReconnect: true });
      const first = await receiveOffer(socket);

      await adapter.enableMicrophone(true);
      await adapter.enableCamera(true);
      await settleNegotiation(socket, first);
      expect(first.activeSenders('audio')).toHaveLength(1);
      expect(first.activeSenders('video')).toHaveLength(1);

      const { socket: rejoined, pc: replacement } = await reconnect(socket);

      expect(first.closed).toBe(true);
      expect(replacement).not.toBe(first);
      expect(replacement.activeSenders('audio')).toHaveLength(1);
      expect(replacement.activeSenders('video')).toHaveLength(1);

      // The new SFU session has never heard of these tracks, so their
      // sources are declared again.
      const declared = rejoined
        .sentMessages()
        .filter((message) => message.type === 'track.publish')
        .map((message) => message.source);
      expect(declared).toEqual(expect.arrayContaining(['microphone', 'camera']));

      // And it renegotiates, so the m-sections actually exist.
      expect(rejoined.lastSent('sdp.offer')).toBeDefined();
      await settleNegotiation(rejoined, replacement);
      for (const transceiver of replacement.getTransceivers()) {
        expect(transceiver.currentDirection).toBe('sendrecv');
      }
    });

    it('restores a screen share whose source is still live', async () => {
      const { adapter, socket } = await connectAdapter({ autoReconnect: true });
      const first = await receiveOffer(socket);
      await adapter.enableScreenShare(true);
      await settleNegotiation(socket, first);

      const { socket: rejoined, pc: replacement } = await reconnect(socket);

      expect(replacement.activeSenders('video')).toHaveLength(1);
      expect(
        rejoined
          .sentMessages()
          .filter((message) => message.type === 'track.publish')
          .map((m) => m.source),
      ).toContain('screenShare');
    });

    it('drops a screen share the user stopped while disconnected', async () => {
      // Ending a share is the user's own doing, through browser UI Swalvo
      // never sees. Restoring the dead track would publish an m-section
      // that never carries a frame.
      const { adapter, socket } = await connectAdapter({ autoReconnect: true });
      const first = await receiveOffer(socket);
      const share = await adapter.enableScreenShare(true);
      await settleNegotiation(socket, first);

      const unpublished: TrackKind[] = [];
      adapter.on('localTrackUnpublished', (track) => unpublished.push(track.kind));

      // Stops during the outage, so no unpublish round trip happens.
      const before = FakeWebSocket.instances.length;
      const connectionsBefore = FakeRTCPeerConnection.instances.length;
      socket.close(1006);
      await flush();
      (share!.mediaStreamTrack as unknown as FakeMediaStreamTrack).stop();

      const rejoined = await waitForNewSocket(before);
      rejoined.receive({
        type: 'room.joined',
        roomId: 'room-1',
        participants: [],
        rtcServer: 'sfu-local-01',
        region: 'local',
      });
      await flush();

      expect(unpublished).toEqual(['screenShare']);
      expect(adapter.localParticipant.tracks).toHaveLength(0);
      // Nothing left to publish, so no replacement connection was built
      // and nothing was re-declared to the new session.
      expect(FakeRTCPeerConnection.instances).toHaveLength(connectionsBefore);
      expect(rejoined.lastSent('track.publish')).toBeUndefined();
    });

    it('does not add a second sender when the server re-sends room state', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      await adapter.enableCamera(true);
      await settleNegotiation(socket, pc);

      // Same connection, room state again. Restoring must be idempotent.
      socket.receive({
        type: 'room.joined',
        roomId: 'room-1',
        participants: [],
        rtcServer: 'sfu-local-01',
        region: 'local',
      });
      await flush();

      expect(pc.activeSenders('video')).toHaveLength(1);
      expect(pc.addedTracks).toHaveLength(1);
    });

    it('reopens the data channel on the replacement connection', async () => {
      const { adapter, socket } = await connectAdapter({ autoReconnect: true });
      const first = adapter.sendData(new TextEncoder().encode('before') as Uint8Array<ArrayBuffer>);
      await flush();
      socket.receive({ type: 'sdp.answer', sdp: 'v=0 fake-server-answer' });
      await first;

      const before = FakeWebSocket.instances.length;
      socket.close(1006);
      await flush();
      const rejoined = await waitForNewSocket(before);
      rejoined.receive({
        type: 'room.joined',
        roomId: 'room-1',
        participants: [],
        rtcServer: 'sfu-local-01',
        region: 'local',
      });
      await flush();

      const replacement = FakeRTCPeerConnection.latest;
      expect(replacement.dataChannels).toHaveLength(1);

      // The replacement channel needs its own round trip, exactly like the
      // first one did.
      await settleNegotiation(rejoined, replacement);
      await adapter.sendData(new TextEncoder().encode('after') as Uint8Array<ArrayBuffer>);
      expect(replacement.dataChannels[0].readyState).toBe('open');
      expect(replacement.dataChannels[0].sent).toHaveLength(1);
    });
  });

  describe('connection quality', () => {
    it('reports unknown rather than inventing a verdict', async () => {
      // The SFU has the vantage point no client can get, and doesn't
      // compute this yet. A client-side guess dressed up as a server
      // verdict is precisely the fabricated metric spec §19 forbids.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      pc.setConnectionState('connected');

      expect(adapter.getConnectionQuality()).toBe('unknown');
    });

    it('reports lost when the SFU says the connection failed', async () => {
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      socket.receive({ type: 'connection.state', iceState: 'failed', peerState: 'failed' });
      await flush();

      expect(adapter.getConnectionQuality()).toBe('lost');
    });

    it('exposes ICE and signaling state, which the previous adapter could not', async () => {
      // `Room.getDiagnostics()` reported these as undefined for as long as
      // LiveKit owned the connection. Swalvo's own adapter has the peer
      // connection right there. These are the states that actually explain
      // a failed connection in a bug report.
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      pc.iceConnectionState = 'checking';

      expect(adapter.getIceConnectionState()).toBe('checking');
      expect(adapter.getSignalingState()).toBe('stable');
    });

    it('reports nothing rather than guessing before a connection exists', async () => {
      const adapter = new SwalvoAdapter(createLogger('silent'), false);

      expect(adapter.getIceConnectionState()).toBeUndefined();
      expect(adapter.getSignalingState()).toBeUndefined();
      expect(adapter.getRemoteConnectionState()).toEqual({
        iceState: undefined,
        peerState: undefined,
      });
    });

    it("surfaces the SFU's view alongside the local one", async () => {
      // The two can disagree, and the disagreement is the useful bit.
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      socket.receive({ type: 'connection.state', iceState: 'connected', peerState: 'connected' });
      await flush();

      expect(adapter.getRemoteConnectionState()).toEqual({
        iceState: 'connected',
        peerState: 'connected',
      });
    });
  });

  describe('disconnecting', () => {
    it('stops local media, leaves the room, and closes the connection', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      const track = await adapter.enableCamera(true);
      await flush();

      await adapter.disconnect();

      expect((track!.mediaStreamTrack as unknown as FakeMediaStreamTrack).stopped).toBe(true);
      expect(socket.lastSent('room.leave')).toBeDefined();
      expect(pc.closed).toBe(true);
      expect(adapter.connectionState).toBe('disconnected');
      expect(adapter.localParticipant.tracks).toHaveLength(0);
      expect(adapter.remoteParticipants.size).toBe(0);
    });

    it('does not report a failure for a deliberate disconnect', async () => {
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      const states: string[] = [];
      adapter.on('connectionStateChanged', (state) => states.push(state));

      await adapter.disconnect();
      await flush();

      expect(states).not.toContain('failed');
      expect(states.at(-1)).toBe('disconnected');
    });
  });

  describe('reconnection', () => {
    it('tears down the old PeerConnection when reconnecting', async () => {
      // The server allocates a fresh session on rejoin, so the old
      // connection is no use to anyone. Leave it open and a caller can
      // find a connection that looks alive and forwards nothing.
      const { adapter, socket } = await connectAdapter({ autoReconnect: true });
      const pc = await receiveOffer(socket);
      pc.setConnectionState('connected');

      socket.close(1006);
      await flush();

      expect(pc.closed).toBe(true);
      expect(adapter.connectionState).toBe('reconnecting');
    });

    it('fails immediately when autoReconnect is off', async () => {
      const { adapter, socket } = await connectAdapter({ autoReconnect: false });
      const pc = await receiveOffer(socket);
      pc.setConnectionState('connected');

      const failures: RTCError[] = [];
      adapter.on('connectionStateChanged', (state) => {
        if (state === 'failed') failures.push(new RTCError('CONNECTION_FAILED', state));
      });

      socket.close(1006);
      await flush();

      expect(adapter.connectionState).toBe('failed');
    });
  });
});
