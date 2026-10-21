/**
 * Phase 7 hooks (useDataReceived, useParticipantMetadata), run against a
 * one-shot stand-in for React: effects run at once and their cleanups are
 * collected, which is all these subscriptions need.
 */

const cleanups: (() => void)[] = [];

jest.mock('react', () => ({
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(initial: T | (() => T)) => {
    const value = typeof initial === 'function' ? (initial as () => T)() : initial;
    const box = { value };
    return [box.value, (next: T) => (box.value = next)];
  },
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
  useCallback: <T>(fn: T) => fn,
  useMemo: <T>(fn: () => T) => fn(),
}));

import { useDataReceived, useParticipantMetadata } from '../src/hooks';

type Handler = (...args: unknown[]) => void;

class FakeEmitter {
  metadata?: string = 'm';
  attributes: Record<string, string> = { a: '1' };
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

describe('phase 7 hooks', () => {
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('useDataReceived delivers payload, sender and topic, filtered by topic', () => {
    const room = new FakeEmitter();
    const all: unknown[][] = [];
    const chat: unknown[][] = [];
    useDataReceived(room as never, (...args) => all.push(args));
    useDataReceived(room as never, (...args) => chat.push(args), { topic: 'chat' });

    const payload = new Uint8Array([1]);
    room.emit('dataReceived', payload, undefined, 'chat');
    room.emit('dataReceived', payload, 'bob', 'cursor');
    room.emit('dataReceived', payload, undefined, undefined);

    expect(all).toEqual([
      [payload, undefined, 'chat'],
      [payload, 'bob', 'cursor'],
      [payload, undefined, undefined],
    ]);
    expect(chat).toEqual([[payload, undefined, 'chat']]);

    while (cleanups.length > 0) cleanups.pop()?.();
    room.emit('dataReceived', payload, undefined, 'chat');
    expect(all).toHaveLength(3);
  });

  it('useParticipantMetadata reads the participant and subscribes to metadataChanged', () => {
    const participant = new FakeEmitter();
    const info = useParticipantMetadata(participant as never);
    expect(info).toEqual({ metadata: 'm', attributes: { a: '1' } });
    expect(cleanups).toHaveLength(1);
    expect(useParticipantMetadata(undefined)).toEqual({ metadata: undefined, attributes: {} });
  });
});
