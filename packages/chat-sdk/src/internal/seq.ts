import type { ChatMessage, LinkPreview } from '../types';

/**
 * `seq` and `eventSeq` travel as decimal strings because they are 64-bit
 * counters (§1), and a JS number silently stops being exact at 2^53.
 * Everything that compares or does arithmetic on them goes through here,
 * as `bigint`, so nobody is ever tempted to `Number()` one.
 */

/** Parses a seq off the wire. Accepts a number from a server that sends one, rejects anything that is not a non-negative integer. */
export function parseSeq(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

/**
 * Orders two seqs: negative when `a` comes first, positive when `b` does,
 * 0 when equal. An unparseable or missing value sorts first, so a message
 * from a server older than Phase 3 never jumps ahead of a sequenced one.
 *
 * String comparison is the mistake this exists to prevent: `"10" < "9"`.
 */
export function compareSeq(a: string | null | undefined, b: string | null | undefined): number {
  const left = parseSeq(a);
  const right = parseSeq(b);
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Brings a message off the wire into the shape this SDK documents.
 *
 * Every path a message arrives by — the socket, history, catch-up, a send
 * ack, search, pins — goes through this, so a field the server added in
 * one place cannot be missing in another:
 *
 * - `seq` becomes a string whatever the server sent;
 * - `metadata.linkPreview` is lifted to `linkPreview`, so a renderer does
 *   not need to know where the unfurl is stored;
 * - `mentions` defaults to `[]`.
 *
 * It never invents server facts. A message without a `seq` keeps none.
 */
export function normalizeMessage<T extends Partial<ChatMessage>>(raw: T): T & ChatMessage {
  const message = { ...raw } as T & ChatMessage;
  const seq = parseSeq((raw as { seq?: unknown }).seq);
  if (seq !== null) {
    message.seq = seq.toString();
  } else {
    delete (message as { seq?: unknown }).seq;
  }
  if (!Array.isArray(message.mentions)) {
    message.mentions = [];
  }
  if (message.linkPreview === undefined) {
    message.linkPreview = readLinkPreview(message.metadata);
  }
  return message;
}

function readLinkPreview(metadata: unknown): LinkPreview | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const preview = (metadata as Record<string, unknown>).linkPreview;
  if (!preview || typeof preview !== 'object') return null;
  const url = (preview as Record<string, unknown>).url;
  if (typeof url !== 'string' || url.length === 0) return null;
  // Copied field by field rather than passed through, so whatever else the
  // server's unfurler stores alongside stays out of a documented type.
  const pick = (key: string) => {
    const value = (preview as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    url,
    title: pick('title'),
    description: pick('description'),
    imageUrl: pick('imageUrl'),
    siteName: pick('siteName'),
  };
}
