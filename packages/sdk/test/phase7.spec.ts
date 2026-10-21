import { SwalvoAdapter } from '../src/internal/sfu/swalvo-adapter';
import type { Logger } from '../src/logger';
import type { Participant, ParticipantMetadataSnapshot, RemoteParticipant } from '../src/participant';
import type { RemoteTrack } from '../src/track';
import { Room } from '../src/room';
import {
  FakeMediaStream,
  FakeMediaStreamTrack,
  FakeRTCDataChannel,
  FakeRTCPeerConnection,
  FakeWebSocket,
  fakeToken,
  flush,
  installFakeMediaDevices,
  installFakeWebRTC,
} from './helpers/fake-webrtc';

/**
 * Phase 7, client side (docs/architecture/phase7-contracts.md): data
 * messages v2 (§1), participant metadata and attributes (§2) and
 * screen-share audio (§3). Driven from the wire, like phase2-media.spec.ts.
 */

const ENDPOINT = 'ws://localhost:4000/v1/rtc';
const PERMS = { join: true, subscribe: true, publish: true, publishAudio: true, publishVideo: true, publishData: true };

function token(extra: Record<string, unknown> = {}, perms: Record<string, unknown> = {}): string {
  return fakeToken({
    sub: 'alice',
    rid: 'room-1',
    perms: { ...PERMS, ...perms },
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...extra,
  });
}

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    error: () => undefined,
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    info: () => undefined,
    debug: () => undefined,
  };
}

const connected: SwalvoAdapter[] = [];

async function connectAdapter(
  options: {
    capabilities?: string[];
    participants?: Record<string, unknown>[];
    token?: string;
    logger?: Logger;
  } = {},
): Promise<{ adapter: SwalvoAdapter; socket: FakeWebSocket }> {
  const adapter = new SwalvoAdapter(options.logger ?? recordingLogger(), false, { adaptiveStream: false });
  const connecting = adapter.connect(ENDPOINT, options.token ?? token(), []);
  await flush();
  const socket = FakeWebSocket.latest;
  socket.receive({
    type: 'room.joined',
    roomId: 'room-1',
    participants: options.participants ?? [],
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  });
  await connecting;
  connected.push(adapter);
  return { adapter, socket };
}

async function receiveOffer(socket: FakeWebSocket): Promise<FakeRTCPeerConnection> {
  socket.receive({ type: 'sdp.offer', sdp: 'v=0 fake-server-offer' });
  await flush();
  return FakeRTCPeerConnection.latest;
}

const encode = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
const hex = (value: unknown) => Buffer.from(value as Uint8Array).toString('hex');
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex')).buffer as ArrayBuffer;
const channel = (pc: FakeRTCPeerConnection, label: string) =>
  pc.dataChannels.find((candidate) => candidate.label === label);

/** Sends, completes the round trip that opens the channel(s), and waits. */
async function sendAndOpen(socket: FakeWebSocket, sending: Promise<void>): Promise<void> {
  await flush();
  socket.receive({ type: 'sdp.answer', sdp: 'v=0 fake-server-answer' });
  await sending;
  await flush();
}

