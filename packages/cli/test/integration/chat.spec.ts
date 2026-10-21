import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredentials } from '../../src/lib/auth-store.js';
import { writeCliConfig } from '../../src/lib/cli-config.js';
import { mockApi, runCli } from './helpers.js';

const OVERVIEW = {
  range: '1h',
  conversations: 3,
  messagesStored: 128,
  activeConnections: 2,
  messagesSent: 40,
  messagesFailed: 0,
  messagesFannedOut: 120,
  connectionsOpened: 5,
  connectionsFailed: 0,
  rateLimited: 0,
  messagesPerSecond: 0.01,
  latency: { persistMs: 5, fanoutMs: 1, endToEndMs: 12 },
  gateway: { gatewayId: 'gw_abc_123', activeConnections: 2, subscribedRooms: 1, subscribedChannels: 1 },
};

describe('swalvo chat (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swalvo-cli-chat-'));
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

  describe('overview', () => {
    it('renders real counters', async () => {
      mockApi({ 'GET /v1/projects/proj-1/chat/overview': async () => ({ status: 200, body: OVERVIEW }) });

      const result = await runCli(['chat', 'overview']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('128');
      expect(result.stdout).toContain('gw_abc_123');
      expect(result.stdout).toContain('5 ms');
    });

    it('says a latency was not measured rather than printing 0 ms', async () => {
      mockApi({
        'GET /v1/projects/proj-1/chat/overview': async () => ({
          status: 200,
          body: { ...OVERVIEW, latency: { persistMs: null, fanoutMs: null, endToEndMs: null } },
        }),
      });

      const result = await runCli(['chat', 'overview']);

      // "0 ms" claims a measurement nobody took. A quiet project has no
      // samples; that isn't the same as instant delivery.
      expect(result.stdout).toContain('not measured in this window');
      expect(result.stdout).not.toContain('0 ms');
    });

    it('falls back to 1h for a range the API does not implement', async () => {
      const seen: string[] = [];
      mockApi({
        'GET /v1/projects/proj-1/chat/overview': async (url) => {
          seen.push(url);
          return { status: 200, body: OVERVIEW };
        },
      });

      await runCli(['chat', 'overview', '--range', '99y']);

      // Pass it through and the server quietly uses 1h while the header
      // cheerfully claims 99y.
      expect(seen[0]).toContain('range=1h');
    });

    it('--json emits valid, unmixed JSON', async () => {
      mockApi({ 'GET /v1/projects/proj-1/chat/overview': async () => ({ status: 200, body: OVERVIEW }) });

      const result = await runCli(['chat', 'overview', '--json']);

      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout).gateway.gatewayId).toBe('gw_abc_123');
    });
  });

  describe('conversations', () => {
    it('lists conversations with counts', async () => {
      mockApi({
        'GET /v1/projects/proj-1/chat/conversations': async () => ({
          status: 200,
          body: [
            {
              id: 'conv_abc',
              name: 'support',
              type: 'CHANNEL',
              status: 'ACTIVE',
              roomId: null,
              retentionDays: null,
              messageCount: 12,
              memberCount: 3,
              lastMessageAt: '2026-01-01T00:00:00.000Z',
              lastMessageSenderId: 'alice',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      });

      const result = await runCli(['chat', 'conversations']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('support');
      expect(result.stdout).toContain('conv_abc');
      expect(result.stdout).toContain('12');
    });

    it('never prints message contents', async () => {
      mockApi({
        'GET /v1/projects/proj-1/chat/conversations': async () => ({
          status: 200,
          body: [
            {
              id: 'conv_abc',
              name: 'support',
              type: 'CHANNEL',
              status: 'ACTIVE',
              roomId: null,
              retentionDays: null,
              messageCount: 1,
              memberCount: 1,
              lastMessageAt: '2026-01-01T00:00:00.000Z',
              lastMessageSenderId: 'alice',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      });

      const result = await runCli(['chat', 'conversations']);

      // The endpoint doesn't return message text, and the CLI says as much.
      // A terminal is no place to dump customers' messages.
      expect(result.stdout).toContain('Message contents are never returned');
    });

    it('points at the backend SDKs when there is nothing yet', async () => {
      mockApi({ 'GET /v1/projects/proj-1/chat/conversations': async () => ({ status: 200, body: [] }) });

      const result = await runCli(['chat', 'conversations']);

      // Conversations can't be created from the CLI, since that needs an
      // API key, so the empty state has to say where they do come from.
      expect(result.stdout).toContain('No conversations yet');
      expect(result.stdout).toContain('@swalvo/server');
    });

    it('is reachable as `chat list` too', async () => {
      mockApi({ 'GET /v1/projects/proj-1/chat/conversations': async () => ({ status: 200, body: [] }) });

      const result = await runCli(['chat', 'list']);

      expect(result.exitCode).toBe(0);
    });
  });

  describe('connections', () => {
    const connection = {
      id: 'row-1',
      publicId: 'ccn_abc',
      projectId: 'proj-1',
      conversationId: 'conv_1',
      userId: 'alice',
      gatewayId: 'gw_one',
      state: 'CONNECTED',
      disconnectReason: null,
      sdkVersion: '0.1.0',
      platform: 'web',
      messagesSent: 4,
      connectedAt: '2026-01-01T00:00:01.000Z',
      disconnectedAt: null,
      durationMs: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    };

    it('lists sessions with their gateway', async () => {
      mockApi({ 'GET /v1/projects/proj-1/chat/connections': async () => ({ status: 200, body: [connection] }) });

      const result = await runCli(['chat', 'connections']);

      expect(result.stdout).toContain('ccn_abc');
      expect(result.stdout).toContain('alice');
      // The column that matters when one instance in a fleet misbehaves.
      expect(result.stdout).toContain('gw_one');
    });

    it('shows a live session as live rather than as a zero duration', async () => {
      mockApi({ 'GET /v1/projects/proj-1/chat/connections': async () => ({ status: 200, body: [connection] }) });

      const result = await runCli(['chat', 'connections']);

      expect(result.stdout).toContain('live');
    });

    it('notes when sessions are spread across several gateways', async () => {
      mockApi({
        'GET /v1/projects/proj-1/chat/connections': async () => ({
          status: 200,
          body: [connection, { ...connection, publicId: 'ccn_def', gatewayId: 'gw_two' }],
        }),
      });

      const result = await runCli(['chat', 'connections']);

      expect(result.stdout).toContain('2 gateway instances');
    });

    it('forwards a valid state filter and drops an invalid one', async () => {
      const seen: string[] = [];
      mockApi({
        'GET /v1/projects/proj-1/chat/connections': async (url) => {
          seen.push(url);
          return { status: 200, body: [] };
        },
      });

      await runCli(['chat', 'connections', '--state', 'CONNECTED']);
      await runCli(['chat', 'connections', '--state', 'NONSENSE']);

      expect(seen[0]).toContain('state=CONNECTED');
      // The API rejects an unrecognised state. Dropping it returns
      // everything, which is the kinder reading of a typo.
      expect(seen[1]).not.toContain('state=');
    });
  });

  describe('presence', () => {
    it('shows who is present', async () => {
      mockApi({
        'GET /v1/projects/proj-1/chat/conversations/conv_abc/presence': async () => ({
          status: 200,
          body: [{ userId: 'alice', status: 'online' }],
        }),
      });

      const result = await runCli(['chat', 'presence', 'conv_abc']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('alice');
      expect(result.stdout).toContain('online');
    });

    it('explains that an empty list is a real answer', async () => {
      mockApi({
        'GET /v1/projects/proj-1/chat/conversations/conv_abc/presence': async () => ({ status: 200, body: [] }),
      });

      const result = await runCli(['chat', 'presence', 'conv_abc']);

      // Presence is TTL'd in Redis. "Nobody" is a fact, not a failed read.
      expect(result.stdout).toContain('Nobody is present');
      expect(result.stdout).toContain('ephemeral');
    });
  });

  describe('authorization', () => {
    it('surfaces an API refusal rather than printing an empty table', async () => {
      mockApi({
        'GET /v1/projects/proj-1/chat/overview': async () => ({
          status: 404,
          body: { code: 'NOT_FOUND', message: 'Project not found' },
        }),
      });

      const result = await runCli(['chat', 'overview']);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Project not found');
    });
  });
});
