/**
 * The E2EE frame format and key schedule (docs/architecture/phase5-contracts.md
 * §3), as pure functions over WebCrypto.
 *
 * Shared by the main thread (passphrase derivation, explicit ratchets) and
 * the transform worker (per-frame encrypt/decrypt). Nothing here touches
 * the DOM or WebRTC, so the same code runs in a Worker, in jsdom and in
 * Node, and the test vectors in docs/architecture/e2ee-vectors.json are
 * produced by exactly this file.
 *
 * # Key schedule (binding for every platform)
 *
 * ```
 * material₀ = PBKDF2-HMAC-SHA256(utf8(passphrase), utf8("LivqenoE2EE:" + roomId), 100000, 32 bytes)   // shared-passphrase mode
 *          or the raw bytes an app hands setKey()                                                  // per-participant mode
 * aesKey    = HKDF-SHA256(ikm = material, salt = utf8("LivqenoRatchet"), info = 128 zero bytes, 16 bytes)
 * material' = HKDF-SHA256(ikm = material, salt = utf8("LivqenoRatchet"), info = 128 zero bytes, 32 bytes)   // ratchet
 * ```
 *
 * The HKDF step is what libwebrtc's frame cryptor does when its
 * `KeyProviderOptions` say `ratchetSalt: "LivqenoRatchet"` and
 * `keyDerivationAlgorithm: HKDF` (128 zero bytes of info is its constant),
 * so flutter_webrtc and the native SDKs hand `material` to `setKey` and
 * arrive at the same AES key without any code of their own.
 *
 * # Frame
 *
 * ```
 * [ clear header ][ AES-GCM-128 ciphertext ][ 16-byte tag ][ 12-byte IV ][ 0x0c ][ keyIndex ]
 * ```
 *
 * AAD is the clear header. For H.264 everything after the header is
 * RBSP-escaped (emulation prevention bytes inserted) so the encrypted bytes
 * can never contain a start code the packetizer would split on.
 */

export const E2EE_PASSPHRASE_SALT_PREFIX = 'LivqenoE2EE:';
export const E2EE_RATCHET_SALT = 'LivqenoRatchet';
export const E2EE_PBKDF2_ITERATIONS = 100_000;
export const E2EE_IV_LENGTH = 12;
export const E2EE_TAG_LENGTH = 16;
export const E2EE_TRAILER_LENGTH = 2;
export const E2EE_DEFAULT_RATCHET_WINDOW = 8;
/** HKDF `info`: 128 zero bytes, libwebrtc's constant. */
const HKDF_INFO = new Uint8Array(128);

export type E2EECodec = 'vp8' | 'vp9' | 'av1' | 'h264' | 'opus';

/** Raw key material (32 bytes from the passphrase, or whatever the app supplied) and the AES key derived from it. */
export interface E2EEKeySet {
  material: Uint8Array;
  key: CryptoKey;
}

function subtle(): SubtleCrypto {
  const value = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!value) {
    throw new Error('WebCrypto (crypto.subtle) is unavailable; end-to-end encryption needs a secure context');
  }
  return value;
}

const encoder = new TextEncoder();

function bytes(view: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  // Copy into a fresh ArrayBuffer-backed view: WebCrypto's typings (and some
  // engines) reject SharedArrayBuffer-backed or offset views.
  const source = view instanceof Uint8Array ? view : new Uint8Array(view);
  const out = new Uint8Array(new ArrayBuffer(source.byteLength));
  out.set(source);
  return out;
}

/** Shared-passphrase mode: passphrase → 32 bytes of key material. */
export async function deriveMaterialFromPassphrase(passphrase: string, roomId: string): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', bytes(encoder.encode(passphrase)), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    {
      name: 'PBKDF2',
      salt: bytes(encoder.encode(E2EE_PASSPHRASE_SALT_PREFIX + roomId)),
      iterations: E2EE_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    base,
    256,
  );
  return new Uint8Array(bits);
}

async function hkdf(material: Uint8Array, lengthBits: number): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', bytes(material), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: bytes(encoder.encode(E2EE_RATCHET_SALT)), info: HKDF_INFO },
    base,
    lengthBits,
  );
  return new Uint8Array(bits);
}

/** The 16 raw AES-128 key bytes for a piece of material. Exposed for the test vectors. */
export function deriveAesKeyBytes(material: Uint8Array): Promise<Uint8Array> {
  return hkdf(material, 128);
}

/** One ratchet step: the next 32 bytes of material. */
export function ratchetMaterial(material: Uint8Array): Promise<Uint8Array> {
  return hkdf(material, 256);
}

export async function deriveKeySet(material: Uint8Array): Promise<E2EEKeySet> {
  const raw = await deriveAesKeyBytes(material);
  const key = await subtle().importKey('raw', bytes(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { material: bytes(material), key };
}

// --- H.264 helpers --------------------------------------------------------

/** Offsets of the first byte *after* each Annex-B start code (00 00 01 or 00 00 00 01). */
export function findNaluIndices(data: Uint8Array): number[] {
  const indices: number[] = [];
  let i = 0;
  while (i + 3 <= data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      indices.push(i + 3);
      i += 3;
    } else {
      i += 1;
    }
  }
  return indices;
}

const NALU_SLICE = 1;
const NALU_IDR = 5;

/**
 * Clear bytes for an H.264 frame: everything up to and including the first
 * byte after the first slice NALU's header (offset + 2), so SPS/PPS/SEI stay
 * readable and the SFU can still see an IDR. 0 when no slice is found,
 * matching libwebrtc.
 */
export function h264UnencryptedBytes(data: Uint8Array): number {
  for (const index of findNaluIndices(data)) {
    if (index >= data.length) continue;
    const type = data[index] & 0x1f;
    if (type === NALU_SLICE || type === NALU_IDR) {
      return Math.min(index + 2, data.length);
    }
  }
  return 0;
}

/** §3.2's table. */
export function unencryptedBytes(codec: E2EECodec, data: Uint8Array, isKeyFrame: boolean): number {
  switch (codec) {
    case 'opus':
      return Math.min(1, data.length);
    case 'vp8':
      return Math.min(isKeyFrame ? 10 : 3, data.length);
    case 'h264':
      return h264UnencryptedBytes(data);
    case 'vp9':
    case 'av1':
    default:
      return 0;
  }
}

export function needsRbspUnescaping(data: Uint8Array): boolean {
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) return true;
  }
  return false;
}

