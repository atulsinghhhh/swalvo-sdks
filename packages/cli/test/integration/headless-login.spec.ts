import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCredentials, TOKEN_ENV_VAR } from '../../src/lib/auth-store.js';
import { writeCliConfig } from '../../src/lib/cli-config.js';
import { mockApi, runCli } from './helpers.js';

/**
 * `swalvo login --token` and $SWALVO_TOKEN, end to end through the real
 * command tree.
 *
 * Neither path is allowed to open a browser; that's the entire point of
 * them. So `open` is not stubbed here, on purpose. A call to it fails the
 * suite loudly instead of quietly launching something.
 */

function tokenWith(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

const CI_TOKEN = tokenWith({ sub: 'u1', email: 'ci@example.com' });

describe('headless login (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swalvo-cli-headless-int-'));
    process.env.SWALVO_CONFIG_DIR = dir;
    await writeCliConfig({ apiUrl: 'http://api.test' });
  });

  afterEach(async () => {
    delete process.env.SWALVO_CONFIG_DIR;
    delete process.env[TOKEN_ENV_VAR];
    delete process.env.SWALVO_API_URL;
    await rm(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('login --token verifies the token and stores it', async () => {
    mockApi({ 'GET /v1/projects': async () => ({ status: 200, body: [] }) });

    const result = await runCli(['login', '--token', CI_TOKEN]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ci@example.com');
    await expect(readCredentials()).resolves.toMatchObject({
      token: CI_TOKEN,
      email: 'ci@example.com',
      apiUrl: 'http://api.test',
    });
  });

  it('login --token never echoes the token back', async () => {
    mockApi({ 'GET /v1/projects': async () => ({ status: 200, body: [] }) });

    const result = await runCli(['login', '--token', CI_TOKEN]);

    expect(result.stdout).not.toContain(CI_TOKEN);
    expect(result.stderr).not.toContain(CI_TOKEN);
  });

  it('login --token sends the token as a bearer credential when verifying', async () => {
    let seenAuth: string | undefined;
    mockApi({
      'GET /v1/projects': async (_url, init) => {
        seenAuth = new Headers(init.headers).get('authorization') ?? undefined;
        return { status: 200, body: [] };
      },
    });

    await runCli(['login', '--token', CI_TOKEN]);
    expect(seenAuth).toBe(`Bearer ${CI_TOKEN}`);
  });

  it('login --token writes nothing when the API rejects the token', async () => {
    // Store an unusable credential and you've only moved the failure to
    // the next command, where the cause is far less obvious.
    mockApi({ 'GET /v1/projects': async () => ({ status: 401, body: { message: 'Invalid token' } }) });

    const result = await runCli(['login', '--token', CI_TOKEN]);

    expect(result.exitCode).toBe(3); // AuthenticationFailure
    await expect(readCredentials()).resolves.toBeUndefined();
  });

  it('explains that tokens expire when one is rejected', async () => {
    mockApi({ 'GET /v1/projects': async () => ({ status: 401, body: { message: 'Invalid token' } }) });

    const result = await runCli(['login', '--token', CI_TOKEN]);
    expect(result.stderr).toMatch(/expire/i);
  });

  it('rejects an empty --token as a usage error, without calling the API', async () => {
    mockApi({});

    const result = await runCli(['login', '--token', '   ']);
    expect(result.exitCode).toBe(2); // InvalidUsage
  });

  it('authenticates a normal command straight from $SWALVO_TOKEN', async () => {
    // No login step at all, and no writable home directory needed.
    process.env[TOKEN_ENV_VAR] = CI_TOKEN;
    mockApi({
      'GET /v1/projects': async () => ({
        status: 200,
        body: [
          {
            id: 'proj-1',
            name: 'ci-app',
            description: null,
            status: 'ACTIVE',
            ownerId: 'u1',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    });

    const result = await runCli(['projects', 'list']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ci-app');
    // The env path is stateless. It mustn't leave a credentials file.
    await expect(readCredentials()).resolves.toBeUndefined();
  });

  it('routes $SWALVO_TOKEN requests to $SWALVO_API_URL', async () => {
    process.env[TOKEN_ENV_VAR] = CI_TOKEN;
    process.env.SWALVO_API_URL = 'http://override.test';

    let seenHost: string | undefined;
    mockApi({
      'GET /v1/projects': async (url) => {
        seenHost = new URL(url).host;
        return { status: 200, body: [] };
      },
    });

    await runCli(['projects', 'list']);
    expect(seenHost).toBe('override.test');
  });

  it('whoami reports that the credential came from the environment', async () => {
    process.env[TOKEN_ENV_VAR] = CI_TOKEN;
    mockApi({ 'GET /v1/projects': async () => ({ status: 200, body: [] }) });

    const result = await runCli(['whoami']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(TOKEN_ENV_VAR);
  });

  it('logout says the environment token is still active rather than claiming success', async () => {
    process.env[TOKEN_ENV_VAR] = CI_TOKEN;
    mockApi({});

    const result = await runCli(['logout']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(TOKEN_ENV_VAR);
    expect(result.stdout).not.toContain('Already logged out');
  });

  it('suggests the headless path when nothing is authenticated', async () => {
    mockApi({});

    const result = await runCli(['projects', 'list']);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain(TOKEN_ENV_VAR);
  });
});
