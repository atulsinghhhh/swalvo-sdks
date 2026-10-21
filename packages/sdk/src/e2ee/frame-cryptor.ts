import {
  E2EE_DEFAULT_RATCHET_WINDOW,
  decryptParsedFrame,
  deriveKeySet,
  encryptFrame,
  makeIv,
  parseEncryptedFrame,
  ratchetMaterial,
  type E2EEKeySet,
  type FrameInfo,
} from './crypto';

/**
 * Per-participant encryption state, as reported by `e2eeStateChanged`.
 *
 * - `ok`: frames are being encrypted (local) or decrypted (remote).
 * - `missing_key`: no key for this participant at the frame's key index;
 *   frames are dropped until one is set.
 * - `decrypt_failed`: a frame failed with the key and every ratchet in the
 *   window, so it was dropped. Usually a wrong passphrase.
 * - `encrypt_failed`: WebCrypto refused to encrypt; the frame was dropped.
 */
export type E2EEState = 'ok' | 'missing_key' | 'decrypt_failed' | 'encrypt_failed';

export type CryptorDirection = 'encrypt' | 'decrypt';

export interface FrameCryptorCoreOptions {
  /** One key for everyone (shared-passphrase mode) rather than one per participant. */
  sharedKey: boolean;
  ratchetWindow?: number;
  onStateChanged?: (participantId: string, direction: CryptorDirection, state: E2EEState) => void;
  /** A receive-side ratchet found the sender's newer key; the material is the new current one at `keyIndex`. */
  onKeyRatcheted?: (participantId: string | undefined, keyIndex: number, material: Uint8Array) => void;
}

const SHARED = '\u0000shared';

/**
 * The stateful half of E2EE: a key ring per participant, the send counter
 * per SSRC, the receive-side ratchet window and state reporting. Runs in
 * the transform worker; kept free of any Worker or WebRTC API so the unit
 * tests drive it directly.
 */
export class FrameCryptorCore {
  enabled = true;
  private readonly rings = new Map<string, Map<number, E2EEKeySet>>();
  private readonly currentIndex = new Map<string, number>();
  private readonly sendCounts = new Map<number, number>();
  private readonly lastState = new Map<string, E2EEState>();
  private readonly ratchetWindow: number;

  constructor(private readonly options: FrameCryptorCoreOptions) {
    this.ratchetWindow = options.ratchetWindow ?? E2EE_DEFAULT_RATCHET_WINDOW;
  }

  private ringId(participantId: string | undefined): string {
    return this.options.sharedKey || participantId === undefined ? SHARED : participantId;
  }

  /** Installs material at `keyIndex` and makes it the index this participant encrypts with. */
  async setKey(participantId: string | undefined, material: Uint8Array, keyIndex = 0): Promise<void> {
    const keySet = await deriveKeySet(material);
    const id = this.ringId(participantId);
    let ring = this.rings.get(id);
    if (!ring) {
      ring = new Map();
      this.rings.set(id, ring);
    }
    ring.set(keyIndex & 0xff, keySet);
    this.currentIndex.set(id, keyIndex & 0xff);
  }

  /** One explicit ratchet step of the key at `keyIndex` (default: current). Returns the new material. */
  async ratchet(participantId: string | undefined, keyIndex?: number): Promise<Uint8Array | undefined> {
    const id = this.ringId(participantId);
    const index = keyIndex ?? this.currentIndex.get(id) ?? 0;
    const existing = this.rings.get(id)?.get(index);
    if (!existing) return undefined;
    const next = await ratchetMaterial(existing.material);
    this.rings.get(id)?.set(index, await deriveKeySet(next));
    return next;
  }

  hasKey(participantId: string | undefined, keyIndex?: number): boolean {
    const id = this.ringId(participantId);
    return this.rings.get(id)?.has(keyIndex ?? this.currentIndex.get(id) ?? 0) ?? false;
  }

  private report(participantId: string, direction: CryptorDirection, state: E2EEState): void {
    const key = `${direction}\u0000${participantId}`;
    if (this.lastState.get(key) === state) return;
    this.lastState.set(key, state);
    this.options.onStateChanged?.(participantId, direction, state);
  }

  /**
   * Forget a participant's reported state (they left) so a rejoin reports
   * afresh. Keys stay: the app set them and may well still want them.
   */
  forget(participantId: string): void {
    this.lastState.delete(`encrypt\u0000${participantId}`);
    this.lastState.delete(`decrypt\u0000${participantId}`);
  }

  /**
   * Encrypts one outgoing frame with the local participant's current key.
   * Returns null when the frame has to be dropped: an E2EE room never gets
   * a plaintext frame from this SDK.
   */
  async encrypt(
    localParticipantId: string,
    data: Uint8Array,
    info: FrameInfo,
    ssrc: number,
    timestamp: number,
  ): Promise<Uint8Array | null> {
    if (!this.enabled || data.length === 0) return data;
    const id = this.ringId(localParticipantId);
    const keyIndex = this.currentIndex.get(id) ?? 0;
    const keySet = this.rings.get(id)?.get(keyIndex);
    if (!keySet) {
      this.report(localParticipantId, 'encrypt', 'missing_key');
      return null;
    }
    let sendCount = this.sendCounts.get(ssrc);
    if (sendCount === undefined) {
      sendCount = Math.floor(Math.random() * 0xffff);
    }
    this.sendCounts.set(ssrc, sendCount + 1);
    try {
      const out = await encryptFrame(data, info, keySet, keyIndex, makeIv(ssrc, timestamp, sendCount));
      this.report(localParticipantId, 'encrypt', 'ok');
      return out;
    } catch {
      this.report(localParticipantId, 'encrypt', 'encrypt_failed');
      return null;
    }
  }

  /**
   * Decrypts one incoming frame from `participantId`. On failure tries up
   * to `ratchetWindow` forward ratchets of the key at the frame's index and
   * adopts the first that works. Returns null to drop.
   */
  async decrypt(participantId: string, data: Uint8Array, info: FrameInfo): Promise<Uint8Array | null> {
    if (!this.enabled || data.length === 0) return data;
    const parsed = parseEncryptedFrame(data, info);
    if (!parsed) {
      this.report(participantId, 'decrypt', 'decrypt_failed');
      return null;
    }
    const id = this.ringId(participantId);
    const keySet = this.rings.get(id)?.get(parsed.keyIndex);
    if (!keySet) {
      this.report(participantId, 'decrypt', 'missing_key');
      return null;
    }
    try {
      const out = await decryptParsedFrame(parsed, keySet);
      this.report(participantId, 'decrypt', 'ok');
      return out;
    } catch {
      // fall through to the ratchet window
    }
    let material = keySet.material;
    for (let attempt = 0; attempt < this.ratchetWindow; attempt++) {
      material = await ratchetMaterial(material);
      const candidate = await deriveKeySet(material);
      try {
        const out = await decryptParsedFrame(parsed, candidate);
        this.rings.get(id)?.set(parsed.keyIndex, candidate);
        this.options.onKeyRatcheted?.(this.options.sharedKey ? undefined : participantId, parsed.keyIndex, material);
        this.report(participantId, 'decrypt', 'ok');
        return out;
      } catch {
        // next step
      }
    }
    this.report(participantId, 'decrypt', 'decrypt_failed');
    return null;
  }
}
