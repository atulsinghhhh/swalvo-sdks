import { Swalvo, createSwalvo } from '../src/index';

/**
 * `@swalvo/live` is a facade, so the interesting behaviour is which
 * clients it constructs, which it doesn't, and whether it fails early with
 * a useful message when the credentials can't possibly work together.
 *
 * The underlying `@swalvo/rtc` and `@swalvo/chat` clients have suites
 * of their own. Nothing here re-tests them.
 */

// A syntactically valid RTC token. createRTCClient decodes it client-side
// (never verifies it), so it does at least have to parse as a JWT and carry
// the claims that decode reads: `rid`/`rnm` for the room check, `exp` to
// fail fast on an already-expired token.
function fakeRtcToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      rid: 'room_123',
      rnm: 'demo-room',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

/**
 * @swalvo/chat decodes the token client-side, never verifies it, purely
 * to fail fast on an expired one. So the fixture needs whatever that decode
 * actually reads: `sub`, `pid`, and a numeric `exp`.
 */
function fakeChatToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'alice',
      pid: 'project-1',
      aud: 'raven-chat',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('Swalvo — credential validation', () => {
  it('refuses a token without an endpoint', () => {
    // Always a mistake, and catching it here beats a baffling connection
    // failure at join() time.
    expect(() => new Swalvo({ token: fakeRtcToken() })).toThrow(/both `token` and `endpoint`/);
  });

  it('refuses an endpoint without a token', () => {
    expect(() => new Swalvo({ endpoint: 'wss://sfu.example' })).toThrow(/both `token` and `endpoint`/);
  });

  it('refuses an instance with no credentials at all', () => {
    // An instance like that can't do anything at all. Failing at
    // construction is far clearer than a null reference later on.
    expect(() => new Swalvo({})).toThrow(/at least one credential/);
  });

  it('names all three valid shapes in the error, so the fix is obvious', () => {
    expect(() => new Swalvo({})).toThrow(/chatToken/);
  });
});

describe('Swalvo — RTC only', () => {
  const config = { token: fakeRtcToken(), endpoint: 'wss://sfu.example' };

  it('constructs an RTC client', () => {
    expect(new Swalvo(config).hasRtc).toBe(true);
  });

  it('constructs no chat client', () => {
    const swalvo = new Swalvo(config);
    expect(swalvo.hasChat).toBe(false);
    expect(swalvo.chat).toBeUndefined();
  });
});

describe('Swalvo — messaging only', () => {
  const config = { chatToken: fakeChatToken(), chatApiUrl: 'https://api.example' };

  it('constructs a chat client without any RTC credentials', () => {
    const swalvo = new Swalvo(config);
    expect(swalvo.hasChat).toBe(true);
    expect(swalvo.chat).toBeDefined();
  });

  it('constructs no RTC client', () => {
    const swalvo = new Swalvo(config);
    expect(swalvo.hasRtc).toBe(false);
    expect(swalvo.rtc).toBeUndefined();
  });

  it('refuses join() with an error that explains why, not a null reference', async () => {
    const swalvo = new Swalvo(config);
    await expect(swalvo.join('room_123')).rejects.toThrow(/no RTC credentials/);
  });

  it('points at the fix in the same message', async () => {
    const swalvo = new Swalvo(config);
    await expect(swalvo.join('room_123')).rejects.toThrow(/`token` and `endpoint`/);
  });

  it('disposes cleanly with nothing to tear down on the RTC side', async () => {
    await expect(new Swalvo(config).dispose()).resolves.toBeUndefined();
  });
});

describe('Swalvo — both planes', () => {
  const config = {
    token: fakeRtcToken(),
    endpoint: 'wss://sfu.example',
    chatToken: fakeChatToken(),
    chatApiUrl: 'https://api.example',
  };

  it('constructs both clients from one config', () => {
    const swalvo = new Swalvo(config);
    expect(swalvo.hasRtc).toBe(true);
    expect(swalvo.hasChat).toBe(true);
  });

  it('exposes the real underlying clients, not wrappers', () => {
    // The whole premise of the package. swalvo.chat IS a ChatClient, so
    // every method the chat docs describe is right there, no re-export.
    const swalvo = new Swalvo(config);
    expect(typeof swalvo.chat?.sendMessage).toBe('function');
    expect(typeof swalvo.chat?.connect).toBe('function');
    expect(typeof swalvo.rtc?.join).toBe('function');
  });

  it('reports no room before joining', () => {
    expect(new Swalvo(config).room).toBeUndefined();
  });
});

describe('createSwalvo', () => {
  it('is the same thing as the constructor', () => {
    const swalvo = createSwalvo({ chatToken: fakeChatToken(), chatApiUrl: 'https://api.example' });
    expect(swalvo).toBeInstanceOf(Swalvo);
  });
});

describe('deprecated Raven* aliases', () => {
  it('are the same values as the Swalvo* names', async () => {
    const live = await import('../src/index');
    expect(live.Raven).toBe(live.Swalvo);
    expect(live.createRaven).toBe(live.createSwalvo);
    expect(live.isRavenChatError).toBe(live.isSwalvoChatError);
    const client = live.createRaven({ chatToken: fakeChatToken(), chatApiUrl: 'https://api.example' });
    expect(client).toBeInstanceOf(live.Raven);
    expect(client).toBeInstanceOf(live.Swalvo);
  });
});
