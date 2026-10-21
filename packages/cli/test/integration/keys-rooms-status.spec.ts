import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredentials } from '../../src/lib/auth-store.js';
import { writeCliConfig } from '../../src/lib/cli-config.js';
import { mockApi, runCli } from './helpers.js';

describe('swalvo keys / rooms / status / whoami (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swalvo-cli-int-'));
    process.env.SWALVO_CONFIG_DIR = dir;
    await writeCliConfig({ apiUrl: 'http://api.test', currentProject: 'proj-1' });
    await writeCredentials({
      token: 'jwt-token',
      email: 'dev@example.com',
      apiUrl: 'http://api.test',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    delete process.env.SWALVO_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('keys create shows the secret exactly once with a warning, and exits 0', async () => {
    mockApi({
      'POST /v1/projects/proj-1/api-keys': async () => ({
        status: 201,
        body: {
          id: 'key-1',
          name: 'ci-key',
          publicId: 'rvk_dev_abc',
          environment: 'DEVELOPMENT',
          key: 'rvk_dev_abc.supersecretvalue',
          createdAt: '2026-01-01T00:00:00.000Z',
          warning: 'This is the only time the full key is shown. Store it securely; it cannot be retrieved again.',
        },
      }),
    });

    const result = await runCli(['keys', 'create', '--name', 'ci-key']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('rvk_dev_abc.supersecretvalue');
    expect(result.stdout).toContain('not be shown again');
  });

  it('keys list renders a table without ever showing a raw secret value', async () => {
    mockApi({
      'GET /v1/projects/proj-1/api-keys': async () => ({
        status: 200,
        body: [
          {
            id: 'key-1',
            projectId: 'proj-1',
            publicId: 'rvk_abc',
            name: 'ci-key',
            environment: 'PRODUCTION',
            status: 'ACTIVE',
            lastUsedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            revokedAt: null,
          },
        ],
      }),
    });

    const result = await runCli(['keys', 'list']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('rvk_abc');
    expect(result.stdout).toContain('ci-key');
    // Which environment a key belongs to is the column that stops someone
    // revoking the wrong one.
    expect(result.stdout).toContain('production');
    expect(result.stdout).not.toContain('supersecretvalue');
  });

  describe('keys create --environment', () => {
    function mockCreate(capture: { body?: unknown }) {
      mockApi({
        'POST /v1/projects/proj-1/api-keys': async (_url, init) => {
          capture.body = init?.body ? JSON.parse(String(init.body)) : undefined;
          return {
            status: 201,
            body: {
              id: 'key-1',
              name: null,
              publicId: 'rvk_prod_abc',
              environment: 'PRODUCTION',
              key: 'rvk_prod_abc.secret',
              createdAt: '2026-01-01T00:00:00.000Z',
              warning: 'once only',
            },
          };
        },
      });
    }

    it.each([
      ['production', 'PRODUCTION'],
      ['PRODUCTION', 'PRODUCTION'],
      ['prod', 'PRODUCTION'],
      ['staging', 'STAGING'],
      ['stg', 'STAGING'],
      ['dev', 'DEVELOPMENT'],
    ])('accepts %s and sends %s', async (input, expected) => {
      // Requiring an exact enum spelling from a terminal is a papercut.
      const capture: { body?: unknown } = {};
      mockCreate(capture);

      const result = await runCli(['keys', 'create', '--environment', input]);

      expect(result.exitCode).toBe(0);
      expect(capture.body).toMatchObject({ environment: expected });
    });

    it('refuses an unrecognised environment rather than defaulting', async () => {
      const capture: { body?: unknown } = {};
      mockCreate(capture);

      const result = await runCli(['keys', 'create', '--environment', 'prd']);

      // Silently issuing a development key to someone who typed `prd` and
      // meant production is the worst available outcome.
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unknown environment');
      expect(capture.body).toBeUndefined();
    });

    it('warns that a production key belongs server-side', async () => {
      mockCreate({});

      const result = await runCli(['keys', 'create', '--environment', 'production']);

      expect(result.stdout).toContain('production environment');
      expect(result.stdout).toContain('never in an app bundle');
    });

    it('omits the field entirely when no environment is given', async () => {
      // Sending environment: undefined would be the same on the wire, but
      // building the body explicitly keeps the server's default authoritative.
      const capture: { body?: unknown } = {};
      mockCreate(capture);

      await runCli(['keys', 'create']);

      expect(capture.body).not.toHaveProperty('environment');
    });
  });

  it('keys revoke --yes calls the revoke endpoint and exits 0', async () => {
    const revoke = jest.fn(async () => ({ status: 204 }));
    mockApi({ 'DELETE /v1/projects/proj-1/api-keys/key-1': revoke });

    const result = await runCli(['keys', 'revoke', 'key-1', '--yes']);

    expect(result.exitCode).toBe(0);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('rooms list distinguishes an unreachable SFU (null) from a genuinely idle room (0)', async () => {
    mockApi({
      'GET /v1/projects/proj-1/rooms': async () => ({
        status: 200,
        body: [
          {
            id: 'r1',
            projectId: 'proj-1',
            name: 'demo-room',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            liveParticipantCount: 4,
          },
          {
            id: 'r2',
            projectId: 'proj-1',
            name: 'idle-room',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            liveParticipantCount: 0,
          },
          {
            id: 'r3',
            projectId: 'proj-1',
            name: 'unknown-room',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            liveParticipantCount: null,
          },
        ],
      }),
    });

    const result = await runCli(['rooms', 'list']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/demo-room\s+4\s+active/);
    expect(result.stdout).toMatch(/idle-room\s+0\s+idle/);
    expect(result.stdout).toMatch(/unknown-room\s+unknown\s+unknown/);
  });

  it('status reports real dependency health and exits 0 when everything is up', async () => {
    mockApi({
      'GET /health': async () => ({
        status: 200,
        body: {
          status: 'ok',
          dependencies: { database: 'up', redis: 'up', sfu: 'up', turn: 'up' },
          signaling: { activeConnections: 0, activeRooms: 0, activeParticipants: 0 },
        },
      }),
      'GET /v1/projects/proj-1': async () => ({
        status: 200,
        body: {
          id: 'proj-1',
          name: 'my-video-app',
          description: null,
          status: 'ACTIVE',
          ownerId: 'u1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    });

    const result = await runCli(['status']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Healthy');
    expect(result.stdout).toContain('my-video-app');
  });

  it('status reports Unhealthy for a down dependency, without fabricating a healthy status', async () => {
    mockApi({
      'GET /health': async () => ({
        status: 503,
        body: {
          status: 'degraded',
          dependencies: { database: 'up', redis: 'up', sfu: 'down', turn: 'up' },
          signaling: { activeConnections: 0, activeRooms: 0, activeParticipants: 0 },
        },
      }),
    });

    const result = await runCli(['status']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('SFU: Unhealthy');
  });

  it('whoami prints the logged-in email and a real project count', async () => {
    mockApi({
      'GET /v1/projects': async () => ({
        status: 200,
        body: [
          {
            id: 'proj-1',
            name: 'a',
            description: null,
            status: 'ACTIVE',
            ownerId: 'u1',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    });

    const result = await runCli(['whoami']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dev@example.com');
    expect(result.stdout).toContain('1');
  });

  it('whoami never prints the raw JWT token', async () => {
    mockApi({ 'GET /v1/projects': async () => ({ status: 200, body: [] }) });

    const result = await runCli(['whoami']);

    expect(result.stdout).not.toContain('jwt-token');
  });
});
