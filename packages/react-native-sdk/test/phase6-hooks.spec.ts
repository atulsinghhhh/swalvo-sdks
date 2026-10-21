/**
 * Phase 6 hooks (useTranscription, useAgentState), run against a one-shot
 * stand-in for React like phase7-hooks.spec.ts. Every `setState` lands in
 * `sets`, so a test reads the latest value the hook would render.
 */

const cleanups: (() => void)[] = [];
const sets: unknown[] = [];

jest.mock('react', () => ({
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(initial: T | (() => T)) => {
    const value = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [value, (next: T) => sets.push(next)];
  },
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
  useCallback: <T>(fn: T) => fn,
  useMemo: <T>(fn: () => T) => fn(),
}));

import { useAgentState, useTranscription } from '../src/hooks';

type Handler = (...args: unknown[]) => void;

class FakeEmitter {
  agentState?: string;
  constructor(public identity = 'x') {}
  private readonly handlers = new Map<string, Set<Handler>>();
  on(event: string, handler: Handler): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }
  off(event: string, handler: Handler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

const seg = (o: Record<string, unknown> = {}) => ({
  type: 'transcription.segment',
  transcriptionId: 'trx_1',
  participantId: 'alice',
  segmentId: 's1',
  text: 'hi',
  final: false,
  language: 'en',
  startMs: 0,
  endMs: 1,
  ...o,
});

const latest = <T>() => sets[sets.length - 1] as T;

describe('phase 6 hooks', () => {
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    sets.length = 0;
  });

  it('useTranscription folds segments through CaptionStore and unsubscribes on cleanup', () => {
    const room = new FakeEmitter();
    const initial = useTranscription(room as never);
    expect(initial).toEqual({ segments: [], interim: {}, active: false });

    room.emit('transcriptionSegment', seg({ text: 'hel' }));
    expect(latest<{ interim: Record<string, { text: string }> }>().interim.alice.text).toBe('hel');
    room.emit('transcriptionSegment', seg({ text: 'hello', final: true }));
    const snap = latest<{ segments: { text: string }[]; interim: object; active: boolean }>();
    expect(snap.segments.map((s) => s.text)).toEqual(['hello']);
    expect(snap.interim).toEqual({});
    expect(snap.active).toBe(true);

    room.emit('transcriptionSegment', seg({ segmentId: 's2', text: 'uh' }));
    room.emit('transcriptionSegment', seg({ segmentId: 's2', text: '', final: true }));
    expect(latest<{ interim: object; segments: unknown[] }>()).toMatchObject({
      interim: {},
      segments: [{ text: 'hello' }],
    });

    while (cleanups.length > 0) cleanups.pop()?.();
    const count = sets.length;
    room.emit('transcriptionSegment', seg({ segmentId: 's3', final: true }));
    expect(sets).toHaveLength(count);
  });

  it('useTranscription filters by participant', () => {
    const room = new FakeEmitter();
    useTranscription(room as never, { participant: new FakeEmitter('bob') as never });
    const before = sets.length;
    room.emit('transcriptionSegment', seg({ participantId: 'alice', final: true }));
    expect(sets).toHaveLength(before);
  });

  it('useAgentState reads agentState and follows agentStateChanged', () => {
    const agent = new FakeEmitter('agent-a');
    agent.agentState = 'listening';
    expect(useAgentState(agent as never)).toBe('listening');
    agent.emit('agentStateChanged', 'speaking');
    expect(latest()).toBe('speaking');
    expect(useAgentState(undefined)).toBeUndefined();
  });
});
