import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredentials } from '../../src/lib/auth-store.js';
import { writeCliConfig } from '../../src/lib/cli-config.js';
import { mockApi, runCli } from './helpers.js';

describe('swalvo projects (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swalvo-cli-int-'));
    process.env.SWALVO_CONFIG_DIR = dir;
    await writeCliConfig({ apiUrl: 'http://api.test' });
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

  it('projects create <name> prints a success message and exits 0', async () => {
    mockApi({
      'POST /v1/projects': async () => ({
        status: 201,
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

    const result = await runCli(['projects', 'create', 'my-video-app']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Project created');
    expect(result.stdout).toContain('my-video-app');
    expect(result.stdout).toContain('proj-1');
  });

  it('projects create <name> --json prints valid, parseable JSON', async () => {
    mockApi({
      'POST /v1/projects': async () => ({
        status: 201,
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

    const result = await runCli(['projects', 'create', 'my-video-app', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'proj-1', name: 'my-video-app' });
  });

  it('projects list renders a table with NAME/ID/ENV columns', async () => {
    mockApi({
      'GET /v1/projects': async () => ({
        status: 200,
        body: [
          {
            id: 'proj-1',
            name: 'my-video-app',
            description: null,
            status: 'ACTIVE',
            ownerId: 'u1',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'proj-2',
            name: 'chat-app',
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
    expect(result.stdout).toContain('NAME');
    expect(result.stdout).toContain('my-video-app');
    expect(result.stdout).toContain('chat-app');
  });

  it('projects list shows an empty-state message, not a broken empty table', async () => {
    mockApi({ 'GET /v1/projects': async () => ({ status: 200, body: [] }) });

    const result = await runCli(['projects', 'list']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No projects yet');
  });

  it('projects delete without --yes in a non-interactive run fails with exit code 2 and does not call DELETE', async () => {
    const deleteHandler = jest.fn(async () => ({ status: 204 }));
    mockApi({
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
      'DELETE /v1/projects/proj-1': deleteHandler,
    });

    const result = await runCli(['projects', 'delete', 'proj-1']);

    expect(result.exitCode).toBe(2);
    expect(deleteHandler).not.toHaveBeenCalled();
  });

  it('projects delete --yes deletes without prompting and exits 0', async () => {
    mockApi({
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
      'DELETE /v1/projects/proj-1': async () => ({ status: 204 }),
    });

    const result = await runCli(['projects', 'delete', 'proj-1', '--yes']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Deleted');
  });

  it('a 401 response exits with code 3 and never prints a raw stack trace', async () => {
    mockApi({ 'GET /v1/projects': async () => ({ status: 401, body: { message: 'Invalid or missing credentials' } }) });

    const result = await runCli(['projects', 'list']);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('swalvo login');
    expect(result.stderr).not.toContain(' at ');
  });

  it('a 404 response exits with code 5', async () => {
    mockApi({
      // No project is named "missing", so it is looked up as an ID.
      'GET /v1/projects': async () => ({ status: 200, body: [] }),
      'GET /v1/projects/missing': async () => ({ status: 404, body: { message: 'Project not found' } }),
    });

    const result = await runCli(['projects', 'inspect', 'missing']);

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain('Project not found');
  });
});
