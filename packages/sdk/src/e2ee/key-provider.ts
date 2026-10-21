import { RTCError } from '../errors';
import { E2EE_DEFAULT_RATCHET_WINDOW, deriveMaterialFromPassphrase, ratchetMaterial } from './crypto';
import { E2EEManager, type KeyProviderHost } from './manager';
import type { E2EEController, E2EEControllerFactory } from './types';

export interface KeyProviderOptions {
  /**
   * How many forward ratchets a receiver tries on a frame that fails to
   * decrypt before dropping it. Defaults to 8. Must match nothing on the
   * other side; it only bounds how far behind a receiver can fall.
   */
  ratchetWindow?: number;
}

type KeyInput = Uint8Array | ArrayBuffer | string;

function toBytes(key: KeyInput): Uint8Array {
  if (typeof key === 'string') return new TextEncoder().encode(key);
  return key instanceof Uint8Array ? new Uint8Array(key) : new Uint8Array(key);
}

function checkIndex(keyIndex: number): number {
  if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex > 255) {
    throw new RTCError('INVALID_TOKEN', 'E2EE keyIndex must be an integer from 0 to 255');
  }
  return keyIndex;
}

/**
 * Holds the keys for end-to-end encryption. Keys never leave the device:
 * Swalvo's servers only ever see ciphertext (docs: /rtc/e2ee).
 *
 * Make one with `createSharedKeyProvider(passphrase)` (everyone in the room
 * shares a passphrase) or `createKeyProvider()` (you distribute a key per
 * participant over your own channel), and pass it as
 * `createRTCClient({ e2ee: { keyProvider } })`.
 */
export class KeyProvider implements E2EEControllerFactory, KeyProviderHost {
  readonly sharedKey: boolean;
  readonly ratchetWindow: number;
  private readonly passphrase?: string;
  /** Explicit keys (per-participant mode, or a shared key set as bytes). `undefined` participant = shared. */
  private readonly keys = new Map<string | undefined, Map<number, Uint8Array>>();
  private readonly currentIndex = new Map<string | undefined, number>();
  private readonly passphraseMaterial = new Map<string, Promise<Uint8Array>>();
  private readonly managers = new Set<E2EEManager>();

  /** @internal Use `createSharedKeyProvider()` or `createKeyProvider()`. */
  constructor(options: KeyProviderOptions & { sharedKey: boolean; passphrase?: string }) {
    this.sharedKey = options.sharedKey;
    this.passphrase = options.passphrase;
    this.ratchetWindow = options.ratchetWindow ?? E2EE_DEFAULT_RATCHET_WINDOW;
  }

  /**
   * Sets the key for `participantId` at `keyIndex`, and makes that index
   * the one they encrypt with (for your own id: the one you encrypt with).
   * `key` is raw key material — at least 16 random bytes; a string is
   * taken as its UTF-8 bytes. In shared mode the participant id is ignored
   * and the key replaces the passphrase-derived one for everyone.
   */
  async setKey(participantId: string, key: KeyInput, keyIndex = 0): Promise<void> {
    checkIndex(keyIndex);
    const id = this.sharedKey ? undefined : participantId;
    const material = toBytes(key);
    let ring = this.keys.get(id);
    if (!ring) {
      ring = new Map();
      this.keys.set(id, ring);
    }
    ring.set(keyIndex, material);
    this.currentIndex.set(id, keyIndex);
    for (const manager of this.managers) manager.pushKey(id, material, keyIndex);
  }

  /**
   * Advances a key one ratchet step (HKDF-SHA256, salt `LivqenoRatchet`).
   * Ratchet your own key after someone leaves so they cannot decrypt what
   * follows; receivers follow automatically within `ratchetWindow` steps.
   * In shared mode the participant id is ignored.
   */
  async ratchetKey(participantId?: string, keyIndex?: number): Promise<void> {
    const id = this.sharedKey ? undefined : participantId;
    const index = keyIndex ?? this.currentIndex.get(id) ?? 0;
    checkIndex(index);
    if (this.managers.size > 0) {
      // The worker holds the live ring (it may already have ratcheted on
      // receive), so ratchet there and mirror the result.
      let material: Uint8Array | undefined;
      for (const manager of this.managers) {
        material = (await manager.ratchet(id, index)) ?? material;
      }
      if (material) this.store(id, index, material);
      return;
    }
    const current = await this.materialFor(id, index);
    if (!current) {
      throw new RTCError('E2EE_REQUIRED', 'There is no key to ratchet for this participant yet');
    }
    this.store(id, index, await ratchetMaterial(current));
  }

  private store(id: string | undefined, keyIndex: number, material: Uint8Array): void {
    let ring = this.keys.get(id);
    if (!ring) {
      ring = new Map();
      this.keys.set(id, ring);
    }
    ring.set(keyIndex, material);
  }

  private async materialFor(id: string | undefined, keyIndex: number): Promise<Uint8Array | undefined> {
    const explicit = this.keys.get(id)?.get(keyIndex);
    if (explicit) return explicit;
    return undefined;
  }

  /** @internal */
  async currentKeys(
    roomId: string,
  ): Promise<Array<{ participantId?: string; material: Uint8Array; keyIndex: number }>> {
    const out: Array<{ participantId?: string; material: Uint8Array; keyIndex: number }> = [];
    if (this.passphrase !== undefined && !this.keys.get(undefined)?.has(0)) {
      let pending = this.passphraseMaterial.get(roomId);
      if (!pending) {
        pending = deriveMaterialFromPassphrase(this.passphrase, roomId);
        this.passphraseMaterial.set(roomId, pending);
      }
      out.push({ participantId: undefined, material: await pending, keyIndex: 0 });
    }
    for (const [participantId, ring] of this.keys) {
      const current = this.currentIndex.get(participantId);
      for (const [keyIndex, material] of ring) {
        if (keyIndex !== current) out.push({ participantId, material, keyIndex });
      }
      // The current index last, so it is the one the worker encrypts with.
      if (current !== undefined && ring.has(current)) {
        out.push({ participantId, material: ring.get(current)!, keyIndex: current });
      }
    }
    return out;
  }

  /** @internal */
  register(manager: E2EEManager): void {
    this.managers.add(manager);
  }

  /** @internal */
  unregister(manager: E2EEManager): void {
    this.managers.delete(manager);
  }

  /** @internal */
  onWorkerRatcheted(participantId: string | undefined, keyIndex: number, material: Uint8Array): void {
    this.store(participantId, keyIndex, material);
  }

  /** @internal Called by the RTC adapter for each connection. */
  createController(options: { worker?: Worker; log?: (message: string) => void }): E2EEController {
    return new E2EEManager(this, options);
  }
}

/**
 * Shared-passphrase E2EE: every participant configures the same
 * passphrase. The AES key is derived on device (PBKDF2-SHA256, 100k
 * iterations, salt `"LivqenoE2EE:" + roomId`), so the same passphrase
 * gives different keys in different rooms.
 */
export function createSharedKeyProvider(passphrase: string, options: KeyProviderOptions = {}): KeyProvider {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new RTCError('E2EE_REQUIRED', 'createSharedKeyProvider(passphrase) needs a non-empty passphrase');
  }
  return new KeyProvider({ ...options, sharedKey: true, passphrase });
}

/**
 * Per-participant E2EE: you distribute keys over your own channel and call
 * `keyProvider.setKey(participantId, key, keyIndex)` for yourself and for
 * everyone you receive from.
 */
export function createKeyProvider(options: KeyProviderOptions = {}): KeyProvider {
  return new KeyProvider({ ...options, sharedKey: false });
}
