import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredentials } from '../../src/lib/auth-store.js';
import { writeCliConfig } from '../../src/lib/cli-config.js';
import { mockApi, runCli } from './helpers.js';

describe('swalvo connections / errors / diagnostics (integration)', () => {
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

  it('connections list renders real connection state, never fabricating a status', async () => {
    mockApi({
      'GET /v1/projects/proj-1/connections': async () => ({
        status: 200,
        body: [
          {
            id: 'row-1',
            publicId: 'conn_abc',
            projectId: 'proj-1',
            roomId: 'room-1',
            roomName: 'demo-room',
            participantId: null,
            participantIdentity: 'alice',
            state: 'CONNECTED',
            disconnectReason: null,
            region: null,
            sdkVersion: '0.1.0',
            platform: 'web',
            browser: 'chrome',
            networkType: null,
            iceConnectionState: null,
            signalingState: null,
            reconnectCount: 0,
            startedAt: '2026-01-01T00:00:00.000Z',
            connectedAt: '2026-01-01T00:00:01.000Z',
            disconnectedAt: null,
            durationMs: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:01.000Z',
          },
        ],
      }),
    });

    const result = await runCli(['connections', 'list']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('conn_abc');
    expect(result.stdout).toContain('demo-room');
    expect(result.stdout).toContain('alice');
    expect(result.stdout).toContain('CONNECTED');
  });

  it('connections list --json emits valid, unmixed JSON', async () => {
    mockApi({ 'GET /v1/projects/proj-1/connections': async () => ({ status: 200, body: [] }) });

    const result = await runCli(['connections', 'list', '--json']);

    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('connections inspect shows the timeline and any errors for that connection', async () => {
    mockApi({
      'GET /v1/projects/proj-1/connections/conn_abc': async () => ({
        status: 200,
        body: {
          publicId: 'conn_abc',
          roomName: 'demo-room',
          participantIdentity: 'alice',
          state: 'DISCONNECTED',
          reconnectCount: 1,
          sdkVersion: '0.1.0',
          platform: 'web',
          browser: 'chrome',
          region: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          connectedAt: '2026-01-01T00:00:01.000Z',
          disconnectedAt: '2026-01-01T00:05:00.000Z',
          durationMs: 299000,
          disconnectReason: null,
          events: [
            { id: 'e1', type: 'connection_started', data: null, timestamp: '2026-01-01T00:00:00.000Z' },
            { id: 'e2', type: 'connected', data: null, timestamp: '2026-01-01T00:00:01.000Z' },
          ],
          errors: [],
        },
      }),
    });

    const result = await runCli(['connections', 'inspect', 'conn_abc']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('conn_abc');
    expect(result.stdout).toContain('connection_started');
    expect(result.stdout).toContain('connected');
  });

  it('connections inspect shows a Quality section when stats have arrived', async () => {
    mockApi({
      'GET /v1/projects/proj-1/connections/conn_abc': async () => ({
        status: 200,
        body: {
          publicId: 'conn_abc',
          roomName: 'demo-room',
          participantIdentity: 'alice',
          state: 'CONNECTED',
          reconnectCount: 0,
          sdkVersion: '0.1.0',
          platform: 'web',
          browser: 'chrome',
          region: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          connectedAt: '2026-01-01T00:00:01.000Z',
          disconnectedAt: null,
          durationMs: null,
          disconnectReason: null,
          connectionQuality: 'good',
          rttMs: 84,
          jitterMs: 12,
          packetLossPercent: 1.5,
          bitrateBps: 850_000,
          codec: 'video/VP8',
          events: [],
          errors: [],
        },
      }),
    });

    const result = await runCli(['connections', 'inspect', 'conn_abc']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Quality:');
    expect(result.stdout).toContain('good');
    expect(result.stdout).toContain('84 ms');
    expect(result.stdout).toContain('1.5%');
    expect(result.stdout).toContain('850 kbps');
    expect(result.stdout).toContain('video/VP8');
  });

  it('connections inspect omits the Quality section when stats have not arrived yet', async () => {
    mockApi({
      'GET /v1/projects/proj-1/connections/conn_fresh': async () => ({
        status: 200,
        body: {
          publicId: 'conn_fresh',
          roomName: 'demo-room',
          participantIdentity: 'alice',
          state: 'CONNECTING',
          reconnectCount: 0,
          sdkVersion: '0.1.0',
          platform: 'web',
          browser: 'chrome',
          region: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          connectedAt: null,
          disconnectedAt: null,
          durationMs: null,
          disconnectReason: null,
          connectionQuality: null,
          rttMs: null,
          jitterMs: null,
          packetLossPercent: null,
          bitrateBps: null,
          codec: null,
          events: [],
          errors: [],
        },
      }),
    });

    const result = await runCli(['connections', 'inspect', 'conn_fresh']);

    // A brand-new connection genuinely has nothing yet. An empty
    // "Quality:" heading reads as a bug, not as "too soon".
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Quality:');
  });

  it('connections list shows a QUALITY column', async () => {
    mockApi({
      'GET /v1/projects/proj-1/connections': async () => ({
        status: 200,
        body: [
          {
            publicId: 'conn_abc',
            roomName: 'demo-room',
            participantIdentity: 'alice',
            state: 'CONNECTED',
            reconnectCount: 0,
            durationMs: null,
            startedAt: '2026-01-01T00:00:00.000Z',
            connectionQuality: 'excellent',
          },
        ],
      }),
    });

    const result = await runCli(['connections', 'list']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('QUALITY');
    expect(result.stdout).toContain('excellent');
  });

  it('errors list shows the Swalvo-facing category, never a raw internal code', async () => {
    mockApi({
      'GET /v1/projects/proj-1/errors': async () => ({
        status: 200,
        body: [
          {
            id: 'row-1',
            publicId: 'err_abc',
            projectId: 'proj-1',
            connectionId: 'conn_abc',
            roomId: 'room-1',
            participantId: null,
            category: 'TOKEN_ERROR',
            message: 'RTC token has expired',
            likelyCause: 'The token expired.',
            suggestedAction: 'Mint a fresh token.',
            sdkVersion: '0.1.0',
            platform: 'web',
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    });

    const result = await runCli(['errors', 'list']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('TOKEN_ERROR');
    expect(result.stdout).toContain('err_abc');
    expect(result.stdout).not.toContain('ERR_JWT_EXPIRED');
  });

  it('errors inspect shows the likely cause and suggested action, hedged not certain', async () => {
    mockApi({
      'GET /v1/projects/proj-1/errors/err_abc': async () => ({
        status: 200,
        body: {
          publicId: 'err_abc',
          category: 'ICE_ERROR',
          message: 'ICE connectivity failed',
          likelyCause: 'Likely a firewall/NAT restriction.',
          suggestedAction: 'Ensure TURN is reachable.',
          timestamp: '2026-01-01T00:00:00.000Z',
          connectionId: 'conn_abc',
          roomId: 'room-1',
          sdkVersion: '0.1.0',
          platform: 'web',
        },
      }),
    });

    const result = await runCli(['errors', 'inspect', 'err_abc']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ICE_ERROR');
    expect(result.stdout).toContain('firewall/NAT');
    expect(result.stdout).toContain('Ensure TURN is reachable');
  });

  it('diagnostics reports real per-dependency status and never fabricates client-side ICE/browser state', async () => {
    mockApi({
      'GET /v1/projects/proj-1/diagnostics': async () => ({
        status: 200,
        body: {
          project: { id: 'proj-1', name: 'my-video-app' },
          api: 'up',
          authentication: 'ok',
          dependencies: { signaling: 'up', sfu: 'up', turn: 'down' },
          connections: { active: 2 },
        },
      }),
    });

    const result = await runCli(['diagnostics']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('my-video-app');
    expect(result.stdout).toContain('TURN: Unhealthy');
    expect(result.stdout).toContain('SFU: Healthy');
    // Client-side diagnostics need a live browser connection. The CLI has
    // to point at the SDK, never invent ICE or browser state of its own.
    expect(result.stdout).toContain('getDiagnostics()');
  });

  it('diagnostics --json emits real data only, no fabricated fields', async () => {
    mockApi({
      'GET /v1/projects/proj-1/diagnostics': async () => ({
        status: 200,
        body: {
          project: { id: 'proj-1', name: 'my-video-app' },
          api: 'up',
          authentication: 'ok',
          dependencies: { signaling: 'up', sfu: 'up', turn: 'up' },
          connections: { active: 0 },
        },
      }),
    });

    const result = await runCli(['diagnostics', '--json']);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.connections.active).toBe(0);
    expect(parsed.project.name).toBe('my-video-app');
  });
});
