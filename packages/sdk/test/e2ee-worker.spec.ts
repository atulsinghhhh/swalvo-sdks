/**
 * @jest-environment node
 *
 * The transform worker end to end, with Node's web streams standing in for
 * the browser's encoded-frame streams: a sender worker encrypts, a receiver
 * worker decrypts, and plaintext never leaves a sender.
 */
import { webcrypto } from 'node:crypto';
import { ReadableStream, TransformStream, WritableStream } from 'node:stream/web';

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
Object.assign(globalThis, { ReadableStream, WritableStream, TransformStream });

import { fromHex, toHex } from '../src/e2ee/crypto';

interface Scope {
  onmessage: ((event: { data: unknown }) => void) | null;
  onrtctransform: ((event: unknown) => void) | null;
  posted: unknown[];
  postMessage(message: unknown): void;
}

function loadWorker(): Scope {
  const scope: Scope = {
    onmessage: null,
    onrtctransform: null,
    posted: [],
    postMessage(message) {
      scope.posted.push(message);
    },
  };
  (globalThis as { self?: unknown }).self = scope;
  jest.isolateModules(() => {
    require('../src/e2ee/worker');
  });
  return scope;
}

interface Frame {
  data: ArrayBuffer;
  timestamp: number;
  type?: 'key' | 'delta';
  getMetadata(): { synchronizationSource: number; mimeType?: string };
}

function frame(hex: string, type: 'key' | 'delta', mimeType?: string): Frame {
  const bytes = fromHex(hex);
  return {
    data: bytes.buffer.slice(0) as ArrayBuffer,
    timestamp: 3000,
    type,
    getMetadata: () => ({ synchronizationSource: 42, mimeType }),
  };
}

async function run(scope: Scope, options: Record<string, unknown>, frames: Frame[]): Promise<Frame[]> {
  const out: Frame[] = [];
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const readable = new ReadableStream<Frame>({
    start(controller) {
      for (const f of frames) controller.enqueue(f);
      controller.close();
    },
  });
  const writable = new WritableStream<Frame>({
    write(f) {
      out.push(f);
    },
    close() {
      done();
    },
  });
  scope.onrtctransform?.({ transformer: { readable, writable, options } });
  await finished;
  return out;
}

const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const VP8_DELTA = '310100' + 'aa'.repeat(40);

/**
 * setKey is fire-and-forget in the worker (no acknowledgement message), and
 * key import/derivation is async Web Crypto work. A fixed sleep was flaky on
 * a loaded machine, so wait for the actual crypto calls to settle instead:
 * every subtle.* promise started since `trackCrypto()` is awaited, repeatedly,
 * until no new ones appear (setKey chains import -> derive -> import).
 */
function trackCrypto(): () => Promise<void> {
  const subtle = globalThis.crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const pending: Promise<unknown>[] = [];
  const originals = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  for (const name of ['importKey', 'deriveKey', 'deriveBits', 'exportKey']) {
    const original = subtle[name].bind(globalThis.crypto.subtle);
    originals.set(name, subtle[name]);
    subtle[name] = (...args: unknown[]) => {
      const p = original(...args);
      pending.push(p);
      return p;
    };
  }
  return async () => {
    let seen = -1;
    while (seen !== pending.length) {
      seen = pending.length;
      await Promise.allSettled(pending);
      await new Promise((r) => setTimeout(r, 0));
    }
    for (const [name, fn] of originals) subtle[name] = fn;
  };
}

describe('e2ee worker', () => {
  afterEach(() => {
    delete (globalThis as { self?: unknown }).self;
  });

  it('encrypts on send and decrypts on receive, reporting ok for both', async () => {
    const sender = loadWorker();
    sender.onmessage?.({
      data: { type: 'init', sharedKey: true, ratchetWindow: 8, localParticipantId: 'alice', enabled: true },
    });
    const senderKeyReady = trackCrypto();
    sender.onmessage?.({ data: { type: 'setKey', material: fromHex(KEY), keyIndex: 0 } });
    await senderKeyReady();
    const [encrypted] = await run(sender, { transformId: 's1', direction: 'encrypt', kind: 'video' }, [
      frame(VP8_DELTA, 'delta', 'video/VP8'),
    ]);
    const bytes = new Uint8Array(encrypted.data);
    expect(toHex(bytes.subarray(0, 3))).toBe('310100');
    expect(bytes.length).toBe(fromHex(VP8_DELTA).length + 30);
    expect(sender.posted).toContainEqual({ type: 'state', participantId: 'alice', direction: 'encrypt', state: 'ok' });

    const receiver = loadWorker();
    receiver.onmessage?.({
      data: { type: 'init', sharedKey: true, ratchetWindow: 8, localParticipantId: 'bob', enabled: true },
    });
    const receiverKeyReady = trackCrypto();
    receiver.onmessage?.({ data: { type: 'setKey', material: fromHex(KEY), keyIndex: 0 } });
    await receiverKeyReady();
    const [decrypted] = await run(
      receiver,
      { transformId: 'r1', direction: 'decrypt', kind: 'video', participantId: 'alice' },
      [{ ...encrypted, getMetadata: () => ({ synchronizationSource: 42, mimeType: 'video/VP8' }) }],
    );
    expect(toHex(new Uint8Array(decrypted.data))).toBe(VP8_DELTA);
    expect(receiver.posted).toContainEqual({
      type: 'state',
      participantId: 'alice',
      direction: 'decrypt',
      state: 'ok',
    });
  });

  it('drops outgoing frames when there is no key: never plaintext', async () => {
    const sender = loadWorker();
    sender.onmessage?.({
      data: { type: 'init', sharedKey: false, ratchetWindow: 8, localParticipantId: 'alice', enabled: true },
    });
    const out = await run(sender, { transformId: 's1', direction: 'encrypt', kind: 'audio' }, [
      frame('fc0102030405', 'delta'),
    ]);
    expect(out).toEqual([]);
    expect(sender.posted).toContainEqual({
      type: 'state',
      participantId: 'alice',
      direction: 'encrypt',
      state: 'missing_key',
    });
  });

  it('drops outgoing frames before it is initialised', async () => {
    const sender = loadWorker();
    const out = await run(sender, { transformId: 's1', direction: 'encrypt', kind: 'audio' }, [
      frame('fc0102030405', 'delta'),
    ]);
    expect(out).toEqual([]);
  });

  it('passes received frames through in a room without e2ee, even before the participant is known', async () => {
    const receiver = loadWorker();
    receiver.onmessage?.({
      data: { type: 'init', sharedKey: true, ratchetWindow: 8, localParticipantId: 'bob', enabled: false },
    });
    const out = await run(receiver, { transformId: 'r1', direction: 'decrypt', kind: 'audio' }, [
      frame('fc0102', 'delta'),
    ]);
    expect(toHex(new Uint8Array(out[0].data))).toBe('fc0102');
  });

  it('passes frames through in a room without e2ee', async () => {
    const sender = loadWorker();
    sender.onmessage?.({
      data: { type: 'init', sharedKey: true, ratchetWindow: 8, localParticipantId: 'alice', enabled: false },
    });
    const out = await run(sender, { transformId: 's1', direction: 'encrypt', kind: 'audio' }, [
      frame('fc0102', 'delta'),
    ]);
    expect(toHex(new Uint8Array(out[0].data))).toBe('fc0102');
  });
});
