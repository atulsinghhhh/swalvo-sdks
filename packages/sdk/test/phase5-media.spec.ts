/**
 * Phase 5 client behaviour in the adapter: audio RED, `videoCodec` with
 * SVC, and the E2EE gate and wiring (docs/architecture/phase5-contracts.md
 * §2, §3). The crypto itself is covered by e2ee-crypto.spec.ts.
 */
import { SwalvoAdapter, type AdapterOptions } from '../src/internal/sfu/swalvo-adapter';
import { createLogger } from '../src/logger';
import { validateConfig } from '../src/config';
import { RTCError } from '../src/errors';
import { E2EEManager } from '../src/e2ee/manager';
import type { E2EEController, E2EEState } from '../src/e2ee/types';
import type { Participant } from '../src/participant';
import {
  FakeRTCPeerConnection,
  FakeWebSocket,
  fakeToken,
  flush,
  installFakeMediaDevices,
  installFakeWebRTC,
} from './helpers/fake-webrtc';

const ENDPOINT = 'ws://localhost:4000/v1/rtc';

function token(extra: Record<string, unknown> = {}): string {
  return fakeToken({
    sub: 'alice',
    rid: 'room-1',
    perms: { join: true, subscribe: true, publish: true, publishAudio: true, publishVideo: true, publishData: true },
    exp: Math.floor(Date.now() / 1000) + 600,
    ...extra,
  });
}

const adapters: SwalvoAdapter[] = [];

async function connect(
  options: Partial<AdapterOptions> = {},
  joined: Record<string, unknown> = {},
  tokenClaims: Record<string, unknown> = {},
): Promise<{ adapter: SwalvoAdapter; socket: FakeWebSocket }> {
  const adapter = new SwalvoAdapter(createLogger('silent'), true, { adaptiveStream: true, ...options });
  const connecting = adapter.connect(ENDPOINT, token(tokenClaims), []);
  await flush();
  const socket = FakeWebSocket.latest;
  socket.receive({ type: 'room.joined', roomId: 'room-1', participants: [], ...joined });
  await connecting;
  adapters.push(adapter);
  socket.receive({ type: 'sdp.offer', sdp: 'v=0 fake-server-offer' });
  await flush();
  return { adapter, socket };
}

const opus = { mimeType: 'audio/opus', clockRate: 48000, channels: 2 };
const red = { mimeType: 'audio/red', clockRate: 48000, channels: 2 };
const vp8 = { mimeType: 'video/VP8', clockRate: 90000 };
const vp9 = { mimeType: 'video/VP9', clockRate: 90000 };
const av1 = { mimeType: 'video/AV1', clockRate: 90000 };

function installCapabilities(video: unknown[], audio: unknown[] = [opus, red]): () => void {
  const globals = globalThis as { RTCRtpSender?: unknown };
  const original = globals.RTCRtpSender;
  globals.RTCRtpSender = {
    getCapabilities: (kind: string) => ({ codecs: kind === 'audio' ? audio : video, headerExtensions: [] }),
  };
  return () => {
    globals.RTCRtpSender = original;
  };
}

let teardown: () => void;
let restoreCaps: (() => void) | undefined;

beforeEach(() => {
  teardown = installFakeWebRTC();
  installFakeMediaDevices();
});

