import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DataEnvelopeError,
  decodeDataMessage,
  decodeUtf8Strict,
  encodeDataEnvelope,
} from '../src/internal/data-envelope';

/**
 * The data messages v2 envelope (docs/architecture/phase7-contracts.md
 * §1.2-1.3), checked against the shared vectors every SDK runs:
 * docs/architecture/data-envelope-vectors.json.
 */

interface EncodeCase {
  name: string;
  input: { topic: string; destinationIdentities: string[]; payloadHex: string };
  expectedHex?: string;
}

interface DecodeCase {
  name: string;
  inputHex: string;
  expected: { legacy: boolean; senderIdentity: string | null; topic: string | null; payloadHex: string };
}

const VECTORS_PATH = join(__dirname, '..', '..', '..', 'docs', 'architecture', 'data-envelope-vectors.json');
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
  encode: EncodeCase[];
  encodeErrors: EncodeCase[];
  decode: DecodeCase[];
};

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('data envelope vectors', () => {
  it('has cases for every section', () => {
    expect(vectors.encode.length).toBeGreaterThan(0);
    expect(vectors.encodeErrors.length).toBeGreaterThan(0);
    expect(vectors.decode.length).toBeGreaterThan(0);
  });

  it.each(vectors.encode.map((c) => [c.name, c] as const))('encodes: %s', (_name, c) => {
    const out = encodeDataEnvelope(fromHex(c.input.payloadHex), {
      topic: c.input.topic,
      destinationIdentities: c.input.destinationIdentities,
    });
    expect(toHex(out)).toBe(c.expectedHex);
  });

  it.each(vectors.encodeErrors.map((c) => [c.name, c] as const))('rejects: %s', (_name, c) => {
    expect(() =>
      encodeDataEnvelope(fromHex(c.input.payloadHex), {
        topic: c.input.topic,
        destinationIdentities: c.input.destinationIdentities,
      }),
    ).toThrow(DataEnvelopeError);
  });

  it.each(vectors.decode.map((c) => [c.name, c] as const))('decodes: %s', (_name, c) => {
    const decoded = decodeDataMessage(fromHex(c.inputHex));
    expect(decoded.legacy).toBe(c.expected.legacy);
    expect(decoded.senderIdentity ?? null).toBe(c.expected.senderIdentity);
    expect(decoded.topic ?? null).toBe(c.expected.topic);
    expect(toHex(decoded.payload)).toBe(c.expected.payloadHex);
  });
});

describe('decodeUtf8Strict', () => {
  it('matches TextDecoder on valid text', () => {
    for (const text of ['', 'hello', 'zoë', '佐藤', 'chat/💬', '\u0000\u007f\u0080߿ࠀ￿']) {
      expect(decodeUtf8Strict(new TextEncoder().encode(text))).toBe(text);
    }
  });

  it.each([
    ['lone continuation', ' 80'],
    ['overlong 2-byte', 'c0af'],
    ['overlong 3-byte', 'e080af'],
    ['surrogate', 'eda080'],
    ['above U+10FFFF', 'f4908080'],
    ['truncated 3-byte', 'e282'],
    ['invalid lead', 'ff'],
  ])('rejects %s', (_name, hex) => {
    expect(decodeUtf8Strict(fromHex(hex.trim()))).toBeUndefined();
  });
});
