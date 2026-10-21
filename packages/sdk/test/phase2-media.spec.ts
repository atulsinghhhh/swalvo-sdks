import { SwalvoAdapter } from '../src/internal/sfu/swalvo-adapter';
import { createLogger } from '../src/logger';
import type { Participant, RemoteParticipant } from '../src/participant';
import type { RemoteTrack } from '../src/track';
import { Room } from '../src/room';
import { FakeAdapter } from './helpers/fake-adapter';
import {
  FakeMediaStreamTrack,
  FakeRTCPeerConnection,
  FakeWebSocket,
  fakeToken,
  flush,
  installFakeMediaDevices,
  installFakeWebRTC,
} from './helpers/fake-webrtc';

/**
 * Phase 2 media-quality signals, client side
 * (docs/architecture/phase2-media-contracts.md §2–§5).
 *
 * Everything here is driven from the wire: a frame shaped exactly like the
 * contract goes in, and the assertions are on what an application can see
 * (participant fields, room events, track state) or on what goes back out
 * (`subscription.update`, `setParameters`). Nothing asserts on internals.
 */

const ENDPOINT = 'ws://localhost:4000/v1/rtc';

const TOKEN = fakeToken({
  sub: 'alice',
  rid: 'room-1',
  rnm: 'demo-room',
  perms: { join: true, subscribe: true, publish: true, publishAudio: true, publishVideo: true, publishData: true },
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
});

const connected: SwalvoAdapter[] = [];

async function connectAdapter(
  options: {
    participants?: { id: string; tracks?: unknown[] }[];
    adaptiveStream?: boolean;
    autoSubscribe?: boolean;
  } = {},
): Promise<{ adapter: SwalvoAdapter; socket: FakeWebSocket }> {
  const adapter = new SwalvoAdapter(createLogger('silent'), false, {
    adaptiveStream: options.adaptiveStream ?? true,
    autoSubscribe: options.autoSubscribe,
  });
  const connecting = adapter.connect(ENDPOINT, TOKEN, []);
  await flush();
  const socket = FakeWebSocket.latest;
  socket.receive({ type: 'room.joined', roomId: 'room-1', participants: options.participants ?? [] });
  await connecting;
  connected.push(adapter);
  return { adapter, socket };
}

async function receiveOffer(socket: FakeWebSocket): Promise<FakeRTCPeerConnection> {
  socket.receive({ type: 'sdp.offer', sdp: 'v=0 fake-server-offer' });
  await flush();
  return FakeRTCPeerConnection.latest;
}

/** Bob, publishing a simulcast camera, subscribed. */
async function withBobsCamera(options: { adaptiveStream?: boolean; autoSubscribe?: boolean } = {}) {
  const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }], ...options });
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
  const bob = adapter.remoteParticipants.get('bob') as RemoteParticipant;
  return { adapter, socket, pc, track, bob };
}

const layersSent = (socket: FakeWebSocket) =>
  socket
    .sentMessages()
    .filter((message) => message.type === 'subscription.update')
    .map((message) => message.layer);