afterEach(async () => {
  while (adapters.length > 0) await adapters.pop()?.disconnect();
  restoreCaps?.();
  restoreCaps = undefined;
  delete (globalThis as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform;
  teardown();
});

describe('config', () => {
  const base = { token: token(), endpoint: ENDPOINT };

  it('treats preferredVideoCodec as an alias of videoCodec, videoCodec winning', () => {
    expect(validateConfig({ ...base, preferredVideoCodec: 'h264' }).preferredVideoCodec).toBe('h264');
    expect(validateConfig({ ...base, videoCodec: 'vp9' }).preferredVideoCodec).toBe('vp9');
    expect(validateConfig({ ...base, videoCodec: 'av1', preferredVideoCodec: 'h264' }).preferredVideoCodec).toBe('av1');
  });

  it('defaults audioRed to true', () => {
    expect(validateConfig(base).audioRed).toBe(true);
    expect(validateConfig({ ...base, audioRed: false }).audioRed).toBe(false);
  });

  it('rejects an unknown codec and an e2ee block without a key provider', () => {
    expect(() => validateConfig({ ...base, videoCodec: 'h265' as never })).toThrow(RTCError);
    expect(() => validateConfig({ ...base, e2ee: {} as never })).toThrow(
      expect.objectContaining({ code: 'E2EE_REQUIRED' }),
    );
  });
});

describe('audio RED (§2.1)', () => {
  it('puts audio/red first on the microphone by default', async () => {
    restoreCaps = installCapabilities([vp8]);
    const { adapter } = await connect();
    await adapter.enableMicrophone(true);
    await flush();
    const transceiver = FakeRTCPeerConnection.latest.transceivers.find((t) => t.kind === 'audio');
    expect(transceiver?.codecPreferences?.map((c) => c.mimeType)).toEqual(['audio/red', 'audio/opus']);
  });

  it('leaves the order alone with audioRed: false', async () => {
    restoreCaps = installCapabilities([vp8]);
    const { adapter } = await connect({ audioRed: false });
    await adapter.enableMicrophone(true);
    await flush();
    const transceiver = FakeRTCPeerConnection.latest.transceivers.find((t) => t.kind === 'audio');
    expect(transceiver?.codecPreferences).toBeUndefined();
  });

  it('does nothing when the browser has no RED', async () => {
    restoreCaps = installCapabilities([vp8], [opus]);
    const { adapter } = await connect();
    await adapter.enableMicrophone(true);
    await flush();
    const transceiver = FakeRTCPeerConnection.latest.transceivers.find((t) => t.kind === 'audio');
    expect(transceiver?.codecPreferences).toBeUndefined();
  });
});

describe('videoCodec and SVC (§2.2)', () => {
  it('publishes VP9 as one L3T3_KEY encoding with VP9 first', async () => {
    restoreCaps = installCapabilities([vp8, { ...vp9, scalabilityModes: ['L1T1', 'L3T3_KEY'] }]);
    const { adapter, socket } = await connect({ preferredVideoCodec: 'vp9' });
    await adapter.enableCamera(true);
    await flush();
    const pc = FakeRTCPeerConnection.latest;
    expect(pc.transceiverInits[0].sendEncodings).toEqual([{ scalabilityMode: 'L3T3_KEY', maxBitrate: 1_700_000 }]);
    expect(pc.transceivers.at(-1)?.codecPreferences?.[0].mimeType).toBe('video/VP9');
    socket.receive({ type: 'sdp.answer', sdp: 'v=0 answer' });
    await flush();
    expect(adapter.simulcastStatus('camera')).toBe('svc');
  });

  it('publishes AV1 SVC too', async () => {
    restoreCaps = installCapabilities([vp8, av1]);
    const { adapter } = await connect({ preferredVideoCodec: 'av1' });
    await adapter.enableCamera(true);
    await flush();
    const pc = FakeRTCPeerConnection.latest;
    expect(pc.transceiverInits[0].sendEncodings?.[0]).toMatchObject({ scalabilityMode: 'L3T3_KEY' });
    expect(pc.transceivers.at(-1)?.codecPreferences?.[0].mimeType).toBe('video/AV1');
  });

  it('falls back to VP8 simulcast when the browser cannot do VP9 SVC', async () => {
    restoreCaps = installCapabilities([vp8, { ...vp9, scalabilityModes: ['L1T1'] }]);
    const { adapter } = await connect({ preferredVideoCodec: 'vp9' });
    await adapter.enableCamera(true);
    await flush();
    const pc = FakeRTCPeerConnection.latest;
    expect(pc.transceiverInits[0].sendEncodings?.map((e) => e.rid)).toEqual(['low', 'medium', 'high']);
    expect(pc.transceivers.at(-1)?.codecPreferences?.[0].mimeType).toBe('video/VP8');
  });

  it('falls back to VP8 simulcast when the browser has no AV1 at all', async () => {
    restoreCaps = installCapabilities([vp8, vp9]);
    const { adapter } = await connect({ preferredVideoCodec: 'av1' });
    await adapter.enableCamera(true);
    await flush();
    expect(FakeRTCPeerConnection.latest.transceiverInits[0].sendEncodings).toHaveLength(3);
  });
});

describe('E2EE gate (§3.1)', () => {
  it('refuses to publish into an E2EE room without a key provider, before capturing', async () => {
    const { adapter } = await connect({}, { e2ee: true });
    expect(adapter.e2eeRequired).toBe(true);
    expect(adapter.isE2EEActive).toBe(false);
    await expect(adapter.enableCamera(true)).rejects.toMatchObject({ code: 'E2EE_REQUIRED' });
    await expect(adapter.enableMicrophone(true)).rejects.toMatchObject({ code: 'E2EE_REQUIRED' });
    expect(FakeRTCPeerConnection.latest.addedTracks).toHaveLength(0);
    expect(FakeRTCPeerConnection.latest.transceiverInits).toHaveLength(0);
  });

  it('honours the token claim before room.joined says so', async () => {
    const { adapter } = await connect({}, {}, { e2ee: true });
    await expect(adapter.enableMicrophone(true)).rejects.toMatchObject({ code: 'E2EE_REQUIRED' });
  });

  it('publishes normally in a room without e2ee', async () => {
    const { adapter } = await connect();
    await expect(adapter.enableMicrophone(true)).resolves.toBeDefined();
  });

  it('says E2EE_NOT_SUPPORTED when a key provider is configured but the browser cannot encrypt', async () => {
    const { controller, factory } = fakeController();
    const { adapter } = await connect({ e2ee: { keyProvider: factory as never } }, { e2ee: true });
    await expect(adapter.enableMicrophone(true)).rejects.toMatchObject({ code: 'E2EE_NOT_SUPPORTED' });
    expect(controller.started).toEqual([]);
  });
});

function fakeController() {
  const controller = {
    needsInsertableStreams: false,
    started: [] as Array<[string, string, boolean]>,
    senders: [] as string[],
    receivers: [] as Array<string | undefined>,
    left: [] as string[],
    disposed: 0,
    listener: undefined as undefined | ((id: string, d: 'encrypt' | 'decrypt', s: E2EEState) => void),
    async start(roomId: string, local: string, enabled: boolean) {
      controller.started.push([roomId, local, enabled]);
    },
    setupSender(_sender: RTCRtpSender, kind: 'audio' | 'video') {
      controller.senders.push(kind);
    },
    setupReceiver(_receiver: RTCRtpReceiver, _kind: 'audio' | 'video', participantId?: string) {
      controller.receivers.push(participantId);
    },
    updatePayloadTypes() {},
    participantLeft(id: string) {
      controller.left.push(id);
    },
    setStateListener(listener: (id: string, d: 'encrypt' | 'decrypt', s: E2EEState) => void) {
      controller.listener = listener;
    },
    dispose() {
      controller.disposed++;
    },
  };
  const factory = {
    sharedKey: true,
    ratchetWindow: 8,
    createController: () => controller as unknown as E2EEController,
  };
  return { controller, factory };
}

describe('E2EE wiring', () => {
  beforeEach(() => {
    (globalThis as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform = class {};
  });

  it('starts the controller with the room id and identity, and transforms every sender', async () => {
    const { controller, factory } = fakeController();
    const { adapter } = await connect({ e2ee: { keyProvider: factory as never } }, { e2ee: true });
    expect(controller.started).toEqual([['room-1', 'alice', true]]);
    expect(adapter.isE2EEActive).toBe(true);
    await adapter.enableMicrophone(true);
    await adapter.enableCamera(true);
    await flush();
    expect(controller.senders).toEqual(['audio', 'video']);
    expect(FakeRTCPeerConnection.latest.configuration).not.toHaveProperty('encodedInsertableStreams');
  });

  it('runs disabled (pass-through) in a room without e2ee', async () => {
    const { controller, factory } = fakeController();
    await connect({ e2ee: { keyProvider: factory as never } });
    expect(controller.started).toEqual([['room-1', 'alice', false]]);
  });

  it('builds the connection with encodedInsertableStreams for the legacy Chrome API', async () => {
    delete (globalThis as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform;
    const globals = globalThis as { RTCRtpSender?: unknown };
    const original = globals.RTCRtpSender;
    globals.RTCRtpSender = Object.assign(function () {}, { prototype: { createEncodedStreams() {} } });
    restoreCaps = () => {
      globals.RTCRtpSender = original;
    };
    const { controller, factory } = fakeController();
    controller.needsInsertableStreams = true;
    const { adapter } = await connect({ e2ee: { keyProvider: factory as never } }, { e2ee: true });
    await adapter.enableMicrophone(true);
    await flush();
    expect(FakeRTCPeerConnection.latest.configuration).toMatchObject({ encodedInsertableStreams: true });
  });

  it('turns RED off while E2EE is configured', async () => {
    restoreCaps = installCapabilities([vp8]);
    const { factory } = fakeController();
    const { adapter } = await connect({ e2ee: { keyProvider: factory as never } }, { e2ee: true });
    await adapter.enableMicrophone(true);
    await flush();
    const transceiver = FakeRTCPeerConnection.latest.transceivers.find((t) => t.kind === 'audio');
    expect(transceiver?.codecPreferences).toBeUndefined();
  });

  it('emits e2eeStateChanged for the local and remote participants, on changes only', async () => {
    const { controller, factory } = fakeController();
    const { adapter } = await connect(
      { e2ee: { keyProvider: factory as never } },
      { e2ee: true, participants: [{ id: 'bob' }] },
    );
    const events: Array<[string, E2EEState]> = [];
    adapter.on('e2eeStateChanged', (participant: Participant, state: E2EEState) =>
      events.push([participant.identity, state]),
    );
    controller.listener?.('alice', 'encrypt', 'ok');
    controller.listener?.('alice', 'encrypt', 'ok');
    controller.listener?.('bob', 'decrypt', 'missing_key');
    controller.listener?.('bob', 'decrypt', 'ok');
    controller.listener?.('nobody', 'decrypt', 'decrypt_failed');
    expect(events).toEqual([
      ['alice', 'ok'],
      ['bob', 'missing_key'],
      ['bob', 'ok'],
    ]);
  });

  it('disposes the controller on leave', async () => {
    const { controller, factory } = fakeController();
    const { adapter } = await connect({ e2ee: { keyProvider: factory as never } }, { e2ee: true });
    await adapter.disconnect();
    adapters.splice(adapters.indexOf(adapter), 1);
    expect(controller.disposed).toBe(1);
  });
});

describe('E2EEManager', () => {
  class FakeWorker {
    posted: Array<{ message: Record<string, unknown>; transfer: unknown[] }> = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: unknown = null;
    terminated = false;
    postMessage(message: Record<string, unknown>, transfer: unknown[] = []) {
      this.posted.push({ message, transfer });
    }
    terminate() {
      this.terminated = true;
    }
  }

  function host() {
    return {
      sharedKey: true,
      ratchetWindow: 8,
      registered: 0,
      async currentKeys() {
        return [{ participantId: undefined, material: new Uint8Array([1, 2, 3]), keyIndex: 0 }];
      },
      register() {
        this.registered++;
      },
      unregister() {
        this.registered--;
      },
      onWorkerRatcheted() {},
    };
  }

  it('hangs an RTCRtpScriptTransform on senders and receivers, once each', () => {
    const created: Array<{ worker: unknown; options: Record<string, unknown> }> = [];
    (globalThis as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform = class {
      constructor(worker: unknown, options: Record<string, unknown>) {
        created.push({ worker, options });
      }
    };
    const worker = new FakeWorker();
    const manager = new E2EEManager(host(), { worker: worker as unknown as Worker });
    const sender = {} as RTCRtpSender & { transform?: unknown };
    const receiver = {} as RTCRtpReceiver & { transform?: unknown };
    manager.setupSender(sender, 'video');
    manager.setupSender(sender, 'video');
    manager.setupReceiver(receiver, 'audio');
    manager.setupReceiver(receiver, 'audio', 'bob');
    expect(created.map((c) => c.options)).toEqual([
      expect.objectContaining({ direction: 'encrypt', kind: 'video' }),
      expect.objectContaining({ direction: 'decrypt', kind: 'audio' }),
    ]);
    expect(sender.transform).toBeDefined();
    expect(receiver.transform).toBeDefined();
    expect(worker.posted.map((p) => p.message)).toContainEqual(
      expect.objectContaining({ type: 'setTransformParticipant', participantId: 'bob' }),
    );
    manager.dispose();
    expect(worker.terminated).toBe(false); // the app's own worker is the app's to end
  });

  it('transfers encoded streams to the worker on the legacy API', () => {
    const worker = new FakeWorker();
    const manager = new E2EEManager(host(), { worker: worker as unknown as Worker });
    const readable = {};
    const writable = {};
    const sender = { createEncodedStreams: () => ({ readable, writable }) } as unknown as RTCRtpSender;
    manager.setupSender(sender, 'audio');
    const sent = worker.posted.find((p) => p.message.type === 'transform');
    expect(sent?.message).toMatchObject({ direction: 'encrypt', kind: 'audio', readable, writable });
    expect(sent?.transfer).toEqual([readable, writable]);
  });

  it('initialises the worker and replays the provider keys on start', async () => {
    const worker = new FakeWorker();
    const manager = new E2EEManager(host(), { worker: worker as unknown as Worker });
    await manager.start('room-1', 'alice', true);
    expect(worker.posted.map((p) => p.message.type)).toEqual(['init', 'setKey']);
    expect(worker.posted[0].message).toMatchObject({
      sharedKey: true,
      ratchetWindow: 8,
      localParticipantId: 'alice',
      enabled: true,
    });
  });

  it('relays worker states to the listener', () => {
    const worker = new FakeWorker();
    const manager = new E2EEManager(host(), { worker: worker as unknown as Worker });
    const states: string[] = [];
    manager.setStateListener((id, direction, state) => states.push(`${id}/${direction}/${state}`));
    worker.onmessage?.({
      data: { type: 'state', participantId: 'bob', direction: 'decrypt', state: 'decrypt_failed' },
    } as MessageEvent);
    expect(states).toEqual(['bob/decrypt/decrypt_failed']);
  });
});
