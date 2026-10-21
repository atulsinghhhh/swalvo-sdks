/**
 * Phase 1 resilience: token refresh, session resume, close codes, media
 * rejoin, live permissions and server mutes
 * (docs/architecture/phase1-contracts.md §1, §2.6).
 *
 * Driven through a real `Room` over a real `SwalvoAdapter`, with only the
 * socket and the PeerConnection faked, so each test asserts what an
 * application actually observes.
 */
import { SwalvoAdapter } from '../src/internal/sfu/swalvo-adapter';
import { Room } from '../src/room';
import { createLogger } from '../src/logger';
import type { RTCError } from '../src/errors';
import type { DisconnectReason, ParticipantPermissions, RTCWarning } from '../src/internal/sfu/types';
import type { LocalTrack, TrackKind } from '../src/track';
import {
  FakeRTCPeerConnection,
  FakeWebSocket,
  fakeToken,
  flush,
  installFakeMediaDevices,
  installFakeWebRTC,
} from './helpers/fake-webrtc';

const ENDPOINT = 'ws://localhost:4000/v1/rtc';

function token(overrides: Record<string, unknown> = {}): string {
  return fakeToken({
    jti: `rtc-${Math.random().toString(36).slice(2, 8)}`,
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
    ...overrides,
  });
}

const TOKEN = token();

const rooms: Room[] = [];

interface Harness {
  adapter: SwalvoAdapter;
  room: Room;
  socket: FakeWebSocket;
  events: {
    disconnected: DisconnectReason[];
    errors: RTCError[];
    warnings: RTCWarning[];
    reconnecting: number;
    reconnected: number;
  };
}

async function join(
  options: { refreshToken?: () => Promise<string>; autoReconnect?: boolean; resumeToken?: string } = {},
): Promise<Harness> {
  const adapter = new SwalvoAdapter(createLogger('silent'), options.autoReconnect ?? true, {
    adaptiveStream: false,
    refreshToken: options.refreshToken,
  });
  const room = new Room(adapter, 'room-1', createLogger('silent'));
  const events: Harness['events'] = { disconnected: [], errors: [], warnings: [], reconnecting: 0, reconnected: 0 };
  room.on('disconnected', (reason) => events.disconnected.push(reason));
  room.on('error', (error) => events.errors.push(error));
  room.on('warning', (warning) => events.warnings.push(warning));
  room.on('reconnecting', () => events.reconnecting++);
  room.on('reconnected', () => events.reconnected++);

  const connecting = adapter.connect(ENDPOINT, TOKEN, []);
  await flush();
  const socket = FakeWebSocket.latest;
  socket.receive({
    type: 'room.joined',
    roomId: 'room-1',
    participants: [],
    rtcServer: 'sfu-local-01',
    resumeToken: options.resumeToken ?? 'resume-1',
  });
  await connecting;
  rooms.push(room);
  return { adapter, room, socket, events };
}

/** Answers the SFU's join offer and brings the media connection up. */
async function bringUpMedia(socket: FakeWebSocket): Promise<FakeRTCPeerConnection> {
  socket.receive({ type: 'sdp.offer', sdp: 'v=0 fake-server-offer' });
  await flush();
  const pc = FakeRTCPeerConnection.latest;
  pc.setConnectionState('connected');
  return pc;
}

async function settle(socket: FakeWebSocket, pc: FakeRTCPeerConnection): Promise<void> {
  for (let round = 0; round < 8; round++) {
    await flush();
    if (pc.signalingState !== 'have-local-offer') {
      return;
    }
    socket.receive({ type: 'sdp.answer', sdp: `v=0 fake-server-answer-${round}` });
  }
  throw new Error('negotiation never settled');
}

async function waitForNewSocket(previousCount: number, timeoutMs = 3_000): Promise<FakeWebSocket> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (FakeWebSocket.instances.length > previousCount) {
      await flush();
      return FakeWebSocket.latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the signaling client never reconnected');
}

/** Waits long enough that a reconnect, had one been scheduled, would have opened its socket. */
async function assertNoNewSocket(previousCount: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(FakeWebSocket.instances).toHaveLength(previousCount);
}

function joinedFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'room.joined', roomId: 'room-1', participants: [], rtcServer: 'sfu-local-01', ...extra };
}

