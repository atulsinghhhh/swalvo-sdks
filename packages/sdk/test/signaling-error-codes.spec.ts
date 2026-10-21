import { SwalvoAdapter } from '../src/internal/sfu/swalvo-adapter';
import { createLogger } from '../src/logger';
import { FATAL_ERROR_CODES } from '../src/internal/signaling/protocol';
import type { SignalingErrorCode } from '../src/internal/signaling/protocol';
import { FakeWebSocket, fakeToken, flush, installFakeWebRTC } from './helpers/fake-webrtc';

const ENDPOINT = 'ws://localhost:4000/v1/rtc';

const TOKEN = fakeToken({
  jti: 'rtc-token-1',
  sub: 'alice',
  pid: 'project-1',
  env: 'DEVELOPMENT',
  rid: 'room-1',
  rnm: 'demo-room',
  perms: {
    join: true,
    subscribe: true,
    publish: true,
    publishAudio: true,
    publishVideo: true,
    publishData: true,
  },
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
  aud: 'raven-rtc',
  iss: 'raven',
});

/**
 * Drives one server `error` frame through a connecting adapter and returns
 * whatever the developer's `await connect()` rejects with.
 *
 * Going through the adapter rather than calling the private mapper directly
 * is the point: this asserts on what an application actually catches, which
 * is the whole contract these codes exist to provide.
 */
async function errorFromFrame(code: string, message = 'server said no'): Promise<{ code: string }> {
  const adapter = new SwalvoAdapter(createLogger('silent'), false);
  const connecting = adapter.connect(ENDPOINT, TOKEN);

  await flush();
  FakeWebSocket.latest.receive({ type: 'error', code, message });

  return connecting.then(
    () => {
      throw new Error(`expected connect() to reject for ${code}`);
    },
    (err: { code: string }) => err,
  );
}

describe('signaling error codes reach the developer as typed errors', () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = installFakeWebRTC();
  });

  afterEach(() => {
    teardown();
  });

  it('maps USAGE_LIMIT_EXCEEDED to its own code, not SIGNALING_ERROR', async () => {
    // The one join failure whose remedy is commercial. An application has
    // to be able to show a billing prompt instead of a retry button, and
    // it cannot do that if this arrives as a generic signaling failure.
    const error = await errorFromFrame('USAGE_LIMIT_EXCEEDED', 'out of included minutes');

    expect(error.code).toBe('USAGE_LIMIT_EXCEEDED');
    expect(error.code).not.toBe('SIGNALING_ERROR');
  });

  it('preserves the server message for USAGE_LIMIT_EXCEEDED', async () => {
    const error = await errorFromFrame(
      'USAGE_LIMIT_EXCEEDED',
      'This account has used all of its included Swalvo minutes',
    );

    expect((error as unknown as Error).message).toContain('included Swalvo minutes');
  });

  it('maps TOKEN_REVOKED to its own code, distinct from TOKEN_EXPIRED', async () => {
    // Same remedy (mint a new token), different cause, and a UI may well
    // want to word the two differently.
    const revoked = await errorFromFrame('TOKEN_REVOKED', 'this RTC token has been revoked');
    const expired = await errorFromFrame('TOKEN_EXPIRED', 'RTC token has expired');

    expect(revoked.code).toBe('TOKEN_REVOKED');
    expect(expired.code).toBe('TOKEN_EXPIRED');
  });

  it('still maps an unrecognized code to SIGNALING_ERROR', async () => {
    // The default has to stay a default: a code this SDK version predates
    // must not throw or come through as undefined.
    const error = await errorFromFrame('SOME_FUTURE_CODE');

    expect(error.code).toBe('SIGNALING_ERROR');
  });
});

describe('FATAL_ERROR_CODES', () => {
  it('treats a usage limit as terminal rather than retrying against a wall', () => {
    // Unlike RATE_LIMITED there is no window to wait out, so backoff would
    // just burn the attempt budget.
    expect(FATAL_ERROR_CODES.has('USAGE_LIMIT_EXCEEDED')).toBe(true);
    expect(FATAL_ERROR_CODES.has('RATE_LIMITED')).toBe(false);
  });

  it('treats a revoked token as terminal', () => {
    // Reconnecting re-presents the same dead credential.
    expect(FATAL_ERROR_CODES.has('TOKEN_REVOKED')).toBe(true);
  });

  it('keeps retryable transport failures retryable', () => {
    const retryable: SignalingErrorCode[] = ['NO_RTC_CAPACITY', 'RTC_SERVER_UNREACHABLE', 'NEGOTIATION_GLARE'];
    for (const code of retryable) {
      expect(FATAL_ERROR_CODES.has(code)).toBe(false);
    }
  });
});
