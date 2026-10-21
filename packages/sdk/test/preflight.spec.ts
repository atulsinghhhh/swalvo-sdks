import { RTCError } from '../src/errors';
import { TypedEventEmitter } from '../src/events';
import { runConnectionTest, type ConnectionTestDeps } from '../src/preflight';
import { routeFromReport, sampleFromReport, summarize, turnServersByTransport } from '../src/internal/preflight/stats';
import type { SFUAdapterEventMap, SdkConnectionState } from '../src/internal/sfu/types';
import { LocalTrack, type LocalTrackDelegate } from '../src/track';

/**
 * The pre-call test. The arithmetic is checked against stats reports shaped
 * like Chrome's; the orchestration against an adapter double, so these run
 * without a browser. Whether a real network passes is, by definition, not
 * something a unit test can say.
 */

function report(entries: Record<string, unknown>[]): Map<string, unknown> {
  return new Map(entries.map((entry, index) => [String(entry.id ?? index), entry]));
}

const relayOverTls = [
  { id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' },
  { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', state: 'succeeded', currentRoundTripTime: 0.12 },
  { id: 'L1', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' },
];

describe('pre-call stats', () => {
  it('reads the selected route off the transport', () => {
    expect(routeFromReport(report(relayOverTls))).toEqual({
      candidateType: 'relay',
      usedRelay: true,
      protocol: 'udp',
      relayProtocol: 'tls',
    });
  });

  it('falls back to the nominated pair where there is no transport entry', () => {
    // Firefox's shape.
    const route = routeFromReport(
      report([
        { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', state: 'succeeded', nominated: true },
        { id: 'L1', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
      ]),
    );
    expect(route).toEqual({ candidateType: 'host', usedRelay: false, protocol: 'udp', relayProtocol: undefined });
  });

  it('reports nothing rather than guessing before a pair is selected', () => {
    expect(routeFromReport(report([{ id: 'P1', type: 'candidate-pair', state: 'in-progress' }]))).toEqual({});
  });

  it('summarises RTT, jitter, loss and upstream over the samples', () => {
    const at = (t: number, bytes: number, packets: number, lost: number, jitter: number, rtt: number) =>
      sampleFromReport(
        report([
          { id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' },
          { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', state: 'succeeded', currentRoundTripTime: rtt },
          { id: 'L1', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
          { id: 'O1', type: 'outbound-rtp', bytesSent: bytes, packetsSent: packets },
          { id: 'R1', type: 'remote-inbound-rtp', packetsLost: lost, jitter },
        ]),
        t,
      );

    const summary = summarize([at(0, 0, 0, 0, 0.004, 0.05), at(5_000, 625_000, 1_000, 20, 0.012, 0.07)]);

    expect(summary.rttMs).toBeCloseTo(60);
    expect(summary.jitterMs).toBeCloseTo(12);
    expect(summary.packetLossPercent).toBeCloseTo(2);
    // 625 kB over 5 s is 1000 kbit/s.
    expect(summary.upstreamKbps).toBeCloseTo(1000);
  });

  it('leaves out what it could not measure', () => {
    expect(summarize([])).toEqual({
      rttMs: undefined,
      jitterMs: undefined,
      packetLossPercent: undefined,
      upstreamKbps: undefined,
    });
  });

  it('groups TURN URLs by transport, keeping credentials and dropping STUN', () => {
    const groups = turnServersByTransport([
      { urls: 'stun:stun.example:3478' },
      {
        urls: [
          'turn:t.example:3478?transport=udp',
          'turn:t.example:3478?transport=tcp',
          'turns:t.example:5349?transport=tcp',
        ],
        username: 'u',
        credential: 'c',
      },
      { urls: 'turn:legacy.example:3478' },
    ]);
    expect(groups.get('udp')).toEqual([
      { urls: 'turn:t.example:3478?transport=udp', username: 'u', credential: 'c' },
      { urls: 'turn:legacy.example:3478', username: undefined, credential: undefined },
    ]);
    expect(groups.get('tcp')?.map((server) => server.urls)).toEqual(['turn:t.example:3478?transport=tcp']);
    expect(groups.get('tls')?.map((server) => server.urls)).toEqual(['turns:t.example:5349?transport=tcp']);
  });
});

class AdapterDouble extends TypedEventEmitter<SFUAdapterEventMap> {
  connectionState: SdkConnectionState = 'disconnected';
  published: LocalTrack[] = [];
  dataChannelRequested = false;
  disconnected = false;
  constructor(
    private readonly behaviour: { joinFails?: boolean; mediaFails?: boolean; stats?: Map<string, unknown>[] } = {},
  ) {
    super();
  }
  async connect(): Promise<void> {
    if (this.behaviour.joinFails) throw new RTCError('INVALID_TOKEN', 'RTC token rejected');
    this.connectionState = 'connecting';
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
  async publish(track: LocalTrack): Promise<void> {
    this.published.push(track);
    this.settle();
  }
  ensureDataChannel(): void {
    this.dataChannelRequested = true;
    this.settle();
  }
  async getStatsReport(): Promise<RTCStatsReport | undefined> {
    const next = this.behaviour.stats?.shift();
    return next as unknown as RTCStatsReport | undefined;
  }
  private settle(): void {
    void Promise.resolve().then(() => {
      this.connectionState = this.behaviour.mediaFails ? 'failed' : 'connected';
      this.emit('connectionStateChanged', this.connectionState);
    });
  }
}

function fakeTrack(kind: 'camera' | 'microphone'): LocalTrack {
  const delegate = {
    mediaStreamTrack: { stop: jest.fn(), kind: kind === 'camera' ? 'video' : 'audio' } as unknown as MediaStreamTrack,
    isMuted: false,
    attach: (element?: HTMLMediaElement) => element as HTMLMediaElement,
    detach: () => [],
    mute: async () => undefined,
    unmute: async () => undefined,
  } as unknown as LocalTrackDelegate;
  return new LocalTrack(delegate, kind);
}

function deps(adapter: AdapterDouble, overrides: Partial<ConnectionTestDeps> = {}): Partial<ConnectionTestDeps> {
  let clock = 0;
  return {
    createAdapter: () => adapter as unknown as ReturnType<ConnectionTestDeps['createAdapter']>,
    probeTurn: async () => true,
    captureCamera: async () => fakeTrack('camera'),
    captureMicrophone: async () => fakeTrack('microphone'),
    countDevices: async () => 1,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ...overrides,
  };
}

const ICE: RTCIceServer[] = [
  { urls: ['turn:t.example:3478?transport=udp', 'turns:t.example:5349?transport=tcp'], username: 'u', credential: 'c' },
];

describe('runConnectionTest', () => {
  it('passes a healthy device and network, and reports how it connected', async () => {
    const adapter = new AdapterDouble({ stats: [report(relayOverTls), report(relayOverTls)] });
    const stages: string[] = [];
    const result = await runConnectionTest(
      {
        token: 't',
        endpoint: 'wss://x',
        iceServers: ICE,
        durationMs: 2_000,
        onProgress: (stage) => stages.push(stage),
      },
      deps(adapter),
    );

    expect(result.ok).toBe(true);
    expect(result.camera).toEqual({ status: 'passed', devices: 1 });
    expect(result.microphone.status).toBe('passed');
    expect(result.signaling.status).toBe('passed');
    expect(result.media.status).toBe('passed');
    expect(result.route).toMatchObject({ usedRelay: true, relayProtocol: 'tls' });
    expect(result.turn).toEqual({ udp: 'passed', tcp: 'skipped', tls: 'passed' });
    expect(result.network.rttMs).toBeCloseTo(120);
    expect(result.issues.map((issue) => issue.code)).toContain('RELAY_REQUIRED');
    expect(adapter.published).toHaveLength(2);
    expect(adapter.disconnected).toBe(true);
    expect(stages).toEqual(['devices', 'turn', 'signaling', 'media', 'measuring', 'done']);
  });

  it('records a denied camera as a finding and still tests the network', async () => {
    const adapter = new AdapterDouble();
    const result = await runConnectionTest(
      { token: 't', endpoint: 'wss://x', durationMs: 0 },
      deps(adapter, {
        captureCamera: async () => {
          throw new RTCError('CAMERA_PERMISSION_DENIED', 'Permission to use the camera was denied');
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.camera).toMatchObject({ status: 'failed', error: 'CAMERA_PERMISSION_DENIED' });
    expect(result.issues.map((issue) => issue.code)).toContain('CAMERA_UNAVAILABLE');
    expect(adapter.published).toHaveLength(1);
  });

  it('connects over a data channel when there is nothing to publish', async () => {
    const adapter = new AdapterDouble();
    const result = await runConnectionTest(
      { token: 't', endpoint: 'wss://x', camera: false, microphone: false, durationMs: 0 },
      deps(adapter),
    );

    expect(result.media.status).toBe('passed');
    expect(adapter.dataChannelRequested).toBe(true);
    expect(result.camera.status).toBe('skipped');
    expect(result.turn).toEqual({ udp: 'skipped', tcp: 'skipped', tls: 'skipped' });
  });

  it('fails without throwing when the join is refused', async () => {
    const adapter = new AdapterDouble({ joinFails: true });
    const result = await runConnectionTest({ token: 't', endpoint: 'wss://x', durationMs: 0 }, deps(adapter));

    expect(result.ok).toBe(false);
    expect(result.signaling).toMatchObject({ status: 'failed', error: 'INVALID_TOKEN' });
    expect(result.media.status).toBe('skipped');
    expect(result.issues[0].code).toBe('CONNECT_FAILED');
    expect(adapter.disconnected).toBe(true);
  });

  it('fails media and flags UDP when ICE cannot connect', async () => {
    const adapter = new AdapterDouble({ mediaFails: true });
    const result = await runConnectionTest(
      { token: 't', endpoint: 'wss://x', iceServers: ICE, durationMs: 0 },
      deps(adapter, { probeTurn: async (servers) => !String(servers[0].urls).includes('transport=udp') }),
    );

    expect(result.ok).toBe(false);
    expect(result.media.status).toBe('failed');
    expect(result.turn.udp).toBe('failed');
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MEDIA_FAILED', 'UDP_BLOCKED']));
  });

  it('rejects only for missing credentials', async () => {
    await expect(runConnectionTest({ token: '', endpoint: 'wss://x' })).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });
});
