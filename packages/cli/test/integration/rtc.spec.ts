import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredentials } from '../../src/lib/auth-store.js';
import { writeCliConfig } from '../../src/lib/cli-config.js';
import { mockApi, runCli } from './helpers.js';

const SERVER = {
  id: 'srv-1',
  name: 'sfu-asia-02',
  region: 'asia-south',
  status: 'HEALTHY',
  publicHost: 'sfu-2.rtc.example.com',
  internalUrl: 'http://sfu-2:7000',
  capacity: 100,
  activeRooms: 12,
  activeParticipants: 47,
  cpuPercent: 34.2,
  memoryPercent: 61.8,
  networkInBps: 12_400_000,
  networkOutBps: 48_900_000,
  version: '0.1.0',
  lastHeartbeatAt: new Date().toISOString(),
  registeredAt: '2026-01-01T00:00:00.000Z',
  updatedAt: new Date().toISOString(),
};

const FLEET = {
  servers: 3,
  healthyServers: 2,
  drainingServers: 0,
  unhealthyServers: 1,
  activeRooms: 20,
  activeParticipants: 85,
  capacity: 300,
};

describe('swalvo rtc (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swalvo-cli-rtc-'));
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

  describe('rtc servers', () => {
    it('lists the fleet with health, load and heartbeat age', async () => {
      mockApi({
        'GET /v1/rtc/servers/metrics': async () => ({ status: 200, body: FLEET }),
        'GET /v1/rtc/servers': async () => ({ status: 200, body: [SERVER] }),
      });

      const result = await runCli(['rtc', 'servers', 'list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('sfu-asia-02');
      expect(result.stdout).toContain('asia-south');
      expect(result.stdout).toContain('12/100');
      expect(result.stdout).toContain('2 healthy, 0 draining, 1 unhealthy');
      // The staleness disclaimer isn't decoration. Every load figure is a
      // heartbeat-old snapshot, and whoever's reading them needs to know
      // that.
      expect(result.stdout).toContain('not live truth');
    });

    it('explains what to do when no server is registered', async () => {
      mockApi({
        'GET /v1/rtc/servers/metrics': async () => ({
          status: 200,
          body: { ...FLEET, servers: 0, healthyServers: 0, unhealthyServers: 0 },
        }),
        'GET /v1/rtc/servers': async () => ({ status: 200, body: [] }),
      });

      const result = await runCli(['rtc', 'servers', 'list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No RTC servers are registered');
      expect(result.stdout).toContain('register themselves on boot');
    });

    it('shows one server in detail', async () => {
      mockApi({
        'GET /v1/rtc/servers/sfu-asia-02': async () => ({ status: 200, body: SERVER }),
      });

      const result = await runCli(['rtc', 'servers', 'get', 'sfu-asia-02']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('sfu-asia-02');
      expect(result.stdout).toContain('12 / 100');
      // Bitrates are rendered in human units rather than raw bits.
      expect(result.stdout).toContain('Mbps');
    });

    it('renders an unmeasured gauge as unknown, not as zero', async () => {
      // A node that registered but never heartbeated has no reading at
      // all. Print 0% and it reads as "idle", which is the opposite of the
      // truth when you're deciding whether to scale.
      mockApi({
        'GET /v1/rtc/servers/sfu-new': async () => ({
          status: 200,
          body: {
            ...SERVER,
            name: 'sfu-new',
            cpuPercent: null,
            memoryPercent: null,
            networkInBps: null,
            networkOutBps: null,
            lastHeartbeatAt: null,
          },
        }),
      });

      const result = await runCli(['rtc', 'servers', 'get', 'sfu-new']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('never');
      expect(result.stdout).not.toContain('0%');
    });

    it('warns that an unhealthy node keeps its existing rooms', async () => {
      // Spec §26. An unhealthy SFU mustn't have its active rooms killed,
      // and the CLI says so, because "unhealthy" otherwise reads as "dead".
      mockApi({
        'GET /v1/rtc/servers/sfu-sick': async () => ({
          status: 200,
          body: { ...SERVER, name: 'sfu-sick', status: 'UNHEALTHY' },
        }),
      });

      const result = await runCli(['rtc', 'servers', 'get', 'sfu-sick']);

      expect(result.stdout).toContain('missed its heartbeat');
      expect(result.stdout).toContain('left running');
    });

    it('drains a server and says nobody was disconnected', async () => {
      mockApi({
        'POST /v1/rtc/servers/sfu-asia-02/drain': async () => ({
          status: 200,
          body: { ...SERVER, status: 'DRAINING' },
        }),
      });

      const result = await runCli(['rtc', 'servers', 'drain', 'sfu-asia-02']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('draining');
      expect(result.stdout).toContain('keep running');
    });

    it('undoes a drain with --undo', async () => {
      mockApi({
        'POST /v1/rtc/servers/sfu-asia-02/undrain': async () => ({
          status: 200,
          body: SERVER,
        }),
      });

      const result = await runCli(['rtc', 'servers', 'drain', 'sfu-asia-02', '--undo']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('accepting new rooms again');
    });

    it('filters by region', async () => {
      const requested: string[] = [];
      mockApi({
        'GET /v1/rtc/servers/metrics': async () => ({ status: 200, body: FLEET }),
        'GET /v1/rtc/servers': async (url) => {
          requested.push(url);
          return { status: 200, body: [SERVER] };
        },
      });

      await runCli(['rtc', 'servers', 'list', '--region', 'asia-south']);

      expect(requested.some((url) => url.includes('region=asia-south'))).toBe(true);
    });
  });

  describe('rtc rooms', () => {
    it('distinguishes an idle room from one whose server did not answer', async () => {
      // The single most important distinction this command makes.
      mockApi({
        'GET /v1/projects/proj-1/rooms': async () => ({
          status: 200,
          body: [
            {
              id: 'room-idle',
              projectId: 'proj-1',
              name: 'idle',
              status: 'ACTIVE',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              liveParticipantCount: 0,
            },
            {
              id: 'room-unknown',
              projectId: 'proj-1',
              name: 'unreachable',
              status: 'ACTIVE',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              liveParticipantCount: null,
            },
          ],
        }),
      });

      const result = await runCli(['rtc', 'rooms', 'list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('unknown');
      // The idle room shows a real zero, which is a different claim.
      expect(result.stdout).toMatch(/idle\s+ACTIVE\s+0/);
    });

    it("shows a room's live participants and their tracks", async () => {
      mockApi({
        'GET /v1/projects/proj-1/rooms/room-1': async () => ({
          status: 200,
          body: {
            id: 'room-1',
            projectId: 'proj-1',
            name: 'standup',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            liveParticipantCount: 1,
            liveParticipants: [
              {
                identity: 'alice',
                joinedAt: '2026-01-01T00:00:00.000Z',
                tracks: [
                  { sid: 't1', kind: 'video', name: 'camera', muted: false },
                  { sid: 't2', kind: 'audio', name: 'microphone', muted: true },
                ],
              },
            ],
          },
        }),
      });

      const result = await runCli(['rtc', 'rooms', 'get', 'room-1']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('alice');
      expect(result.stdout).toContain('camera');
      expect(result.stdout).toContain('muted');
    });

    it('says the call may still be running when the server is unreachable', async () => {
      // "Unavailable" on its own reads as "the room is gone", which is a
      // much stronger claim, and possibly a wrong one.
      mockApi({
        'GET /v1/projects/proj-1/rooms/room-1': async () => ({
          status: 200,
          body: {
            id: 'room-1',
            projectId: 'proj-1',
            name: 'standup',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            liveParticipantCount: null,
            liveParticipants: null,
          },
        }),
      });

      const result = await runCli(['rtc', 'rooms', 'get', 'room-1']);

      expect(result.stdout).toContain('could not be reached');
      expect(result.stdout).toContain('may still be running');
    });

    it('closes a room and explains that nobody is disconnected', async () => {
      mockApi({
        'POST /v1/projects/proj-1/rooms/room-1/close': async () => ({ status: 204, body: null }),
      });

      const result = await runCli(['rtc', 'rooms', 'close', 'room-1']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Room closed');
      expect(result.stdout).toContain('are not disconnected');
    });
  });

  describe('rtc participants', () => {
    it('lists who is connected, marking muted tracks', async () => {
      mockApi({
        'GET /v1/projects/proj-1/rooms/room-1': async () => ({
          status: 200,
          body: {
            id: 'room-1',
            projectId: 'proj-1',
            name: 'standup',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            liveParticipantCount: 1,
            liveParticipants: [
              {
                identity: 'bob',
                joinedAt: '2026-01-01T00:00:00.000Z',
                tracks: [{ sid: 't1', kind: 'audio', name: 'microphone', muted: true }],
              },
            ],
          },
        }),
      });

      const result = await runCli(['rtc', 'participants', 'list', 'room-1']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bob');
      expect(result.stdout).toContain('microphone*');
      expect(result.stdout).toContain('* muted');
    });
  });

  describe('rtc diagnostics', () => {
    it('reports the fleet alongside the room, and counts tracks by kind', async () => {
      mockApi({
        'GET /v1/projects/proj-1/rooms/room-1': async () => ({
          status: 200,
          body: {
            id: 'room-1',
            projectId: 'proj-1',
            name: 'standup',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            liveParticipantCount: 2,
            liveParticipants: [
              {
                identity: 'alice',
                joinedAt: '2026-01-01T00:00:00.000Z',
                tracks: [
                  { sid: 't1', kind: 'audio', name: 'microphone', muted: false },
                  { sid: 't2', kind: 'video', name: 'camera', muted: false },
                  { sid: 't3', kind: 'video', name: 'screenShare', muted: false },
                ],
              },
              { identity: 'bob', joinedAt: '2026-01-01T00:00:00.000Z', tracks: [] },
            ],
          },
        }),
        'GET /v1/rtc/servers/metrics': async () => ({ status: 200, body: FLEET }),
      });

      const result = await runCli(['rtc', 'diagnostics', 'room-1']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 audio · 1 video · 1 screen');
      expect(result.stdout).toContain('2 healthy of 3');
      // A participant publishing nothing gets called out. It's the usual
      // symptom of a permission or capture problem.
      expect(result.stdout).toContain('publishing nothing');
    });

    it('stops at the fleet when nothing healthy is registered', async () => {
      // No point reporting a room's participants when no server could be
      // serving it. The fleet is the actual problem.
      mockApi({
        'GET /v1/projects/proj-1/rooms/room-1': async () => ({
          status: 200,
          body: {
            id: 'room-1',
            projectId: 'proj-1',
            name: 'standup',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            liveParticipantCount: null,
            liveParticipants: null,
          },
        }),
        'GET /v1/rtc/servers/metrics': async () => ({
          status: 200,
          body: { ...FLEET, healthyServers: 0 },
        }),
      });

      const result = await runCli(['rtc', 'diagnostics', 'room-1']);

      expect(result.stdout).toContain('No healthy RTC server is registered');
    });

    it('explains that an idle room has no assigned server', async () => {
      mockApi({
        'GET /v1/projects/proj-1/rooms/room-1': async () => ({
          status: 200,
          body: {
            id: 'room-1',
            projectId: 'proj-1',
            name: 'standup',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            liveParticipantCount: 0,
            liveParticipants: [],
          },
        }),
        'GET /v1/rtc/servers/metrics': async () => ({ status: 200, body: FLEET }),
      });

      const result = await runCli(['rtc', 'diagnostics', 'room-1']);

      expect(result.stdout).toContain('room is idle');
      expect(result.stdout).toContain('only assigned a server while someone is in it');
    });
  });

  describe('--json', () => {
    it('emits machine-readable output for every subcommand', async () => {
      mockApi({
        'GET /v1/rtc/servers/metrics': async () => ({ status: 200, body: FLEET }),
        'GET /v1/rtc/servers': async () => ({ status: 200, body: [SERVER] }),
      });

      const result = await runCli(['rtc', 'servers', 'list', '--json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { fleet: unknown; servers: unknown[] };
      expect(parsed.fleet).toEqual(FLEET);
      expect(parsed.servers).toHaveLength(1);
    });
  });
});