describe('phase 1 resilience', () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = installFakeWebRTC();
    installFakeMediaDevices();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    while (rooms.length > 0) {
      await rooms.pop()?.leave();
    }
    teardown();
  });

  describe('token refresh (§1.1)', () => {
    it('answers token.expiring with token.refresh carrying the new token', async () => {
      const fresh = token({ jti: 'fresh' });
      const refreshToken = jest.fn().mockResolvedValue(fresh);
      const { socket } = await join({ refreshToken });

      socket.receive({ type: 'token.expiring', expiresAt: '2026-10-02T12:00:00.000Z' });
      await flush();

      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(socket.lastSent('token.refresh')).toEqual({ type: 'token.refresh', token: fresh });
    });

    it('reconnects with the refreshed token once the server has accepted it', async () => {
      const fresh = token({ jti: 'fresh' });
      const { socket } = await join({ refreshToken: async () => fresh });
      socket.receive({ type: 'token.expiring', expiresAt: '2026-10-02T12:00:00.000Z' });
      await flush();
      socket.receive({ type: 'token.refreshed', expiresAt: '2026-10-02T12:10:00.000Z' });

      const before = FakeWebSocket.instances.length;
      socket.close(1006);
      const next = await waitForNewSocket(before);

      expect(next.url).toContain(encodeURIComponent(fresh));
    });

    it('keeps the session and warns when the server refuses the new token', async () => {
      const fresh = token({ jti: 'fresh' });
      const { adapter, socket, events } = await join({ refreshToken: async () => fresh });
      await bringUpMedia(socket);

      socket.receive({ type: 'token.expiring', expiresAt: '2026-10-02T12:00:00.000Z' });
      await flush();
      socket.receive({ type: 'error', code: 'TOKEN_INVALID', message: 'token does not match this session' });
      await flush();

      expect(events.warnings).toEqual([expect.objectContaining({ code: 'TOKEN_REFRESH_FAILED' })]);
      expect(events.errors).toHaveLength(0);
      expect(adapter.connectionState).toBe('connected');
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);

      // And the refused token is not used for the next reconnect.
      const before = FakeWebSocket.instances.length;
      socket.close(1006);
      const next = await waitForNewSocket(before);
      expect(next.url).toContain(encodeURIComponent(TOKEN));
    });

    it('warns when the token is expiring and there is no refreshToken', async () => {
      const { socket, events } = await join();

      socket.receive({ type: 'token.expiring', expiresAt: '2026-10-02T12:00:00.000Z' });
      await flush();

      expect(events.warnings).toEqual([
        expect.objectContaining({ code: 'TOKEN_EXPIRING', expiresAt: '2026-10-02T12:00:00.000Z' }),
      ]);
    });

    it('warns, without failing, when refreshToken itself rejects', async () => {
      const { adapter, socket, events } = await join({
        refreshToken: async () => Promise.reject(new Error('backend down')),
      });
      await bringUpMedia(socket);

      socket.receive({ type: 'token.expiring', expiresAt: '2026-10-02T12:00:00.000Z' });
      await flush();

      expect(events.warnings).toEqual([expect.objectContaining({ code: 'TOKEN_REFRESH_FAILED' })]);
      expect(socket.lastSent('token.refresh')).toBeUndefined();
      expect(adapter.connectionState).toBe('connected');
    });
  });

  describe('session resume (§1.2)', () => {
    it('offers the resume token on reconnect and keeps the PeerConnection when resumed', async () => {
      const { adapter, socket, events } = await join({ resumeToken: 'resume-1' });
      const pc = await bringUpMedia(socket);
      await adapter.enableCamera(true);
      await settle(socket, pc);
      const connectionsBefore = FakeRTCPeerConnection.instances.length;

      const before = FakeWebSocket.instances.length;
      socket.close(1006);
      await flush();
      // Media is still up on the SFU, so nothing local is torn down yet.
      expect(pc.closed).toBe(false);
      expect(adapter.connectionState).toBe('reconnecting');

      const next = await waitForNewSocket(before);
      expect(next.lastSent('room.join')).toEqual(
        expect.objectContaining({ roomId: 'room-1', resume: { token: 'resume-1' } }),
      );

      next.receive(joinedFrame({ resumed: true, resumeToken: 'resume-2' }));
      await flush();

      expect(pc.closed).toBe(false);
      expect(FakeRTCPeerConnection.instances).toHaveLength(connectionsBefore);
      // The SFU still has the track; declaring it again would be noise.
      expect(next.lastSent('track.publish')).toBeUndefined();
      expect(adapter.connectionState).toBe('connected');
      expect(events.reconnected).toBe(1);
    });

    it('uses the latest room.resume_token', async () => {
      const { socket } = await join({ resumeToken: 'resume-1' });
      socket.receive({ type: 'room.resume_token', resumeToken: 'resume-rotated' });

      const before = FakeWebSocket.instances.length;
      socket.close(1006);
      const next = await waitForNewSocket(before);

      expect(next.lastSent('room.join')).toEqual(expect.objectContaining({ resume: { token: 'resume-rotated' } }));
    });

    it('rebuilds the PeerConnection and republishes when the server could not resume', async () => {
      const { adapter, socket } = await join();
      const pc = await bringUpMedia(socket);
      await adapter.enableMicrophone(true);
      await settle(socket, pc);

      const before = FakeWebSocket.instances.length;
      socket.close(1006);
      const next = await waitForNewSocket(before);
      next.receive(joinedFrame({ resumed: false }));
      await flush();

      expect(pc.closed).toBe(true);
      const replacement = FakeRTCPeerConnection.latest;
      expect(replacement).not.toBe(pc);
      expect(replacement.activeSenders('audio')).toHaveLength(1);
      expect(next.lastSent('track.publish')).toEqual(expect.objectContaining({ source: 'microphone' }));
    });

    it('re-subscribes remote media on a rebuilt connection instead of keeping the dead track', async () => {
      const announced = { trackId: 'bob-cam', kind: 'video', source: 'camera', muted: false, simulcast: false };
      const { room, socket } = await join();
      socket.receive({ type: 'participant.joined', participant: { id: 'bob' } });
      socket.receive({ type: 'track.published', participantId: 'bob', track: announced });
      const pc = await bringUpMedia(socket);
      const { FakeMediaStreamTrack } = await import('./helpers/fake-webrtc');
      pc.emitTrack(new FakeMediaStreamTrack('video', 'bob-cam'));
      await flush();

      const unsubscribed: string[] = [];
      const subscribed: string[] = [];
      room.on('trackUnsubscribed', (_track, participant) => unsubscribed.push(participant.identity));
      await flush();
      room.on('trackSubscribed', (_track, participant) => subscribed.push(participant.identity));
      await flush();
      subscribed.length = 0; // drop the replay of the existing subscription

      const before = FakeWebSocket.instances.length;
      socket.close(1006);
      const next = await waitForNewSocket(before);
      next.receive(joinedFrame({ resumed: false, participants: [{ id: 'bob', tracks: [announced] }] }));
      await flush();
      next.receive({ type: 'sdp.offer', sdp: 'v=0 fake-server-offer' });
      await flush();
      FakeRTCPeerConnection.latest.emitTrack(new FakeMediaStreamTrack('video', 'bob-cam'));
      await flush();

      expect(unsubscribed).toEqual(['bob']);
      expect(subscribed).toEqual(['bob']);
      expect(room.remoteParticipants[0].tracks).toHaveLength(1);
    });

    it('does not offer a resume token on a first join', async () => {
      const adapter = new SwalvoAdapter(createLogger('silent'), true);
      const connecting = adapter.connect(ENDPOINT, TOKEN, []);
      await flush();
      const socket = FakeWebSocket.latest;
      expect(socket.lastSent('room.join')).not.toHaveProperty('resume');
      socket.receive(joinedFrame({ resumeToken: 'r' }));
      await connecting;
      await adapter.disconnect();
    });
  });

  describe('close codes (§1.3, §1.5)', () => {
    it('reconnects with resume within two seconds after 1012', async () => {
      const { socket } = await join({ resumeToken: 'resume-1' });
      jest.spyOn(Math, 'random').mockReturnValue(0.5);

      const before = FakeWebSocket.instances.length;
      const closedAt = Date.now();
      socket.close(1012);
      const next = await waitForNewSocket(before, 2_500);

      // 0.5 of the 2 s window, not the normal backoff.
      expect(Date.now() - closedAt).toBeGreaterThanOrEqual(900);
      expect(Date.now() - closedAt).toBeLessThan(2_000);
      expect(next.lastSent('room.join')).toEqual(expect.objectContaining({ resume: { token: 'resume-1' } }));
    });

    it('does not reconnect after 4003, and reports REMOVED', async () => {
      const { adapter, socket, events } = await join();
      await bringUpMedia(socket);
      const camera = await adapter.enableCamera(true);

      const before = FakeWebSocket.instances.length;
      socket.close(4003);
      await flush();

      expect(events.disconnected).toEqual(['REMOVED']);
      expect(events.errors).toHaveLength(0);
      expect(adapter.connectionState).toBe('disconnected');
      // The camera is released; nobody is going to publish it again.
      expect((camera!.mediaStreamTrack as unknown as { stopped: boolean }).stopped).toBe(true);
      await assertNoNewSocket(before);
    });

    it('reports the room.left reason and does not reconnect', async () => {
      const { socket, events } = await join();

      const before = FakeWebSocket.instances.length;
      socket.receive({ type: 'room.left', reason: 'ROOM_CLOSED' });
      socket.close(4003);
      await flush();

      expect(events.disconnected).toEqual(['ROOM_CLOSED']);
      await assertNoNewSocket(before);
    });

    it('reports REMOVED from room.left even if the server never closes the socket', async () => {
      const { socket, events } = await join();

      socket.receive({ type: 'room.left', reason: 'REMOVED' });
      await flush();

      expect(events.disconnected).toEqual(['REMOVED']);
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    });

    it('refreshes the token and reconnects, fresh, after 4001', async () => {
      const fresh = token({ jti: 'after-4001' });
      const refreshToken = jest.fn().mockResolvedValue(fresh);
      const { socket, events } = await join({ refreshToken, resumeToken: 'resume-1' });

      const before = FakeWebSocket.instances.length;
      socket.receive({ type: 'error', code: 'TOKEN_EXPIRED', message: 'RTC token has expired' });
      socket.close(4001);
      const next = await waitForNewSocket(before);

      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(next.url).toContain(encodeURIComponent(fresh));
      // The server dropped the SFU session with the socket, so there is
      // nothing to resume.
      expect(next.lastSent('room.join')).not.toHaveProperty('resume');
      next.receive(joinedFrame());
      await flush();
      expect(events.disconnected).toHaveLength(0);
    });

    it('disconnects with TOKEN_EXPIRED after 4001 when there is no refreshToken', async () => {
      const { adapter, socket, events } = await join();

      const before = FakeWebSocket.instances.length;
      socket.receive({ type: 'error', code: 'TOKEN_EXPIRED', message: 'RTC token has expired' });
      socket.close(4001);
      await flush();

      expect(adapter.connectionState).toBe('failed');
      expect(events.disconnected).toEqual(['TOKEN_EXPIRED']);
      expect(events.errors.map((error) => error.code)).toEqual(['TOKEN_EXPIRED']);
      await assertNoNewSocket(before);
    });

    it('does not keep reconnecting after a first join is rejected', async () => {
      const adapter = new SwalvoAdapter(createLogger('silent'), true);
      const connecting = adapter.connect(ENDPOINT, TOKEN, []);
      await flush();
      const socket = FakeWebSocket.latest;
      socket.receive({ type: 'error', code: 'ROOM_FULL', message: 'full' });
      await expect(connecting).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });

      const before = FakeWebSocket.instances.length;
      socket.close(4001);
      await assertNoNewSocket(before);
    });
  });

  describe('media failure with signaling up', () => {
    it('rejoins with a new PeerConnection and republishes, then reports reconnected', async () => {
      const { adapter, socket, events } = await join({ resumeToken: 'resume-1' });
      const pc = await bringUpMedia(socket);
      await adapter.enableCamera(true);
      await settle(socket, pc);

      const before = FakeWebSocket.instances.length;
      pc.setConnectionState('failed');
      expect(adapter.connectionState).toBe('reconnecting');
      expect(events.reconnecting).toBe(1);

      const next = await waitForNewSocket(before);
      expect(pc.closed).toBe(true);
      // A resume would re-bind the session whose media just died.
      expect(next.lastSent('room.join')).not.toHaveProperty('resume');

      next.receive(joinedFrame({ resumeToken: 'resume-2' }));
      await flush();
      const replacement = FakeRTCPeerConnection.latest;
      expect(replacement).not.toBe(pc);
      expect(replacement.activeSenders('video')).toHaveLength(1);
      expect(next.lastSent('track.publish')).toEqual(expect.objectContaining({ source: 'camera' }));

      await settle(next, replacement);
      replacement.setConnectionState('connected');
      expect(events.reconnected).toBe(1);
      expect(events.disconnected).toHaveLength(0);
    });

    it('still fails at once when autoReconnect is off', async () => {
      const { adapter, socket, events } = await join({ autoReconnect: false });
      const pc = await bringUpMedia(socket);

      pc.setConnectionState('failed');

      expect(adapter.connectionState).toBe('failed');
      expect(events.disconnected).toEqual(['CONNECTION_FAILED']);
    });
  });

  describe('server-driven ICE restart (§2.6)', () => {
    it('answers a restart offer without treating it as a track change', async () => {
      const { room, socket, events } = await join();
      const pc = await bringUpMedia(socket);
      const trackEvents: string[] = [];
      room.on('trackSubscribed', () => trackEvents.push('subscribed'));
      room.on('trackUnsubscribed', () => trackEvents.push('unsubscribed'));
      room.on('trackPublished', () => trackEvents.push('published'));

      socket.receive({ type: 'sdp.offer', sdp: 'v=0\r\na=ice-ufrag:restarted\r\na=ice-pwd:new' });
      await flush();

      expect(socket.lastSent('sdp.answer')).toBeDefined();
      expect(FakeRTCPeerConnection.latest).toBe(pc);
      expect(trackEvents).toEqual([]);
      expect(events.errors).toEqual([]);
    });
  });

  describe('network change', () => {
    it('restarts ICE on a live connection', async () => {
      const { room, socket } = await join();
      const pc = await bringUpMedia(socket);
      const createOffer = jest.spyOn(pc, 'createOffer');

      room.handleNetworkChange();
      await flush();

      expect(createOffer).toHaveBeenCalledWith({ iceRestart: true });
      expect(socket.lastSent('sdp.offer')).toBeDefined();
    });

    it('runs a pending reconnect now instead of waiting out its backoff', async () => {
      const { room, socket } = await join();
      jest.spyOn(Math, 'random').mockReturnValue(0.99);

      const before = FakeWebSocket.instances.length;
      socket.close(1006);
      await flush();
      expect(FakeWebSocket.instances).toHaveLength(before);

      room.handleNetworkChange();
      await flush();

      expect(FakeWebSocket.instances).toHaveLength(before + 1);
    });
  });

  describe('live permission changes (§1.4)', () => {
    it('starts from the token grants', async () => {
      const { room } = await join();
      expect(room.permissions).toEqual({
        subscribe: true,
        publish: true,
        publishAudio: true,
        publishVideo: true,
        publishScreen: false,
        publishData: true,
      });
    });

    it('stops publications whose right was withdrawn, without an error', async () => {
      const { room, adapter, socket, events } = await join();
      const pc = await bringUpMedia(socket);
      const microphone = await adapter.enableMicrophone(true);
      const camera = await adapter.enableCamera(true);
      await settle(socket, pc);

      const changes: ParticipantPermissions[] = [];
      const unpublished: TrackKind[] = [];
      room.on('permissionsChanged', (permissions) => changes.push(permissions));
      room.on('localTrackUnpublished', (track) => unpublished.push(track.kind));

      socket.receive({
        type: 'participant.permissions_updated',
        permissions: { subscribe: true, publish: true, publishAudio: true, publishVideo: false, publishData: true },
      });
      await settle(socket, pc);

      expect(changes).toEqual([expect.objectContaining({ publishVideo: false, publishAudio: true })]);
      expect(room.permissions?.publishVideo).toBe(false);
      expect(unpublished).toEqual(['camera']);
      expect((camera!.mediaStreamTrack as unknown as { stopped: boolean }).stopped).toBe(true);
      expect((microphone!.mediaStreamTrack as unknown as { stopped: boolean }).stopped).toBe(false);
      expect(events.errors).toEqual([]);
    });

    it('stops a screen share whose right was withdrawn, independently of camera (agora-parity audit, phase 2)', async () => {
      const { room, adapter, socket } = await join();
      const pc = await bringUpMedia(socket);
      // Promote: grant publishScreen on top of the token's default grants.
      socket.receive({
        type: 'participant.permissions_updated',
        permissions: {
          subscribe: true,
          publish: true,
          publishAudio: true,
          publishVideo: true,
          publishScreen: true,
          publishData: true,
        },
      });
      await flush();

      const camera = await adapter.enableCamera(true);
      const screen = await adapter.enableScreenShare(true);
      await settle(socket, pc);

      const unpublished: TrackKind[] = [];
      room.on('localTrackUnpublished', (track) => unpublished.push(track.kind));

      // Demoted again: screen share revoked, camera untouched.
      socket.receive({
        type: 'participant.permissions_updated',
        permissions: {
          subscribe: true,
          publish: true,
          publishAudio: true,
          publishVideo: true,
          publishScreen: false,
          publishData: true,
        },
      });
      await settle(socket, pc);

      expect(unpublished).toEqual(['screenShare']);
      expect((screen!.mediaStreamTrack as unknown as { stopped: boolean }).stopped).toBe(true);
      expect((camera!.mediaStreamTrack as unknown as { stopped: boolean }).stopped).toBe(false);
    });

    it('lets a promoted viewer publish on the same connection', async () => {
      const { room, adapter, socket } = await join();
      const pc = await bringUpMedia(socket);
      socket.receive({
        type: 'participant.permissions_updated',
        permissions: { subscribe: true, publish: false, publishAudio: false, publishVideo: false, publishData: false },
      });
      await flush();

      const before = FakeWebSocket.instances.length;
      socket.receive({
        type: 'participant.permissions_updated',
        permissions: { subscribe: true, publish: true, publishAudio: true, publishVideo: true, publishData: true },
      });
      await flush();
      await room.enableCamera();
      await settle(socket, pc);

      expect(FakeWebSocket.instances).toHaveLength(before);
      expect(pc.activeSenders('video')).toHaveLength(1);
      expect(adapter.connectionState).toBe('connected');
    });
  });

  describe('server mute (§1.6)', () => {
    it('mutes the local track and says so', async () => {
      const { room, adapter, socket } = await join();
      const pc = await bringUpMedia(socket);
      const microphone = await adapter.enableMicrophone(true);
      await settle(socket, pc);
      const muted: LocalTrack[] = [];
      const remoteMutes: TrackKind[] = [];
      room.on('localTrackMutedByServer', (track) => muted.push(track));
      room.on('trackMuted', (kind) => remoteMutes.push(kind));

      socket.receive({
        type: 'track.muted',
        participantId: 'alice',
        trackId: microphone!.mediaStreamTrack.id,
        byServer: true,
      });
      await flush();

      expect(muted).toEqual([microphone]);
      expect(microphone!.isMuted).toBe(true);
      expect(microphone!.mediaStreamTrack.enabled).toBe(false);
      expect(remoteMutes).toEqual([]);
    });

    it('ignores byServer on somebody else', async () => {
      const { room, adapter, socket } = await join();
      const pc = await bringUpMedia(socket);
      const microphone = await adapter.enableMicrophone(true);
      await settle(socket, pc);
      const muted: LocalTrack[] = [];
      room.on('localTrackMutedByServer', (track) => muted.push(track));

      socket.receive({ type: 'track.muted', participantId: 'bob', trackId: 'whatever', byServer: true });
      await flush();

      expect(muted).toEqual([]);
      expect(microphone!.isMuted).toBe(false);
    });
  });

  describe('leaving', () => {
    it('reports CLIENT_INITIATED for a deliberate leave', async () => {
      const { room, events } = await join();
      await room.leave();
      rooms.splice(rooms.indexOf(room), 1);
      expect(events.disconnected).toEqual(['CLIENT_INITIATED']);
    });
  });
});
