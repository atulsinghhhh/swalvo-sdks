/**
 * Data messages v2 envelope (docs/architecture/phase7-contracts.md §1.2-1.3).
 *
 * Client → SFU:
 *   0x52 0x02 | flags | topicLen | topic | destCount | destCount × (idLen | identity) | payload
 * SFU → client:
 *   0x52 0x03 | senderLen | sender | topicLen | topic | payload
 *
 * Anything else a client receives — including a delivery frame that is
 * truncated or carries invalid UTF-8 — is a legacy message: all of it is
 * the payload, with no sender and no topic. The byte-for-byte behaviour is
 * pinned by docs/architecture/data-envelope-vectors.json, which every SDK
 * tests against. Pure functions, no DOM: React Native shares them.
 */

export const DATA_MAGIC = 0x52;
export const DATA_VERSION_CLIENT = 0x02;
export const DATA_VERSION_DELIVERY = 0x03;

export const MAX_TOPIC_BYTES = 255;
export const MAX_DESTINATIONS = 64;
export const MAX_IDENTITY_BYTES = 255;
/** Payload ceilings, envelope excluded. */
export const MAX_RELIABLE_PAYLOAD_BYTES = 64 * 1024;
export const MAX_LOSSY_PAYLOAD_BYTES = 1200;

/** Thrown by `encodeDataEnvelope` for a field the envelope cannot carry. */
export class DataEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataEnvelopeError';
  }
}

export interface DataEnvelopeOptions {
  topic?: string;
  destinationIdentities?: readonly string[];
}

export interface DecodedDataMessage {
  /** True for bytes without a (valid) v2 delivery header. */
  legacy: boolean;
  /** `undefined` for legacy; `''` means the server sent it. */
  senderIdentity?: string;
  /** `undefined` for legacy; may be `''` for a v2 message without a topic. */
  topic?: string;
  payload: Uint8Array;
}

const encoder = new TextEncoder();

function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

/** Wraps `payload` in a client → SFU v2 envelope. Throws `DataEnvelopeError` on an invalid field. */
export function encodeDataEnvelope(payload: Uint8Array, options: DataEnvelopeOptions = {}): Uint8Array<ArrayBuffer> {
  const topic = utf8(options.topic ?? '');
  if (topic.byteLength > MAX_TOPIC_BYTES) {
    throw new DataEnvelopeError(`Topic is ${topic.byteLength} bytes; the limit is ${MAX_TOPIC_BYTES}`);
  }
  const destinations = options.destinationIdentities ?? [];
  if (destinations.length > MAX_DESTINATIONS) {
    throw new DataEnvelopeError(`${destinations.length} destinations; the limit is ${MAX_DESTINATIONS}`);
  }
  const ids = destinations.map((identity) => {
    const bytes = utf8(identity);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IDENTITY_BYTES) {
      throw new DataEnvelopeError(`Destination identity must be 1-${MAX_IDENTITY_BYTES} bytes`);
    }
    return bytes;
  });

  const size = 4 + topic.byteLength + 1 + ids.reduce((sum, id) => sum + 1 + id.byteLength, 0) + payload.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  out[offset++] = DATA_MAGIC;
  out[offset++] = DATA_VERSION_CLIENT;
  out[offset++] = 0; // flags: all reserved
  out[offset++] = topic.byteLength;
  out.set(topic, offset);
  offset += topic.byteLength;
  out[offset++] = ids.length;
  for (const id of ids) {
    out[offset++] = id.byteLength;
    out.set(id, offset);
    offset += id.byteLength;
  }
  out.set(payload, offset);
  return out;
}

/** Reads what the SFU delivered. Never throws: anything malformed is legacy. */
export function decodeDataMessage(bytes: Uint8Array): DecodedDataMessage {
  const legacy: DecodedDataMessage = { legacy: true, payload: bytes };
  if (bytes.byteLength < 2 || bytes[0] !== DATA_MAGIC || bytes[1] !== DATA_VERSION_DELIVERY) {
    return legacy;
  }
  let offset = 2;
  const readString = (): string | undefined => {
    if (offset >= bytes.byteLength) return undefined;
    const length = bytes[offset++];
    if (offset + length > bytes.byteLength) return undefined;
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return decodeUtf8Strict(slice);
  };
  const senderIdentity = readString();
  if (senderIdentity === undefined) return legacy;
  const topic = readString();
  if (topic === undefined) return legacy;
  return { legacy: false, senderIdentity, topic, payload: bytes.subarray(offset) };
}

/**
 * Strict UTF-8 → string, or `undefined` for malformed input (overlongs,
 * surrogates and truncated sequences included). Hand-rolled rather than
 * `TextDecoder({ fatal: true })` so it behaves the same on every engine the
 * SDK ships to, Hermes included.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let cp: number;
    let need: number;
    let min: number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = b0 & 0x1f;
      need = 1;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = b0 & 0x0f;
      need = 2;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = b0 & 0x07;
      need = 3;
      min = 0x10000;
    } else {
      return undefined;
    }
    if (i + need >= bytes.length) return undefined;
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if ((b & 0xc0) !== 0x80) return undefined;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}
