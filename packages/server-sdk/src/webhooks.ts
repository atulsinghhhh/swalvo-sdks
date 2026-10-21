import { createHmac, timingSafeEqual } from 'node:crypto';
import { SwalvoError } from './errors';

/** The header Swalvo signs every webhook delivery with. */
export const SWALVO_SIGNATURE_HEADER = 'swalvo-signature';
/**
 * The original name of the signature header. Deliveries keep carrying it
 * alongside `swalvo-signature` (same value). legacy: kept for wire compatibility.
 */
export const LEGACY_WEBHOOK_SIGNATURE_HEADER = 'raven-signature';
/** Signature headers in the order `verifyWebhook` looks for them when handed a headers object. */
export const WEBHOOK_SIGNATURE_HEADERS = [SWALVO_SIGNATURE_HEADER, LEGACY_WEBHOOK_SIGNATURE_HEADER] as const;
/**
 * @deprecated Pass the whole headers object to `verifyWebhook` instead (it
 * reads `swalvo-signature`, then `raven-signature`), or use
 * {@link SWALVO_SIGNATURE_HEADER}. Still `'raven-signature'`, unchanged.
 */
export const WEBHOOK_SIGNATURE_HEADER = LEGACY_WEBHOOK_SIGNATURE_HEADER;
/** Default replay window: a delivery signed more than this long ago (or ahead) is rejected. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Request headers, as Node (`req.headers`), Express or the Fetch API
 * (`request.headers`) hand them to you.
 */
export type WebhookHeaders =
  { get(name: string): string | null | undefined } | Record<string, string | readonly string[] | undefined>;

export interface VerifyWebhookOptions {
  /** How far the signed timestamp may be from now, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** "Now", in Unix seconds. For tests; defaults to the system clock. */
  now?: number;
}

/** A verified webhook delivery. `type` names the event; the rest depends on it. */
export interface WebhookEvent {
  id?: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Verifies a webhook delivery and returns the parsed event, or throws a
 * `SwalvoError` (`RAVEN_WEBHOOK_INVALID_SIGNATURE`,
 * `RAVEN_WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE` or `RAVEN_WEBHOOK_INVALID_PAYLOAD`).
 *
 * The signature header (`swalvo-signature`; deliveries also carry the
 * same value as the legacy `raven-signature`) is `t=<unix seconds>,v1=<hex>`, where the
 * hex is HMAC-SHA256 of `"<t>.<raw body>"` with your endpoint's signing
 * secret. Every `v1=` value in the header is tried, so a header carrying
 * more than one signature verifies when any of them matches. Pass several
 * secrets while you rotate one.
 *
 * Pass the body exactly as it arrived: the raw bytes or string, never a
 * re-serialized object, or the signature cannot match. In Express, use
 * `express.raw({ type: 'application/json' })` on the webhook route.
 *
 * Pass either the request's headers (the `swalvo-signature` header is used,
 * falling back to `raven-signature`) or the signature header's value.
 *
 * ```ts
 * const event = verifyWebhook(req.body, req.headers, process.env.SWALVO_WEBHOOK_SECRET!);
 * ```
 */
export function verifyWebhook<T extends WebhookEvent = WebhookEvent>(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined | WebhookHeaders,
  secret: string | readonly string[],
  options: VerifyWebhookOptions = {},
): T {
  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  const secrets = (typeof secret === 'string' ? [secret] : [...secret]).filter((value) => value.length > 0);
  if (secrets.length === 0) {
    throw new SwalvoError('verifyWebhook needs your webhook signing secret', { code: 'RAVEN_INVALID_CONFIG' });
  }

  const { timestamp, signatures } = parseSignatureHeader(resolveSignatureHeader(signatureHeader) ?? '');
  if (timestamp === undefined || signatures.length === 0) {
    throw invalidSignature(
      'The webhook signature header (swalvo-signature or raven-signature) is missing or malformed',
    );
  }

  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    throw new SwalvoError(`The webhook timestamp is more than ${tolerance}s from now; possible replay`, {
      code: 'RAVEN_WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE',
    });
  }

  const matched = secrets.some((candidate) => {
    const expected = Buffer.from(createHmac('sha256', candidate).update(`${timestamp}.${body}`).digest('hex'), 'utf8');
    // Every signature is compared, without stopping early on a match, and
    // each comparison is constant-time.
    let ok = false;
    for (const provided of signatures) {
      const providedBuffer = Buffer.from(provided, 'utf8');
      if (providedBuffer.length === expected.length && timingSafeEqual(providedBuffer, expected)) {
        ok = true;
      }
    }
    return ok;
  });
  if (!matched) {
    throw invalidSignature('The webhook signature does not match');
  }

  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch (error) {
    throw new SwalvoError('The webhook body is not valid JSON', {
      code: 'RAVEN_WEBHOOK_INVALID_PAYLOAD',
      cause: error,
    });
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new SwalvoError('The webhook body is not a JSON object', { code: 'RAVEN_WEBHOOK_INVALID_PAYLOAD' });
  }
  return event as T;
}

/** Picks the signature out of a headers object: `swalvo-signature` first, then `raven-signature`. */
function resolveSignatureHeader(input: string | null | undefined | WebhookHeaders): string | undefined {
  if (input === null || input === undefined || typeof input === 'string') {
    return input ?? undefined;
  }
  for (const name of WEBHOOK_SIGNATURE_HEADERS) {
    const value = readHeader(input, name);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null | undefined }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | readonly string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) {
      const value = record[key];
      return Array.isArray(value) ? value.join(',') : (value as string | undefined);
    }
  }
  return undefined;
}

function parseSignatureHeader(header: string): { timestamp?: number; signatures: string[] } {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && value.length > 0) {
      signatures.push(value);
    }
  }
  return { timestamp, signatures };
}

function invalidSignature(message: string): SwalvoError {
  return new SwalvoError(message, { code: 'RAVEN_WEBHOOK_INVALID_SIGNATURE' });
}