/** Strips emulation prevention bytes (00 00 03 → 00 00). */
export function parseRbsp(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length;) {
    if (data.length - i >= 3 && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      out.push(0, 0);
      i += 3;
    } else {
      out.push(data[i]);
      i += 1;
    }
  }
  return new Uint8Array(out);
}

/** Inserts emulation prevention bytes after any two zeros followed by a byte ≤ 3. */
export function writeRbsp(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of data) {
    if (byte <= 3 && zeros >= 2) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

// --- IV -------------------------------------------------------------------

/**
 * `ssrc(4) || timestamp(4) || counter(4)`, big-endian. The counter word is
 * libwebrtc's `timestamp − (sendCount mod 0xFFFF)`; receivers never
 * interpret any of it, they read the IV off the trailer.
 */
export function makeIv(ssrc: number, timestamp: number, sendCount: number): Uint8Array {
  const iv = new Uint8Array(E2EE_IV_LENGTH);
  const view = new DataView(iv.buffer);
  view.setUint32(0, ssrc >>> 0);
  view.setUint32(4, timestamp >>> 0);
  view.setUint32(8, (timestamp - (sendCount % 0xffff)) >>> 0);
  return iv;
}

// --- Frames ---------------------------------------------------------------

export interface FrameInfo {
  codec: E2EECodec;
  /** VP8 only: decides 10 vs 3 clear bytes. */
  isKeyFrame: boolean;
}

export async function encryptFrame(
  data: Uint8Array,
  info: FrameInfo,
  keySet: E2EEKeySet,
  keyIndex: number,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const headerLength = unencryptedBytes(info.codec, data, info.isKeyFrame);
  const header = data.subarray(0, headerLength);
  const cipher = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: bytes(iv), additionalData: bytes(header), tagLength: E2EE_TAG_LENGTH * 8 },
      keySet.key,
      bytes(data.subarray(headerLength)),
    ),
  );
  let body = new Uint8Array(cipher.length + iv.length + E2EE_TRAILER_LENGTH);
  body.set(cipher, 0);
  body.set(iv, cipher.length);
  body[cipher.length + iv.length] = iv.length;
  body[cipher.length + iv.length + 1] = keyIndex & 0xff;
  if (info.codec === 'h264') {
    body = writeRbsp(body) as Uint8Array<ArrayBuffer>;
  }
  const out = new Uint8Array(headerLength + body.length);
  out.set(header, 0);
  out.set(body, headerLength);
  return out;
}

/** What `parseEncryptedFrame` reads before any key is involved. */
export interface ParsedFrame {
  header: Uint8Array;
  iv: Uint8Array;
  keyIndex: number;
  /** Ciphertext followed by the 16-byte tag, unescaped. */
  payload: Uint8Array;
}

/** Splits a received frame. Returns undefined for anything too short to be ours. */
export function parseEncryptedFrame(data: Uint8Array, info: FrameInfo): ParsedFrame | undefined {
  if (data.length < E2EE_TRAILER_LENGTH) return undefined;
  const ivLength = data[data.length - 2];
  const keyIndex = data[data.length - 1];
  if (ivLength !== E2EE_IV_LENGTH) return undefined;
  const headerLength = unencryptedBytes(info.codec, data, info.isKeyFrame);
  if (data.length < headerLength + ivLength + E2EE_TRAILER_LENGTH + E2EE_TAG_LENGTH) return undefined;
  const header = data.subarray(0, headerLength);
  // The IV is read before unescaping, as libwebrtc does.
  const iv = data.slice(data.length - E2EE_TRAILER_LENGTH - ivLength, data.length - E2EE_TRAILER_LENGTH);
  let rest = data.subarray(headerLength);
  if (info.codec === 'h264' && needsRbspUnescaping(rest)) {
    rest = parseRbsp(rest);
  }
  const payloadLength = rest.length - ivLength - E2EE_TRAILER_LENGTH;
  if (payloadLength < E2EE_TAG_LENGTH) return undefined;
  return { header, iv, keyIndex, payload: rest.subarray(0, payloadLength) };
}

/** Decrypts a parsed frame with one key. Rejects when the tag does not verify. */
export async function decryptParsedFrame(parsed: ParsedFrame, keySet: E2EEKeySet): Promise<Uint8Array> {
  const plain = new Uint8Array(
    await subtle().decrypt(
      { name: 'AES-GCM', iv: bytes(parsed.iv), additionalData: bytes(parsed.header), tagLength: E2EE_TAG_LENGTH * 8 },
      keySet.key,
      bytes(parsed.payload),
    ),
  );
  const out = new Uint8Array(parsed.header.length + plain.length);
  out.set(parsed.header, 0);
  out.set(plain, parsed.header.length);
  return out;
}

export function toHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