describe('Phase 2 media signals', () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = installFakeWebRTC();
    installFakeMediaDevices();
  });

  afterEach(async () => {
    jest.useRealTimers();
    while (connected.length > 0) {
      await connected.pop()?.disconnect();
    }
    teardown();
  });

  describe('active speakers (§2)', () => {
    it('marks speakers, local included, loudest first', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }, { id: 'carol' }] });
      const changes: Participant[][] = [];
      adapter.on('activeSpeakersChanged', (speakers) => changes.push(speakers));

      socket.receive({
        type: 'speakers.changed',
        speakers: [
          { participantId: 'bob', level: 0.82 },
          { participantId: 'alice', level: 0.4 },
        ],
      });

      const bob = adapter.remoteParticipants.get('bob')!;
      const carol = adapter.remoteParticipants.get('carol')!;
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual([bob, adapter.localParticipant]);
      expect(bob.isSpeaking).toBe(true);
      expect(bob.audioLevel).toBeCloseTo(0.82);
      expect(adapter.localParticipant.isSpeaking).toBe(true);
      expect(carol.isSpeaking).toBe(false);
      expect(adapter.activeSpeakers).toEqual([bob, adapter.localParticipant]);
    });

    it('fires isSpeakingChanged only on transitions, and clears on an empty list', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const bob = adapter.remoteParticipants.get('bob')!;
      const transitions: boolean[] = [];
      bob.on('isSpeakingChanged', (speaking) => transitions.push(speaking));

      socket.receive({ type: 'speakers.changed', speakers: [{ participantId: 'bob', level: 0.5 }] });
      socket.receive({ type: 'speakers.changed', speakers: [{ participantId: 'bob', level: 0.9 }] });
      expect(bob.audioLevel).toBeCloseTo(0.9);
      socket.receive({ type: 'speakers.changed', speakers: [] });

      expect(transitions).toEqual([true, false]);
      expect(bob.isSpeaking).toBe(false);
      expect(bob.audioLevel).toBe(0);
      expect(adapter.activeSpeakers).toEqual([]);
    });

    it('does not re-announce an unchanged speaker set', async () => {
      // A level-only change is still a frame on the wire; the set is what
      // the room event is about.
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const changed = jest.fn();
      adapter.on('activeSpeakersChanged', changed);

      socket.receive({ type: 'speakers.changed', speakers: [{ participantId: 'bob', level: 0.5 }] });
      socket.receive({ type: 'speakers.changed', speakers: [{ participantId: 'bob', level: 0.6 }] });

      expect(changed).toHaveBeenCalledTimes(1);
    });

    it('skips ids it does not know and clamps levels', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      socket.receive({
        type: 'speakers.changed',
        speakers: [{ participantId: 'ghost', level: 1 }, { participantId: 'bob', level: 7 }, { nonsense: true }],
      });
      expect(adapter.activeSpeakers.map((participant) => participant.identity)).toEqual(['bob']);
      expect(adapter.remoteParticipants.get('bob')!.audioLevel).toBe(1);
    });

    it('drops a participant who leaves mid-sentence', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      socket.receive({ type: 'speakers.changed', speakers: [{ participantId: 'bob', level: 0.5 }] });
      const changes: Participant[][] = [];
      adapter.on('activeSpeakersChanged', (speakers) => changes.push(speakers));

      socket.receive({ type: 'participant.left', participant: { id: 'bob' } });

      expect(changes).toEqual([[]]);
      expect(adapter.activeSpeakers).toEqual([]);
    });
  });

  describe('connection quality (§3)', () => {
    it('scores remote participants and this one, and reports our own as the connection quality', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const seen: Array<[string, string]> = [];
      adapter.on('connectionQualityChanged', (participant, quality) => seen.push([participant.identity, quality]));
      const bob = adapter.remoteParticipants.get('bob')!;
      const bobs: string[] = [];
      bob.on('connectionQualityChanged', (quality) => bobs.push(quality));

      expect(adapter.getConnectionQuality()).toBe('unknown');

      socket.receive({
        type: 'quality.changed',
        updates: [
          { participantId: 'bob', quality: 'poor' },
          { participantId: 'alice', quality: 'excellent' },
        ],
      });

      expect(seen).toEqual([
        ['bob', 'poor'],
        ['alice', 'excellent'],
      ]);
      expect(bobs).toEqual(['poor']);
      expect(bob.connectionQuality).toBe('poor');
      expect(adapter.localParticipant.connectionQuality).toBe('excellent');
      expect(adapter.getConnectionQuality()).toBe('excellent');
    });

    it('ignores scores it does not recognise and repeats of the current one', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const seen = jest.fn();
      adapter.on('connectionQualityChanged', seen);

      socket.receive({ type: 'quality.changed', updates: [{ participantId: 'bob', quality: 'superb' }] });
      socket.receive({ type: 'quality.changed', updates: [{ participantId: 'bob', quality: 'good' }] });
      socket.receive({ type: 'quality.changed', updates: [{ participantId: 'bob', quality: 'good' }] });

      expect(seen).toHaveBeenCalledTimes(1);
    });

    it('still says lost when the connection has failed, whatever the last score was', async () => {
      const { adapter, socket } = await connectAdapter();
      socket.receive({ type: 'quality.changed', updates: [{ participantId: 'alice', quality: 'good' }] });
      socket.receive({ type: 'connection.state', iceState: 'failed', peerState: 'failed' });
      expect(adapter.getConnectionQuality()).toBe('lost');
    });

    it('forgets the score on leave', async () => {
      const { adapter, socket } = await connectAdapter();
      socket.receive({ type: 'quality.changed', updates: [{ participantId: 'alice', quality: 'good' }] });
      await adapter.disconnect();
      expect(adapter.localParticipant.connectionQuality).toBe('unknown');
    });
  });

  describe('subscription state (§4)', () => {
    it('applies the state and layer the SFU reports, and says so', async () => {
      const { adapter, socket, track, bob } = await withBobsCamera();
      const seen: Array<[RemoteTrack, RemoteParticipant]> = [];
      adapter.on('trackSubscriptionStateChanged', (t, p) => seen.push([t, p]));

      expect(track.subscriptionState).toBe('active');
      expect(track.layer).toBeUndefined();

      socket.receive({
        type: 'subscription.state',
        publisherId: 'bob',
        trackId: 'bob-cam',
        state: 'paused_bandwidth',
        layer: 'off',
      });

      expect(track.subscriptionState).toBe('paused_bandwidth');
      expect(track.layer).toBe('off');
      expect(seen).toEqual([[track, bob]]);

      // A repeat is not a change.
      socket.receive({
        type: 'subscription.state',
        publisherId: 'bob',
        trackId: 'bob-cam',
        state: 'paused_bandwidth',
        layer: 'off',
      });
      expect(seen).toHaveLength(1);
    });

    it('keeps a report that arrives before its track', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(socket);
      socket.receive({
        type: 'subscription.state',
        publisherId: 'bob',
        trackId: 'bob-cam',
        state: 'active',
        layer: 'medium',
      });
      let track: RemoteTrack | undefined;
      adapter.on('trackSubscribed', (subscribed: RemoteTrack) => {
        track = subscribed;
      });
      socket.receive({
        type: 'track.published',
        participantId: 'bob',
        track: { trackId: 'bob-cam', kind: 'video', source: 'camera', muted: false, simulcast: true },
      });
      pc.emitTrack(new FakeMediaStreamTrack('video', 'bob-cam'));
      await flush();

      expect(track?.layer).toBe('medium');
    });

    it('ignores a state it does not recognise', async () => {
      const { socket, track } = await withBobsCamera();
      socket.receive({ type: 'subscription.state', publisherId: 'bob', trackId: 'bob-cam', state: 'sleeping' });
      expect(track.subscriptionState).toBe('active');
    });
  });

  describe('autoSubscribe (§4)', () => {
    it('leaves the join untouched by default', async () => {
      const { socket } = await connectAdapter();
      expect(socket.lastSent('room.join')).not.toHaveProperty('autoSubscribe');
    });

    it('asks for paused video subscriptions when false, and starts them paused', async () => {
      const { socket, track } = await withBobsCamera({ autoSubscribe: false });
      expect(socket.lastSent('room.join')).toMatchObject({ autoSubscribe: false });
      expect(track.subscriptionState).toBe('paused_client');
      // Nothing has asked for it yet, so nothing is sent.
      expect(layersSent(socket)).toEqual([]);
    });

    it('resumes a paused-by-default video on setEnabled(true)', async () => {
      const { socket, track } = await withBobsCamera({ autoSubscribe: false, adaptiveStream: false });
      track.setEnabled(true);
      expect(layersSent(socket)).toEqual(['auto']);
    });

    it('resumes one on the first adaptive size, which is the usual path', async () => {
      const { adapter, socket, track } = await withBobsCamera({ autoSubscribe: false });
      adapter.requestLayer(track, 'low', { automatic: true });
      expect(layersSent(socket)).toEqual(['low']);
    });
  });

  describe('layer precedence with pauses (§4 layer off)', () => {
    it('setEnabled(false) pauses, and nothing automatic undoes it', async () => {
      const { adapter, socket, track } = await withBobsCamera();
      track.setEnabled(false);
      adapter.requestLayer(track, 'high', { automatic: true });
      track.setVisible(true);

      expect(track.isEnabled).toBe(false);
      expect(layersSent(socket)).toEqual(['off']);
    });

    it('setEnabled(false) wins over a pin too, and setEnabled(true) restores the pin', async () => {
      const { socket, track } = await withBobsCamera();
      track.setLayer('high');
      track.setEnabled(false);
      track.setLayer('low');
      track.setEnabled(true);

      expect(layersSent(socket)).toEqual(['high', 'off', 'low']);
    });

    it('setEnabled(true) restores the size adaptive streaming chose', async () => {
      const { adapter, socket, track } = await withBobsCamera();
      adapter.requestLayer(track, 'medium', { automatic: true });
      track.setEnabled(false);
      track.setEnabled(true);

      expect(layersSent(socket)).toEqual(['medium', 'off', 'medium']);
    });

    it('pauses a hidden track after the delay and resumes it at once', async () => {
      const { adapter, socket, track } = await withBobsCamera();
      adapter.requestLayer(track, 'medium', { automatic: true });
      jest.useFakeTimers();

      track.setVisible(false);
      jest.advanceTimersByTime(499);
      expect(layersSent(socket)).toEqual(['medium']);
      jest.advanceTimersByTime(1);
      expect(layersSent(socket)).toEqual(['medium', 'off']);

      track.setVisible(true);
      expect(layersSent(socket)).toEqual(['medium', 'off', 'medium']);
    });

    it('does not pause a track that comes back before the delay runs out', async () => {
      const { adapter, socket, track } = await withBobsCamera();
      adapter.requestLayer(track, 'medium', { automatic: true });
      jest.useFakeTimers();

      track.setVisible(false);
      jest.advanceTimersByTime(300);
      track.setVisible(true);
      jest.advanceTimersByTime(1_000);

      expect(layersSent(socket)).toEqual(['medium']);
    });

    it('does not second-guess a pinned layer when hidden', async () => {
      const { socket, track } = await withBobsCamera();
      track.setLayer('high');
      jest.useFakeTimers();
      track.setVisible(false);
      jest.advanceTimersByTime(1_000);

      expect(layersSent(socket)).toEqual(['high']);
    });

    it('ignores visibility with adaptiveStream off', async () => {
      const { socket, track } = await withBobsCamera({ adaptiveStream: false });
      jest.useFakeTimers();
      track.setVisible(false);
      jest.advanceTimersByTime(1_000);

      expect(layersSent(socket)).toEqual([]);
    });

    it('is a no-op on audio, which the SFU always forwards', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(socket);
      let track: RemoteTrack | undefined;
      adapter.on('trackSubscribed', (subscribed: RemoteTrack) => {
        track = subscribed;
      });
      socket.receive({
        type: 'track.published',
        participantId: 'bob',
        track: { trackId: 'bob-mic', kind: 'audio', source: 'microphone', muted: false, simulcast: false },
      });
      pc.emitTrack(new FakeMediaStreamTrack('audio', 'bob-mic'));
      await flush();

      track?.setEnabled(false);
      expect(track?.isEnabled).toBe(true);
      expect(layersSent(socket)).toEqual([]);
    });
  });

  describe('publisher.layers (§5)', () => {
    async function publishingCamera() {
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);
      const camera = await adapter.enableCamera(true);
      await flush();
      const pc = FakeRTCPeerConnection.latest;
      const sender = pc.senders.find((candidate) => candidate.track?.kind === 'video')!;
      return { adapter, socket, pc, sender, trackId: camera!.mediaStreamTrack.id };
    }

    const activity = (sender: { getParameters(): RTCRtpSendParameters }) =>
      sender.getParameters().encodings.map((encoding) => [encoding.rid, encoding.active ?? true]);

    it('switches off the encodings nobody receives', async () => {
      const { socket, sender, trackId } = await publishingCamera();

      socket.receive({
        type: 'publisher.layers',
        trackId,
        layers: [
          { rid: 'low', active: true },
          { rid: 'medium', active: false },
          { rid: 'high', active: false },
        ],
      });
      await flush();

      expect(sender.setParametersCalls).toHaveLength(1);
      expect(activity(sender)).toEqual([
        ['low', true],
        ['medium', false],
        ['high', false],
      ]);
    });

    it('understands the q/h/f spelling of the same rungs', async () => {
      const { socket, sender, trackId } = await publishingCamera();
      socket.receive({
        type: 'publisher.layers',
        trackId,
        layers: [
          { rid: 'q', active: false },
          { rid: 'h', active: true },
          { rid: 'f', active: false },
        ],
      });
      await flush();

      expect(activity(sender)).toEqual([
        ['low', false],
        ['medium', true],
        ['high', false],
      ]);
    });

    it('costs no reconfiguration when nothing changes', async () => {
      const { socket, sender, trackId } = await publishingCamera();
      const frame = {
        type: 'publisher.layers',
        trackId,
        layers: [
          { rid: 'low', active: true },
          { rid: 'medium', active: true },
          { rid: 'high', active: true },
        ],
      };
      socket.receive(frame);
      await flush();
      expect(sender.setParametersCalls).toHaveLength(0);
    });

    it('applies back-to-back frames in order, ending on the last', async () => {
      const { socket, sender, trackId } = await publishingCamera();
      socket.receive({ type: 'publisher.layers', trackId, layers: [{ rid: 'high', active: false }] });
      socket.receive({
        type: 'publisher.layers',
        trackId,
        layers: [
          { rid: 'high', active: true },
          { rid: 'low', active: false },
        ],
      });
      await flush();

      expect(sender.setParametersCalls).toHaveLength(2);
      expect(activity(sender)).toEqual([
        ['low', false],
        ['medium', true],
        ['high', true],
      ]);
    });

    it('re-applies the demand after a negotiation round put the encodings back', async () => {
      const { socket, sender, trackId } = await publishingCamera();
      socket.receive({ type: 'publisher.layers', trackId, layers: [{ rid: 'high', active: false }] });
      await flush();
      // An engine that resets encodings when a description is applied.
      for (const encoding of sender.getParameters().encodings) encoding.active = true;

      socket.receive({ type: 'sdp.answer', sdp: 'v=0 answer' });
      await flush();

      expect(activity(sender)).toEqual([
        ['low', true],
        ['medium', true],
        ['high', false],
      ]);
    });

    it('ignores a frame for a track it does not publish', async () => {
      const { socket, sender } = await publishingCamera();
      socket.receive({ type: 'publisher.layers', trackId: 'not-mine', layers: [{ rid: 'high', active: false }] });
      await flush();
      expect(sender.setParametersCalls).toHaveLength(0);
    });
  });
});

describe('Room — Phase 2 events', () => {
  const logger = createLogger('silent');

  it('forwards speakers, quality and subscription-state events', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    const speakers = jest.fn();
    const quality = jest.fn();
    const subscription = jest.fn();
    room.on('activeSpeakersChanged', speakers);
    room.on('connectionQualityChanged', quality);
    room.on('trackSubscriptionStateChanged', subscription);

    const participant = adapter.localParticipant;
    adapter.fire('activeSpeakersChanged', [participant]);
    adapter.fire('connectionQualityChanged', participant, 'good');

    expect(speakers).toHaveBeenCalledWith([participant]);
    expect(quality).toHaveBeenCalledWith(participant, 'good');
    expect(subscription).not.toHaveBeenCalled();
  });

  it('reports nobody speaking from an adapter that predates speaker detection', () => {
    const room = new Room(new FakeAdapter(), 'room-1', logger);
    expect(room.activeSpeakers).toEqual([]);
  });
});
