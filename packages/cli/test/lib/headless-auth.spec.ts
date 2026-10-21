import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsFromEnv, writeCredentials, TOKEN_ENV_VAR } from '../../src/lib/auth-store.js';
import { API_URL_ENV_VAR, readCliConfig, updateCliConfig, writeCliConfig } from '../../src/lib/cli-config.js';
import { requireCredentials } from '../../src/lib/context.js';
import { decodeSessionToken } from '../../src/lib/decode-token.js';

/**
 * The headless authentication path: $SWALVO_TOKEN and $SWALVO_API_URL. For
 * CI, containers, and SSH sessions where `swalvo login` has no browser to
 * open.
 */

function tokenWith(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('decodeSessionToken', () => {
  it('reads the email claim used for display', () => {
    expect(decodeSessionToken(tokenWith({ sub: 'u1', email: 'ci@example.com' })).email).toBe('ci@example.com');
  });

  it('converts exp from JWT seconds to milliseconds', () => {
    expect(decodeSessionToken(tokenWith({ exp: 1_700_000_000 })).expiresAtMs).toBe(1_700_000_000_000);
  });

  it('returns nothing rather than throwing on a token it cannot parse', () => {
    // Whether a token works is the server's call. An unparseable one isn't
    // this function's error to raise.
    expect(decodeSessionToken('not-a-jwt')).toEqual({});
    expect(decodeSessionToken('')).toEqual({});
    expect(decodeSessionToken('a.!!!not-base64!!!.c')).toEqual({});
  });

  it('ignores claims of the wrong type instead of passing them through', () => {
    expect(decodeSessionToken(tokenWith({ email: 42, exp: 'soon' }))).toEqual({
      email: undefined,
      expiresAtMs: undefined,
    });
  });
});

describe('credentialsFromEnv', () => {
  afterEach(() => {
    delete process.env[TOKEN_ENV_VAR];
  });

  it('returns nothing when the variable is unset', () => {
    expect(credentialsFromEnv('http://localhost:4100')).toBeUndefined();
  });

  it('treats a blank or whitespace-only value as unset', () => {
    // An unset variable in CI usually turns up as the empty string rather
    // than absent, and treating that as a credential fails confusingly.
    process.env[TOKEN_ENV_VAR] = '   ';
    expect(credentialsFromEnv('http://localhost:4100')).toBeUndefined();
  });

  it('builds credentials from the token, marked as environment-sourced', () => {
    process.env[TOKEN_ENV_VAR] = tokenWith({ email: 'ci@example.com' });
    const credentials = credentialsFromEnv('https://api.swalvo.test');

    expect(credentials?.email).toBe('ci@example.com');
    expect(credentials?.apiUrl).toBe('https://api.swalvo.test');
    expect(credentials?.fromEnvironment).toBe(true);
  });

  it('strips surrounding whitespace, which shell interpolation often adds', () => {
    process.env[TOKEN_ENV_VAR] = `  ${tokenWith({ email: 'ci@example.com' })}\n`;
    expect(credentialsFromEnv('http://x')?.token).not.toMatch(/\s/);
  });

  it('still returns a credential when the token has no email claim', () => {
    // The server decides whether it works. A missing display name is no
    // reason to refuse to try.
    process.env[TOKEN_ENV_VAR] = tokenWith({ sub: 'u1' });
    const credentials = credentialsFromEnv('http://x');
    expect(credentials?.token).toBeDefined();
    expect(credentials?.email).toContain(TOKEN_ENV_VAR);
  });
});

describe('headless config and credential precedence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swalvo-cli-headless-'));
    process.env.SWALVO_CONFIG_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.SWALVO_CONFIG_DIR;
    delete process.env[TOKEN_ENV_VAR];
    delete process.env[API_URL_ENV_VAR];
    await rm(dir, { recursive: true, force: true });
  });

  it('lets $SWALVO_API_URL override the configured apiUrl', async () => {
    await writeCliConfig({ apiUrl: 'http://from-file' });
    process.env[API_URL_ENV_VAR] = 'https://from-env';

    await expect(readCliConfig()).resolves.toMatchObject({ apiUrl: 'https://from-env' });
  });

  it('keeps the rest of the config while overriding apiUrl', async () => {
    await writeCliConfig({ apiUrl: 'http://from-file', currentProject: 'proj_1' });
    process.env[API_URL_ENV_VAR] = 'https://from-env';

    await expect(readCliConfig()).resolves.toEqual({
      apiUrl: 'https://from-env',
      currentProject: 'proj_1',
    });
  });

  it('never writes the environment override back into config.json', async () => {
    // A read-modify-write that persisted a transient env var would let the
    // override outlive the process that set it.
    await writeCliConfig({ apiUrl: 'http://from-file' });
    process.env[API_URL_ENV_VAR] = 'https://from-env';

    await updateCliConfig({ currentProject: 'proj_2' });
    delete process.env[API_URL_ENV_VAR];

    await expect(readCliConfig()).resolves.toEqual({
      apiUrl: 'http://from-file',
      currentProject: 'proj_2',
    });
  });

  it('authenticates from $SWALVO_TOKEN with no credentials file present', async () => {
    process.env[TOKEN_ENV_VAR] = tokenWith({ email: 'ci@example.com' });

    const credentials = await requireCredentials();
    expect(credentials.email).toBe('ci@example.com');
    expect(credentials.fromEnvironment).toBe(true);
  });

  it('resolves the env credential against $SWALVO_API_URL', async () => {
    process.env[TOKEN_ENV_VAR] = tokenWith({ email: 'ci@example.com' });
    process.env[API_URL_ENV_VAR] = 'https://api.swalvo.test';

    await expect(requireCredentials()).resolves.toMatchObject({ apiUrl: 'https://api.swalvo.test' });
  });

  it('prefers $SWALVO_TOKEN over a stored credential', async () => {
    // So one command can run as a service account without disturbing the
    // developer's own stored session, or being disturbed by it.
    await writeCredentials({
      token: 'stored-token',
      email: 'dev@example.com',
      apiUrl: 'http://localhost:4100',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    process.env[TOKEN_ENV_VAR] = tokenWith({ email: 'ci@example.com' });

    await expect(requireCredentials()).resolves.toMatchObject({ email: 'ci@example.com' });
  });

  it('falls back to the stored credential when the variable is unset', async () => {
    await writeCredentials({
      token: 'stored-token',
      email: 'dev@example.com',
      apiUrl: 'http://localhost:4100',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const credentials = await requireCredentials();
    expect(credentials.email).toBe('dev@example.com');
    expect(credentials.fromEnvironment).toBeUndefined();
  });

  it('still refuses when neither source has anything', async () => {
    await expect(requireCredentials()).rejects.toThrow(/Not logged in/);
  });

  it('names both authentication paths in the error, not just the browser one', async () => {
    await expect(requireCredentials()).rejects.toMatchObject({
      suggestion: expect.stringContaining(TOKEN_ENV_VAR),
    });
  });
});