describe('Phase 7', () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = installFakeWebRTC();
    installFakeMediaDevices();
  });

  afterEach(async () => {
    while (connected.length > 0) {
      await connected.pop()?.disconnect();
    }
    teardown();
  });

  describe('sendData (§1)', () => {
    it('sends exactly the legacy bytes without options or capability', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      await sendAndOpen(socket, adapter.sendData(encode('hello')));

      expect(pc.dataChannels.map((c) => c.label)).toEqual(['raven-data']);
      expect(hex(channel(pc, 'raven-data')!.sent[0])).toBe(Buffer.from('hello').toString('hex'));
    });

    it('wraps every message in a v2 envelope once the room announces data.v2', async () => {
      const { adapter, socket } = await connectAdapter({ capabilities: ['data.v2'] });
      expect(adapter.dataV2Supported).toBe(true);
      const pc = await receiveOffer(socket);

      await sendAndOpen(socket, adapter.sendData(encode('hello')));

      expect(hex(channel(pc, 'raven-data')!.sent[0])).toBe('520200000068656c6c6f');
    });

    it('uses an envelope when a topic or destinations are given, even without the capability', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);

      await sendAndOpen(
        socket,
        adapter.sendData(encode('hello'), { topic: 'cursor', destinationIdentities: ['alice'] }),
      );

      expect(hex(channel(pc, 'raven-data')!.sent[0])).toBe('52020006637572736f720105616c69636568656c6c6f');
    });

    it('sends reliable:false on an unordered, no-retransmit raven-data-lossy channel', async () => {
      const { adapter, socket } = await connectAdapter({ capabilities: ['data.v2'] });
      const pc = await receiveOffer(socket);

      await adapter.sendData(encode('x'), { reliable: false, topic: 'cursor' });
      const lossy = channel(pc, 'raven-data-lossy')!;
      expect(lossy).toBeDefined();
      expect(lossy.init).toEqual({ ordered: false, maxRetransmits: 0, protocol: 'raven.v2' });
      // Opened eagerly at join, so it is already up by the time we send.
      expect(lossy.sent.map(hex)).toEqual(['52020006637572736f720078']);
    });

    it('opens both channels with protocol raven.v2 right after a v2 join', async () => {
      await connectAdapter({ capabilities: ['data.v2'] });
      const pc = FakeRTCPeerConnection.latest;

      expect(channel(pc, 'raven-data')!.init).toEqual({ ordered: true, protocol: 'raven.v2' });
      expect(channel(pc, 'raven-data-lossy')!.init).toEqual({
        ordered: false,
        maxRetransmits: 0,
        protocol: 'raven.v2',
      });
      expect(pc.dataChannels).toHaveLength(2);
    });

    it('keeps the channels lazy without the capability, and still marks raven-data as raven.v2', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      expect(pc.dataChannels).toHaveLength(0);

      await sendAndOpen(socket, adapter.sendData(encode('hi')));
      expect(pc.dataChannels.map((c) => [c.label, c.init])).toEqual([
        ['raven-data', { ordered: true, protocol: 'raven.v2' }],
      ]);
      expect(hex(channel(pc, 'raven-data')!.sent[0])).toBe('6869');
    });

    describe('without publishData (a live-stream viewer)', () => {
      const VIEWER = { publish: false, publishAudio: false, publishVideo: false, publishData: false };
      const clientOffers = (socket: FakeWebSocket) =>
        socket.sent.map((raw) => JSON.parse(raw) as { type: string }).filter((m) => m.type === 'sdp.offer');

      it('opens no data channel at a v2 join, so it never sends an offer the API would refuse', async () => {
        const { socket } = await connectAdapter({ capabilities: ['data.v2'], token: token({}, VIEWER) });
        const pc = await receiveOffer(socket);
        await flush();

        expect(pc.dataChannels).toHaveLength(0);
        expect(clientOffers(socket)).toHaveLength(0);
      });

      it('remembers a dataReceived listener without opening a channel', async () => {
        const { adapter, socket } = await connectAdapter({ capabilities: ['data.v2'], token: token({}, VIEWER) });
        const pc = await receiveOffer(socket);
        adapter.ensureDataChannel();
        await flush();

        expect(pc.dataChannels).toHaveLength(0);
        expect(clientOffers(socket)).toHaveLength(0);
      });

      it('rejects sendData up front with PERMISSION_DENIED', async () => {
        const { adapter, socket } = await connectAdapter({ capabilities: ['data.v2'], token: token({}, VIEWER) });
        const pc = await receiveOffer(socket);

        await expect(adapter.sendData(encode('hi'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        expect(pc.dataChannels).toHaveLength(0);
      });

      it('opens both channels once the server grants publishData mid-session', async () => {
        const { socket } = await connectAdapter({ capabilities: ['data.v2'], token: token({}, VIEWER) });
        const pc = await receiveOffer(socket);
        socket.receive({
          type: 'participant.permissions_updated',
          permissions: { ...VIEWER, subscribe: true, publishData: true },
        });
        await flush();

        expect(pc.dataChannels.map((c) => c.label).sort()).toEqual(['raven-data', 'raven-data-lossy']);
      });
    });

    it('re-opens both channels on a new connection after a v2 rejoin', async () => {
      const { socket } = await connectAdapter({ capabilities: ['data.v2'] });
      const first = FakeRTCPeerConnection.latest;
      socket.receive({ type: 'room.joined', roomId: 'room-1', participants: [], capabilities: ['data.v2'] });
      await flush();
      // Same connection: nothing duplicated.
      expect(first.dataChannels).toHaveLength(2);
    });

    it('falls back to the reliable channel, warning once, when the server lacks data.v2', async () => {
      const logger = recordingLogger();
      const { adapter, socket } = await connectAdapter({ logger });
      const pc = await receiveOffer(socket);

      await sendAndOpen(socket, adapter.sendData(encode('a'), { reliable: false }));
      await adapter.sendData(encode('b'), { reliable: false });

      expect(channel(pc, 'raven-data-lossy')).toBeUndefined();
      expect(channel(pc, 'raven-data')!.sent.map(hex)).toEqual(['520200000061', '520200000062']);
      expect(logger.warnings.filter((w) => w.includes('lossy'))).toHaveLength(1);
    });

    it('enforces the lossy size limit and the envelope limits', async () => {
      const { adapter, socket } = await connectAdapter({ capabilities: ['data.v2'] });
      await receiveOffer(socket);

      await expect(
        adapter.sendData(new Uint8Array(1201) as Uint8Array<ArrayBuffer>, { reliable: false }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(adapter.sendData(encode('x'), { topic: 'a'.repeat(256) })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(
        adapter.sendData(encode('x'), { destinationIdentities: Array.from({ length: 65 }, (_, i) => `u${i}`) }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(adapter.sendData(encode('x'), { destinationIdentities: [''] })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    });

    it('opens the lossy channel alongside the reliable one for a listener on a v2 server', async () => {
      const { adapter, socket } = await connectAdapter({ capabilities: ['data.v2'] });
      const pc = await receiveOffer(socket);
      const room = new Room(adapter, 'room-1', recordingLogger());

      room.on('dataReceived', () => undefined);

      expect(pc.dataChannels.map((c) => c.label).sort()).toEqual(['raven-data', 'raven-data-lossy']);
    });

    it('opens only the reliable channel for a listener on an older server', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      new Room(adapter, 'room-1', recordingLogger()).on('dataReceived', () => undefined);
      expect(pc.dataChannels.map((c) => c.label)).toEqual(['raven-data']);
    });

    it('passes options through Room.sendData', async () => {
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      const room = new Room(adapter, 'room-1', recordingLogger());

      await sendAndOpen(socket, room.sendData('hello', { topic: 'chat' }));

      expect(hex(channel(pc, 'raven-data')!.sent[0])).toBe('52020004636861740068656c6c6f');
    });
  });

  describe('dataReceived (§1.3)', () => {
    async function listen(capabilities?: string[]) {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }], capabilities });
      const pc = await receiveOffer(socket);
      const room = new Room(adapter, 'room-1', recordingLogger());
      const received: { text: string; from?: RemoteParticipant; topic?: string }[] = [];
      room.on('dataReceived', (payload, from, topic) =>
        received.push({ text: new TextDecoder().decode(payload), from, topic }),
      );
      return { adapter, pc, received };
    }

    it('attributes a v2 delivery to the sending participant, with its topic', async () => {
      const { adapter, pc, received } = await listen(['data.v2']);
      const reliable = pc.emitDataChannel('raven-data');

      reliable.receive(fromHex('52030362' + '6f62' + '04' + Buffer.from('chat').toString('hex') + '6869'));

      expect(received).toEqual([{ text: 'hi', from: adapter.remoteParticipants.get('bob'), topic: 'chat' }]);
    });

    it('reports a server message (empty sender) with no participant', async () => {
      const { pc, received } = await listen();
      pc.emitDataChannel('raven-data').receive(fromHex('5203000673797374656d7b7d'));
      expect(received).toEqual([{ text: '{}', from: undefined, topic: 'system' }]);
    });

    it('passes legacy and malformed messages through untouched, with no sender or topic', async () => {
      const { pc, received } = await listen();
      const reliable = pc.emitDataChannel('raven-data');
      reliable.receive(new TextEncoder().encode('ping').buffer as ArrayBuffer);
      reliable.receive(fromHex('52030561'));
      expect(received).toEqual([
        { text: 'ping', from: undefined, topic: undefined },
        { text: 'R\u0003\u0005a', from: undefined, topic: undefined },
      ]);
    });

    it('treats an empty topic as none and an unknown sender as undefined', async () => {
      const { pc, received } = await listen();
      pc.emitDataChannel('raven-data').receive(fromHex('520303' + Buffer.from('zed').toString('hex') + '00' + '6869'));
      expect(received).toEqual([{ text: 'hi', from: undefined, topic: undefined }]);
    });

    it('decodes messages arriving on the lossy channel too', async () => {
      const { adapter, pc, received } = await listen(['data.v2']);
      const lossy = channel(pc, 'raven-data-lossy') as FakeRTCDataChannel;
      lossy.open();
      lossy.receive(fromHex('520303626f6200' + '6869'));
      expect(received).toEqual([{ text: 'hi', from: adapter.remoteParticipants.get('bob'), topic: undefined }]);
    });
  });

  describe('data.throttled (§1.4)', () => {
    it('emits dataThrottled with the channel and logs a warning', async () => {
      const logger = recordingLogger();
      const { adapter, socket } = await connectAdapter({ logger });
      const room = new Room(adapter, 'room-1', logger);
      const throttled: string[] = [];
      room.on('dataThrottled', (c) => throttled.push(c));

      socket.receive({ type: 'data.throttled', channel: 'lossy' });
      socket.receive({ type: 'data.throttled', channel: 'reliable' });

      expect(throttled).toEqual(['lossy', 'reliable']);
      expect(logger.warnings.some((w) => w.includes('throttled'))).toBe(true);
    });
  });

  describe('participant metadata and attributes (§2)', () => {
    it('reads metadata and attributes from room.joined and participant.joined', async () => {
      const { adapter, socket } = await connectAdapter({
        participants: [{ id: 'bob', metadata: '{"role":"host"}', attributes: { hand: 'up' } }, { id: 'carol' }],
      });
      socket.receive({
        type: 'participant.joined',
        participant: { id: 'dave', metadata: 'm', attributes: { a: '1' } },
      });

      const bob = adapter.remoteParticipants.get('bob')!;
      expect(bob.metadata).toBe('{"role":"host"}');
      expect(bob.attributes).toEqual({ hand: 'up' });
      expect(adapter.remoteParticipants.get('carol')!.metadata).toBeUndefined();
      expect(adapter.remoteParticipants.get('carol')!.attributes).toEqual({});
      expect(adapter.remoteParticipants.get('dave')!.attributes).toEqual({ a: '1' });
    });

    it('takes the local participant’s initial values from the token', async () => {
      const { adapter } = await connectAdapter({ token: token({ md: 'hello', attrs: { team: 'red' } }) });
      expect(adapter.localParticipant.metadata).toBe('hello');
      expect(adapter.localParticipant.attributes).toEqual({ team: 'red' });
    });

    it('applies participant.updated and emits participantMetadataChanged with the previous values', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob', metadata: 'old' }] });
      const room = new Room(adapter, 'room-1', recordingLogger());
      const changes: { who: Participant; prev: ParticipantMetadataSnapshot }[] = [];
      room.on('participantMetadataChanged', (who, prev) => changes.push({ who, prev }));
      const bob = adapter.remoteParticipants.get('bob')!;
      const own: ParticipantMetadataSnapshot[] = [];
      bob.on('metadataChanged', (prev) => own.push(prev));

      socket.receive({ type: 'participant.updated', participantId: 'bob', metadata: 'new', attributes: { k: 'v' } });
      // Unchanged: no event.
      socket.receive({ type: 'participant.updated', participantId: 'bob', metadata: 'new', attributes: { k: 'v' } });
      // Attributes only: metadata kept.
      socket.receive({ type: 'participant.updated', participantId: 'bob', attributes: {} });
      // Unknown participant: ignored.
      socket.receive({ type: 'participant.updated', participantId: 'nobody', metadata: 'x' });

      expect(bob.metadata).toBe('new');
      expect(bob.attributes).toEqual({});
      expect(changes).toEqual([
        { who: bob, prev: { metadata: 'old', attributes: {} } },
        { who: bob, prev: { metadata: 'new', attributes: { k: 'v' } } },
      ]);
      expect(own).toHaveLength(2);
    });

    it('applies an update addressed to the local participant', async () => {
      const { adapter, socket } = await connectAdapter();
      const changed: Participant[] = [];
      adapter.on('participantMetadataChanged', (who) => changed.push(who));
      socket.receive({ type: 'participant.updated', participantId: 'alice', metadata: 'me', attributes: null });
      expect(adapter.localParticipant.metadata).toBe('me');
      expect(changed).toEqual([adapter.localParticipant]);
    });

    it('refuses setMetadata/setAttributes without perms.updateOwnMetadata', async () => {
      const { adapter, socket } = await connectAdapter();
      await expect(adapter.localParticipant.setMetadata('x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(adapter.localParticipant.setAttributes({ a: 'b' })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      expect(socket.lastSent('participant.update')).toBeUndefined();
    });

    it('sends participant.update when granted, without updating optimistically', async () => {
      const { adapter, socket } = await connectAdapter({ token: token({}, { updateOwnMetadata: true }) });

      await adapter.localParticipant.setMetadata('busy');
      await adapter.localParticipant.setAttributes({ hand: 'up' });

      const sent = socket.sentMessages().filter((m) => m.type === 'participant.update');
      expect(sent).toEqual([
        { type: 'participant.update', metadata: 'busy' },
        { type: 'participant.update', attributes: { hand: 'up' } },
      ]);
      expect(adapter.localParticipant.metadata).toBeUndefined();
    });

    it('validates the limits before sending', async () => {
      const { adapter } = await connectAdapter({ token: token({}, { updateOwnMetadata: true }) });
      const local = adapter.localParticipant;
      await expect(local.setMetadata('x'.repeat(4097))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(local.setMetadata('x'.repeat(4096))).resolves.toBeUndefined();
      const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']));
      await expect(local.setAttributes(tooMany)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(local.setAttributes({ ['k'.repeat(65)]: 'v' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(local.setAttributes({ k: 'v'.repeat(1025) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });

    it('honours updateOwnMetadata granted live by participant.permissions_updated', async () => {
      const { adapter, socket } = await connectAdapter();
      socket.receive({
        type: 'participant.permissions_updated',
        permissions: { ...PERMS, updateOwnMetadata: true },
      });
      await expect(adapter.localParticipant.setMetadata('ok')).resolves.toBeUndefined();
      expect(adapter.permissions?.updateOwnMetadata).toBe(true);
    });

    it('leaves the permissions shape untouched for a token without the grant', async () => {
      const { adapter } = await connectAdapter();
      expect(adapter.permissions).toEqual({
        subscribe: true,
        publish: true,
        publishAudio: true,
        publishVideo: true,
        publishScreen: false,
        publishData: true,
      });
    });
  });

  describe('screen-share audio (§3)', () => {
    function displayMediaWithAudio(): jest.Mock {
      const getDisplayMedia = jest.fn(async (constraints: DisplayMediaStreamOptions) => {
        const tracks = [new FakeMediaStreamTrack('video', 'local-screen')];
        if (constraints.audio) tracks.push(new FakeMediaStreamTrack('audio', 'local-screen-audio'));
        return new FakeMediaStream(tracks);
      });
      (navigator.mediaDevices as unknown as { getDisplayMedia: unknown }).getDisplayMedia = getDisplayMedia;
      return getDisplayMedia;
    }

    const sources = (socket: FakeWebSocket) =>
      socket
        .sentMessages()
        .filter((m) => m.type === 'track.publish')
        .map((m) => m.source);

    it('keeps the video-only capture when audio is not asked for', async () => {
      const getDisplayMedia = displayMediaWithAudio();
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);

      await adapter.enableScreenShare(true);
      expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
      expect(sources(socket)).toEqual(['screenShare']);
    });

    it('publishes the display audio as screenShareAudio and unpublishes both together', async () => {
      const getDisplayMedia = displayMediaWithAudio();
      const { adapter, socket } = await connectAdapter();
      const pc = await receiveOffer(socket);
      const room = new Room(adapter, 'room-1', recordingLogger());

      const video = await room.enableScreenShare({ audio: true });
      await flush();

      expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
      expect(video?.kind).toBe('screenShare');
      expect(sources(socket)).toEqual(['screenShare', 'screenShareAudio']);
      expect(room.localParticipant.tracks.map((t) => t.kind)).toEqual(['screenShare', 'screenShareAudio']);
      expect(pc.activeSenders('audio')).toHaveLength(1);

      const unpublished: string[] = [];
      room.on('localTrackUnpublished', (t) => unpublished.push(t.kind));
      await room.disableScreenShare();

      expect(unpublished).toEqual(['screenShare', 'screenShareAudio']);
      expect(room.localParticipant.tracks).toHaveLength(0);
    });

    it('unpublishes the audio when the browser’s own Stop sharing ends the video', async () => {
      displayMediaWithAudio();
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);
      const video = await adapter.enableScreenShare(true, { audio: true });
      const unpublished: string[] = [];
      adapter.on('localTrackUnpublished', (t) => unpublished.push(t.kind));

      (video!.mediaStreamTrack as unknown as FakeMediaStreamTrack).end();
      await flush();

      expect(unpublished).toEqual(['screenShare', 'screenShareAudio']);
    });

    it('shares video only when the browser returns no audio', async () => {
      const { adapter, socket } = await connectAdapter();
      await receiveOffer(socket);
      await adapter.enableScreenShare(true, { audio: true });
      expect(sources(socket)).toEqual(['screenShare']);
    });

    it('labels a remote screenShareAudio track by its source', async () => {
      const { adapter, socket } = await connectAdapter({ participants: [{ id: 'bob' }] });
      const pc = await receiveOffer(socket);
      const subscribed: RemoteTrack[] = [];
      adapter.on('trackSubscribed', (t) => subscribed.push(t));
      socket.receive({
        type: 'track.published',
        participantId: 'bob',
        track: {
          trackId: 'bob-screen-audio',
          kind: 'audio',
          source: 'screenShareAudio',
          muted: false,
          simulcast: false,
        },
      });
      await flush();
      pc.emitTrack(new FakeMediaStreamTrack('audio', 'bob-screen-audio'));
      await flush();
      expect(subscribed.map((t) => t.kind)).toEqual(['screenShareAudio']);
    });
  });
});
