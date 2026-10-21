import { createHmac } from 'node:crypto';
import { SwalvoError, verifyWebhook } from '../src';

const SECRET = 'whsec_test';
const NOW = 1_800_000_000;
const BODY = JSON.stringify({ id: 'evt_1', type: 'room.participant_joined', data: { identity: 'alice' } });

/** Mirrors apps/api/src/modules/webhooks/webhook-signature.util.ts `signWebhookPayload`. */
function sign(body: string, secret = SECRET, t = NOW): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof SwalvoError ? error.code : 'not-a-swalvo-error';
  }
  return undefined;
}

describe('verifyWebhook', () => {
  it('returns the parsed event for a valid signature, from a string or bytes', () => {
    expect(verifyWebhook(BODY, sign(BODY), SECRET, { now: NOW })).toEqual(JSON.parse(BODY));
    expect(verifyWebhook(Buffer.from(BODY), sign(BODY), SECRET, { now: NOW }).type).toBe('room.participant_joined');
  });

  it('rejects a tampered body or the wrong secret', () => {
    expect(codeOf(() => verifyWebhook(BODY.replace('alice', 'mallory'), sign(BODY), SECRET, { now: NOW }))).toBe(
      'RAVEN_WEBHOOK_INVALID_SIGNATURE',
    );
    expect(codeOf(() => verifyWebhook(BODY, sign(BODY, 'other'), SECRET, { now: NOW }))).toBe(
      'RAVEN_WEBHOOK_INVALID_SIGNATURE',
    );
  });

  it('rejects a missing or malformed header', () => {
    for (const header of [undefined, null, '', 'garbage', `t=${NOW}`, 'v1=abc', `t=soon,v1=abc`]) {
      expect(codeOf(() => verifyWebhook(BODY, header, SECRET, { now: NOW }))).toBe('RAVEN_WEBHOOK_INVALID_SIGNATURE');
    }
  });

  it('enforces the timestamp tolerance (default 300 s), in both directions', () => {
    expect(() => verifyWebhook(BODY, sign(BODY, SECRET, NOW - 300), SECRET, { now: NOW })).not.toThrow();
    expect(codeOf(() => verifyWebhook(BODY, sign(BODY, SECRET, NOW - 301), SECRET, { now: NOW }))).toBe(
      'RAVEN_WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE',
    );
    expect(codeOf(() => verifyWebhook(BODY, sign(BODY, SECRET, NOW + 301), SECRET, { now: NOW }))).toBe(
      'RAVEN_WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE',
    );
    expect(() =>
      verifyWebhook(BODY, sign(BODY, SECRET, NOW - 1000), SECRET, { now: NOW, toleranceSeconds: 1000 }),
    ).not.toThrow();
  });

  it('accepts a header with several v1 signatures when any one matches', () => {
    const header = `t=${NOW},v1=${'0'.repeat(64)},${sign(BODY).split(',')[1]}`;
    expect(verifyWebhook(BODY, header, SECRET, { now: NOW }).id).toBe('evt_1');
  });

  it('accepts any of several secrets, for rotation', () => {
    expect(verifyWebhook(BODY, sign(BODY, 'new'), ['old', 'new'], { now: NOW }).id).toBe('evt_1');
  });

  it('refuses to run without a secret, and reports a body that is not a JSON object', () => {
    expect(codeOf(() => verifyWebhook(BODY, sign(BODY), '', { now: NOW }))).toBe('RAVEN_INVALID_CONFIG');
    expect(codeOf(() => verifyWebhook('not json', sign('not json'), SECRET, { now: NOW }))).toBe(
      'RAVEN_WEBHOOK_INVALID_PAYLOAD',
    );
    expect(codeOf(() => verifyWebhook('[1]', sign('[1]'), SECRET, { now: NOW }))).toBe('RAVEN_WEBHOOK_INVALID_PAYLOAD');
  });
});

describe('verifyWebhook with a headers object', () => {
  const signature = sign(BODY);

  it('reads swalvo-signature first', () => {
    const headers = { 'swalvo-signature': signature, 'raven-signature': 't=1,v1=bad' };
    expect(verifyWebhook(BODY, headers, SECRET, { now: NOW }).type).toBe('room.participant_joined');
  });

  it('falls back to the legacy raven-signature header', () => {
    expect(verifyWebhook(BODY, { 'raven-signature': signature }, SECRET, { now: NOW }).type).toBe(
      'room.participant_joined',
    );
  });

  it('accepts a Fetch API Headers object and matches header names case-insensitively', () => {
    expect(verifyWebhook(BODY, new Headers({ 'Swalvo-Signature': signature }), SECRET, { now: NOW }).id).toBe('evt_1');
    expect(verifyWebhook(BODY, { 'Raven-Signature': signature }, SECRET, { now: NOW }).id).toBe('evt_1');
  });

  it('rejects when neither header is present', () => {
    expect(codeOf(() => verifyWebhook(BODY, { 'content-type': 'application/json' }, SECRET, { now: NOW }))).toBe(
      'RAVEN_WEBHOOK_INVALID_SIGNATURE',
    );
  });
});

describe('deprecated Raven* aliases', () => {
  it('are the same values as the Swalvo* names', async () => {
    const sdk = await import('../src');
    expect(sdk.Raven).toBe(sdk.Swalvo);
    expect(sdk.RavenError).toBe(sdk.SwalvoError);
    expect(sdk.isRavenError).toBe(sdk.isSwalvoError);
    expect(new sdk.RavenError('x')).toBeInstanceOf(sdk.SwalvoError);
    expect(sdk.WEBHOOK_SIGNATURE_HEADER).toBe('raven-signature');
    expect(sdk.SWALVO_SIGNATURE_HEADER).toBe('swalvo-signature');
  });
});
