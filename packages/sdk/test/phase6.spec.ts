import { SwalvoAdapter } from '../src/internal/sfu/swalvo-adapter';
import { createLogger } from '../src/logger';
import { LocalParticipant, RemoteParticipant, type Participant } from '../src/participant';
import { Room } from '../src/room';
import {
  CaptionStore,
  type AgentState,
  type TranscriptionSegment,
  type TranscriptionState,
} from '../src/transcription';
import { FakeAdapter } from './helpers/fake-adapter';
import { FakeWebSocket, fakeToken, flush, installFakeMediaDevices, installFakeWebRTC } from './helpers/fake-webrtc';

/**
 * Phase 6, client side (docs/architecture/phase6-contracts.md §4, §8):
 * caption segments, transcription state and agent state, driven from the
 * wire, plus the CaptionStore that folds segments for a UI.
 */

const logger = createLogger('silent');
const ENDPOINT = 'ws://localhost:4000/v1/rtc';
const PERMS = { join: true, subscribe: true, publish: true, publishAudio: true, publishVideo: true, publishData: true };

const connected: SwalvoAdapter[] = [];

async function connectAdapter(
  participants: Record<string, unknown>[] = [],
): Promise<{ adapter: SwalvoAdapter; socket: FakeWebSocket }> {
  const adapter = new SwalvoAdapter(logger, false, { adaptiveStream: false });
  const connecting = adapter.connect(
    ENDPOINT,
    fakeToken({
      sub: 'alice',
      rid: 'room-1',
      perms: PERMS,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
    [],
  );
  await flush();
  const socket = FakeWebSocket.latest;
  socket.receive({ type: 'room.joined', roomId: 'room-1', participants });
  await connecting;
  connected.push(adapter);
  return { adapter, socket };
}

function segment(overrides: Partial<TranscriptionSegment> = {}): TranscriptionSegment {
  return {
    type: 'transcription.segment',
    transcriptionId: 'trx_1',
    participantId: 'alice',
    segmentId: 'seg_1',
    text: 'hello',
    final: false,
    language: 'en',
    startMs: 0,
    endMs: 100,
    ...overrides,
  };
}

describe('Phase 6 — wire', () => {
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

  it('emits transcription.segment as transcriptionSegment, empty finals included', async () => {
    const { adapter, socket } = await connectAdapter();
    const seen: TranscriptionSegment[] = [];
    adapter.on('transcriptionSegment', (s) => seen.push(s));

    socket.receive({
      type: 'transcription.segment',
      transcriptionId: 'trx_1',
      participantId: 'bob',
      segmentId: 'seg_1',
      text: 'hello every',
      final: false,
      language: 'en',
      startMs: 120340,
      endMs: 121010,
    });
    socket.receive({
      type: 'transcription.segment',
      transcriptionId: 'trx_1',
      participantId: 'bob',
      segmentId: 'seg_1',
      text: '',
      final: true,
      language: 'en',
      startMs: 1,
      endMs: 2,
    });
    // Agent speech with no transcription running.
    socket.receive({
      type: 'transcription.segment',
      transcriptionId: null,
      agentId: 'agt_1',
      participantId: 'agent-agt_1',
      segmentId: 'seg_2',
      text: 'Hi!',
      final: true,
      language: 'en',
      startMs: 0,
      endMs: 5,
    });
    // Malformed: ignored.
    socket.receive({ type: 'transcription.segment', participantId: 'bob', text: 'x' });
    await flush();

    expect(seen).toEqual([
      segment({ participantId: 'bob', text: 'hello every', startMs: 120340, endMs: 121010 }),
      segment({ participantId: 'bob', text: '', final: true, startMs: 1, endMs: 2 }),
      segment({
        transcriptionId: null,
        agentId: 'agt_1',
        participantId: 'agent-agt_1',
        segmentId: 'seg_2',
        text: 'Hi!',
        final: true,
        endMs: 5,
      }),
    ]);
  });

  it('emits transcription.state as transcriptionStateChanged', async () => {
    const { adapter, socket } = await connectAdapter();
    const seen: TranscriptionState[] = [];
    adapter.on('transcriptionStateChanged', (s) => seen.push(s));

    socket.receive({ type: 'transcription.state', transcriptionId: 'trx_1', status: 'ACTIVE', language: 'en' });
    socket.receive({ type: 'transcription.state', transcriptionId: 'trx_1', status: 'BOGUS', language: 'en' });
    await flush();

    expect(seen).toEqual([{ transcriptionId: 'trx_1', status: 'ACTIVE', language: 'en' }]);
  });

  it('emits agent.state with the participant and records participant.agentState', async () => {
    const { adapter, socket } = await connectAdapter([{ id: 'agent-agt_1', tracks: [] }]);
    const seen: Array<[Participant, AgentState]> = [];
    adapter.on('agentStateChanged', (p, s) => seen.push([p, s]));
    const agent = adapter.remoteParticipants.get('agent-agt_1')!;
    expect(agent.isAgent).toBe(true);
    expect(agent.isTranscriber).toBe(false);

    socket.receive({ type: 'agent.state', agentId: 'agt_1', participantId: 'agent-agt_1', state: 'thinking' });
    socket.receive({ type: 'agent.state', agentId: 'agt_1', participantId: 'agent-agt_1', state: 'thinking' });
    socket.receive({ type: 'agent.state', agentId: 'agt_1', participantId: 'agent-agt_1', state: 'dancing' });
    socket.receive({ type: 'agent.state', agentId: 'agt_1', participantId: 'agent-agt_1', state: 'speaking' });
    await flush();

    expect(seen.map(([p, s]) => [p.identity, s])).toEqual([
      ['agent-agt_1', 'thinking'],
      ['agent-agt_1', 'speaking'],
    ]);
    expect(agent.agentState).toBe('speaking');
  });

  it('holds an agent.state that arrives before the agent joins, and applies it on join', async () => {
    const { adapter, socket } = await connectAdapter();
    const seen: Array<[string, AgentState]> = [];
    adapter.on('agentStateChanged', (p, s) => seen.push([p.identity, s]));

    socket.receive({ type: 'agent.state', agentId: 'agt_2', participantId: 'agent-agt_2', state: 'listening' });
    socket.receive({ type: 'agent.state', agentId: 'agt_3', participantId: 'agent-agt_3', state: 'ended' });
    await flush();
    expect(seen).toEqual([]);

    socket.receive({ type: 'participant.joined', participant: { id: 'agent-agt_2' } });
    socket.receive({ type: 'participant.joined', participant: { id: 'agent-agt_3' } });
    await flush();

    expect(seen).toEqual([['agent-agt_2', 'listening']]);
    expect(adapter.remoteParticipants.get('agent-agt_2')!.agentState).toBe('listening');
    expect(adapter.remoteParticipants.get('agent-agt_3')!.agentState).toBeUndefined();
  });
});

describe('Phase 6 — Room events', () => {
  it('re-emits the three adapter events unchanged', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    const calls: unknown[][] = [];
    room.on('transcriptionSegment', (s) => calls.push(['segment', s]));
    room.on('transcriptionStateChanged', (s) => calls.push(['state', s]));
    room.on('agentStateChanged', (p, s) => calls.push(['agent', p.identity, s]));

    const agent = new RemoteParticipant('agent-x');
    adapter.fire('transcriptionSegment', segment());
    adapter.fire('transcriptionStateChanged', { transcriptionId: 'trx_1', status: 'ENDED', language: 'en' });
    adapter.fire('agentStateChanged', agent, 'speaking');

    expect(calls).toEqual([
      ['segment', segment()],
      ['state', { transcriptionId: 'trx_1', status: 'ENDED', language: 'en' }],
      ['agent', 'agent-x', 'speaking'],
    ]);
  });
});

describe('Phase 6 — participant getters', () => {
  it('derives isAgent and isTranscriber from the identity prefix', () => {
    expect(new RemoteParticipant('agent-agt_1').isAgent).toBe(true);
    expect(new RemoteParticipant('transcriber-trx_1').isTranscriber).toBe(true);
    expect(new RemoteParticipant('transcriber-trx_1').isAgent).toBe(false);
    expect(new RemoteParticipant('alice').isAgent).toBe(false);
    expect(new LocalParticipant('agentsmith').isAgent).toBe(false);
  });

  it('emits agentStateChanged on the participant only when it changes', () => {
    const p = new RemoteParticipant('agent-1');
    const states: AgentState[] = [];
    p.on('agentStateChanged', (s) => states.push(s));
    expect(p._setAgentState('listening')).toBe(true);
    expect(p._setAgentState('listening')).toBe(false);
    p._setAgentState('ended');
    expect(states).toEqual(['listening', 'ended']);
  });
});

describe('CaptionStore', () => {
  it('replaces an interim by segmentId and closes it with the final', () => {
    const store = new CaptionStore();
    let notified = 0;
    store.subscribe(() => notified++);

    store.applySegment(segment({ text: 'hel' }));
    store.applySegment(segment({ text: 'hello every' }));
    expect(store.getSnapshot().interim).toEqual({ alice: segment({ text: 'hello every' }) });
    expect(store.getSnapshot().segments).toEqual([]);

    store.applySegment(segment({ text: 'hello everyone', final: true }));
    expect(store.getSnapshot().interim).toEqual({});
    expect(store.getSnapshot().segments.map((s) => s.text)).toEqual(['hello everyone']);
    expect(notified).toBe(3);
  });

  it('clears the interim on an empty final without adding a segment', () => {
    const store = new CaptionStore();
    store.applySegment(segment({ text: 'uh' }));
    const before = store.getSnapshot();
    expect(store.applySegment(segment({ text: '', final: true }))).toBe(true);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot().interim).toEqual({});
    expect(store.getSnapshot().segments).toEqual([]);
    // An empty final for nothing open changes nothing.
    const snap = store.getSnapshot();
    expect(store.applySegment(segment({ segmentId: 'seg_9', text: '', final: true }))).toBe(false);
    expect(store.getSnapshot()).toBe(snap);
  });

  it('keeps one interim per speaker and bounds the finals', () => {
    const store = new CaptionStore({ maxSegments: 2 });
    store.applySegment(segment({ participantId: 'alice', segmentId: 'a1', text: 'a' }));
    store.applySegment(segment({ participantId: 'bob', segmentId: 'b1', text: 'b' }));
    expect(Object.keys(store.getSnapshot().interim).sort()).toEqual(['alice', 'bob']);

    for (const id of ['f1', 'f2', 'f3']) store.applySegment(segment({ segmentId: id, text: id, final: true }));
    expect(store.getSnapshot().segments.map((s) => s.text)).toEqual(['f2', 'f3']);
  });

  it('filters to one participant when asked', () => {
    const store = new CaptionStore({ participantId: 'bob' });
    expect(store.applySegment(segment({ participantId: 'alice' }))).toBe(false);
    store.applySegment(segment({ participantId: 'bob', final: true }));
    expect(store.getSnapshot().segments).toHaveLength(1);
  });

  it('tracks active from state and from segments, and drops interims when the transcription ends', () => {
    const store = new CaptionStore();
    expect(store.getSnapshot().active).toBe(false);
    store.applySegment(segment({ text: 'mid' }));
    expect(store.getSnapshot().active).toBe(true); // joined mid-transcription

    store.applySegment(
      segment({ transcriptionId: null, participantId: 'agent-a', segmentId: 'ag', text: 'agent talking' }),
    );
    store.applyState({ transcriptionId: 'trx_1', status: 'ENDED', language: 'en' });
    const snap = store.getSnapshot();
    expect(snap.active).toBe(false);
    expect(snap.state?.status).toBe('ENDED');
    expect(Object.keys(snap.interim)).toEqual(['agent-a']);

    store.applySegment(segment({ segmentId: 'late', text: 'late', final: true }));
    expect(store.getSnapshot().active).toBe(false);
    store.applyState({ transcriptionId: 'trx_2', status: 'STARTING', language: 'en' });
    expect(store.getSnapshot().active).toBe(true);
  });

  it('attaches to a room and detaches cleanly', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    const store = new CaptionStore();
    const detach = store.attach(room);
    adapter.fire('transcriptionSegment', segment({ final: true }));
    expect(store.getSnapshot().segments).toHaveLength(1);
    detach();
    adapter.fire('transcriptionSegment', segment({ segmentId: 'x', final: true }));
    expect(store.getSnapshot().segments).toHaveLength(1);
  });

  it('clear() forgets segments but keeps the state', () => {
    const store = new CaptionStore();
    store.applyState({ transcriptionId: 'trx_1', status: 'ACTIVE', language: 'en' });
    store.applySegment(segment({ final: true }));
    store.clear();
    expect(store.getSnapshot()).toMatchObject({ segments: [], interim: {}, active: true });
  });
});
