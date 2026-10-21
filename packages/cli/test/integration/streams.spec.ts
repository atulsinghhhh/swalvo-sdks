import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredentials } from '../../src/lib/auth-store.js';
import { writeCliConfig } from '../../src/lib/cli-config.js';
import { mockApi, runCli } from './helpers.js';

const STREAM = {
  id: 'stream_abc123',
  title: 'Friday Q&A',
  description: null,
  thumbnailUrl: null,
  category: null,
  tags: [],
  language: null,
  visibility: 'PUBLIC',
  metadata: null,
  status: 'CREATED',
  hosts: [{ identity: 'user-123', role: 'HOST', invitedAt: '2026-01-01T00:00:00.000Z' }],
  viewerCount: 3,
  peakViewerCount: 5,
  conversationId: 'conv_abc',
  chatRootMessageId: 'msg_abc',
  scheduledAt: null,
  startedAt: null,
  endedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('swalvo streams (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swalvo-cli-streams-'));
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

  describe('list', () => {
    it('lists streams with status and host count', async () => {
      mockApi({ 'GET /v1/projects/proj-1/live-streams': async () => ({ status: 200, body: [STREAM] }) });

      const result = await runCli(['streams', 'list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('stream_abc123');
      expect(result.stdout).toContain('Friday Q&A');
      expect(result.stdout).toContain('CREATED');
    });

    it('says there are no streams yet, pointing at `streams create`', async () => {
      mockApi({ 'GET /v1/projects/proj-1/live-streams': async () => ({ status: 200, body: [] }) });

      const result = await runCli(['streams', 'list']);

      expect(result.stdout).toContain('No live streams yet');
      expect(result.stdout).toContain('swalvo streams create');
    });

    it('forwards a status filter', async () => {
      const seen: string[] = [];
      mockApi({
        'GET /v1/projects/proj-1/live-streams': async (url) => {
          seen.push(url);
          return { status: 200, body: [] };
        },
      });

      await runCli(['streams', 'list', '--status', 'LIVE']);

      expect(seen[0]).toContain('status=LIVE');
    });

    it('--json emits valid, unmixed JSON', async () => {
      mockApi({ 'GET /v1/projects/proj-1/live-streams': async () => ({ status: 200, body: [STREAM] }) });

      const result = await runCli(['streams', 'list', '--json']);

      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)[0].id).toBe('stream_abc123');
    });
  });

  describe('inspect', () => {
    it('shows the stream, viewer count, and hosts', async () => {
      mockApi({ 'GET /v1/projects/proj-1/live-streams/stream_abc123': async () => ({ status: 200, body: STREAM }) });

      const result = await runCli(['streams', 'inspect', 'stream_abc123']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Friday Q&A');
      expect(result.stdout).toContain('user-123');
      expect(result.stdout).toContain('HOST');
      expect(result.stdout).toContain('3');
    });

    it('shows "unknown" rather than a fabricated viewer count when the SFU is unreachable', async () => {
      mockApi({
        'GET /v1/projects/proj-1/live-streams/stream_abc123': async () => ({
          status: 200,
          body: { ...STREAM, viewerCount: null },
        }),
      });

      const result = await runCli(['streams', 'inspect', 'stream_abc123']);

      expect(result.stdout).toContain('unknown');
    });

    it('never prints a credential; the endpoint does not return one', async () => {
      mockApi({ 'GET /v1/projects/proj-1/live-streams/stream_abc123': async () => ({ status: 200, body: STREAM }) });

      const result = await runCli(['streams', 'inspect', 'stream_abc123']);

      expect(result.stdout).not.toContain('token');
    });
  });

  describe('create', () => {
    it('creates a stream and prints its id, status, and title', async () => {
      mockApi({
        'POST /v1/projects/proj-1/live-streams': async () => ({ status: 201, body: STREAM }),
      });

      const result = await runCli(['streams', 'create', 'Friday Q&A', '--host', 'user-123']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Stream created');
      expect(result.stdout).toContain('stream_abc123');
      expect(result.stdout).toContain('CREATED');
    });

    it('requires --host', async () => {
      const result = await runCli(['streams', 'create', 'Friday Q&A']);

      expect(result.exitCode).not.toBe(0);
    });

    it('rejects an unknown visibility rather than passing it through', async () => {
      const result = await runCli([
        'streams',
        'create',
        'Friday Q&A',
        '--host',
        'user-123',
        '--visibility',
        'NONSENSE',
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unknown visibility');
    });
  });

  describe('update', () => {
    it('updates a stream', async () => {
      mockApi({
        'PATCH /v1/projects/proj-1/live-streams/stream_abc123': async () => ({
          status: 200,
          body: { ...STREAM, title: 'New title' },
        }),
      });

      const result = await runCli(['streams', 'update', 'stream_abc123', '--title', 'New title']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Stream updated');
    });

    it('refuses to send an empty update', async () => {
      const result = await runCli(['streams', 'update', 'stream_abc123']);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Nothing to update');
    });
  });

  describe('end', () => {
    it('ends a stream', async () => {
      mockApi({
        'POST /v1/projects/proj-1/live-streams/stream_abc123/end': async () => ({
          status: 201,
          body: { ...STREAM, status: 'ENDED' },
        }),
      });

      const result = await runCli(['streams', 'end', 'stream_abc123']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Stream ended');
    });

    it('surfaces a conflict rather than claiming success', async () => {
      mockApi({
        'POST /v1/projects/proj-1/live-streams/stream_abc123/end': async () => ({
          status: 409,
          body: { code: 'RAVEN_STREAM_INVALID_STATE', message: 'Only a LIVE stream can be ended' },
        }),
      });

      const result = await runCli(['streams', 'end', 'stream_abc123']);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Only a LIVE stream can be ended');
    });
  });

  describe('no credential-minting commands', () => {
    it('has no `streams hosts` or `streams token` subcommand', async () => {
      const hostsResult = await runCli(['streams', 'hosts']);
      const tokenResult = await runCli(['streams', 'token']);

      expect(hostsResult.exitCode).not.toBe(0);
      expect(tokenResult.exitCode).not.toBe(0);
    });
  });
});
