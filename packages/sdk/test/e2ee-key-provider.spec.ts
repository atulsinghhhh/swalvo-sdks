/**
 * @jest-environment node
 */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { createKeyProvider, createSharedKeyProvider } from '../src/e2ee/key-provider';
import { fromHex, toHex } from '../src/e2ee/crypto';

const vectors = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'docs', 'architecture', 'e2ee-vectors.json'), 'utf8'),
);

describe('createSharedKeyProvider', () => {
  it('derives the passphrase key for the room it joins', async () => {
    const provider = createSharedKeyProvider(vectors.passphrase.passphrase);
    expect(provider.sharedKey).toBe(true);
    expect(provider.ratchetWindow).toBe(8);
    const keys = await provider.currentKeys(vectors.passphrase.roomId);
    expect(keys).toHaveLength(1);
    expect(keys[0].participantId).toBeUndefined();
    expect(toHex(keys[0].material)).toBe(vectors.passphrase.material);
  });

  it('needs a passphrase', () => {
    expect(() => createSharedKeyProvider('')).toThrow(expect.objectContaining({ code: 'E2EE_REQUIRED' }));
  });
});

describe('createKeyProvider', () => {
  it('holds per-participant keys and ratchets them with HKDF', async () => {
    const provider = createKeyProvider({ ratchetWindow: 4 });
    expect(provider.ratchetWindow).toBe(4);
    await provider.setKey('bob', fromHex(vectors.ratchet.from), 2);
    await provider.ratchetKey('bob');
    const keys = await provider.currentKeys('any-room');
    expect(keys).toEqual([{ participantId: 'bob', material: expect.any(Uint8Array), keyIndex: 2 }]);
    expect(toHex(keys[0].material)).toBe(vectors.ratchet.steps[0].material);
  });

  it('rejects an out-of-range key index and ratcheting a key that does not exist', async () => {
    const provider = createKeyProvider();
    await expect(provider.setKey('bob', 'secret', 256)).rejects.toBeDefined();
    await expect(provider.ratchetKey('carol')).rejects.toMatchObject({ code: 'E2EE_REQUIRED' });
  });

  it('accepts string keys as their UTF-8 bytes', async () => {
    const provider = createKeyProvider();
    await provider.setKey('bob', 'abc');
    const [key] = await provider.currentKeys('r');
    expect(Array.from(key.material)).toEqual([97, 98, 99]);
  });

  it('pushes keys set mid-call to live connections', async () => {
    const provider = createKeyProvider();
    const pushed: Array<[string | undefined, number]> = [];
    const manager = {
      pushKey: (id: string | undefined, _m: Uint8Array, index: number) => pushed.push([id, index]),
      ratchet: async () => fromHex('aa'),
    };
    provider.register(manager as never);
    await provider.setKey('bob', 'k', 3);
    await provider.ratchetKey('bob');
    expect(pushed).toEqual([['bob', 3]]);
    const keys = await provider.currentKeys('r');
    expect(toHex(keys[0].material)).toBe('aa');
  });
});
