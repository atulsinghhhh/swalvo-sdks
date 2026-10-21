import { createCustomTrack } from '../src/internal/media/capture';
import { SwalvoAdapter } from '../src/internal/sfu/swalvo-adapter';
import { createLogger } from '../src/logger';
import { LocalTrack } from '../src/track';
import {
  FakeMediaStreamTrack,
  FakeRTCPeerConnection,
  FakeWebSocket,
  fakeToken,
  flush,
  installFakeMediaDevices,
  installFakeWebRTC,
} from './helpers/fake-webrtc';

/**
 * Application-provided media sources.
 *
 * `LocalTrack` and `LocalTrackDelegate` are both public, so building a
 * track by hand looked supported — and then `room.publish()` refused it,
 * because publishing needs a delegate it can hand an `RTCRtpSender` to.
 * `createCustomTrack()` is the way through: a real internal delegate
 * around a track the application already has, with no loosening of what
 * `publish()` accepts.
 */

const TOKEN = fakeToken({
  sub: 'alice',
  rid: 'room-1',
  perms: { join: true, publish: true, publishAudio: true, publishVideo: true },
});

function canvasLikeTrack(kind: 'audio' | 'video' = 'video'): MediaStreamTrack {
  return new FakeMediaStreamTrack(kind, `app-${kind}`) as unknown as MediaStreamTrack;
}

describe('createCustomTrack', () => {
  it('wraps an application track as a publishable LocalTrack', () => {
    const track = createCustomTrack(canvasLikeTrack());

    expect(track).toBeInstanceOf(LocalTrack);
    expect(track.kind).toBe('camera');
    expect(track.mediaStreamTrack.id).toBe('app-video');
  });

  it('takes the source from the caller, so a canvas can stand in for a screen share', () => {
    const track = createCustomTrack(canvasLikeTrack(), { source: 'screenShare' });
    expect(track.kind).toBe('screenShare');
  });

  it('defaults an audio track to the microphone source', () => {
    expect(createCustomTrack(canvasLikeTrack('audio')).kind).toBe('microphone');
  });

  it('refuses a source that contradicts the track kind', () => {
    expect(() => createCustomTrack(canvasLikeTrack('audio'), { source: 'camera' })).toThrow(/video MediaStreamTrack/);
    expect(() => createCustomTrack(canvasLikeTrack('video'), { source: 'microphone' })).toThrow(
      /audio MediaStreamTrack/,
    );
  });

  it('refuses a track that has already ended', () => {
    // Publishing one negotiates an m-section that never carries a frame,
    // which shows up as "no media" rather than as anything debuggable.
    const ended = new FakeMediaStreamTrack('video', 'dead');
    ended.stop();
    expect(() => createCustomTrack(ended as unknown as MediaStreamTrack)).toThrow(/already ended/);
  });

  it('refuses something that is not a MediaStreamTrack at all', () => {
    expect(() => createCustomTrack({} as MediaStreamTrack)).toThrow(/needs a MediaStreamTrack/);
  });
});

describe('publishing a custom track', () => {
  let teardown: () => void;
  const adapters: SwalvoAdapter[] = [];

  beforeEach(() => {
    teardown = installFakeWebRTC();
    installFakeMediaDevices();
  });

  afterEach(async () => {
    while (adapters.length > 0) {
      await adapters.pop()?.disconnect();
    }
    teardown();
  });

  async function connected(): Promise<{ adapter: SwalvoAdapter; socket: FakeWebSocket }> {
    const adapter = new SwalvoAdapter(createLogger('silent'), true);
    const connecting = adapter.connect('ws://localhost:4000/v1/rtc', TOKEN, []);
    await flush();
    const socket = FakeWebSocket.latest;
    socket.receive({ type: 'room.joined', roomId: 'room-1', participants: [] });
    await connecting;
    adapters.push(adapter);
    return { adapter, socket };
  }

  it('publishes it like any captured track, source declaration included', async () => {
    const { adapter, socket } = await connected();

    await adapter.publish(createCustomTrack(canvasLikeTrack(), { source: 'camera' }));
    await flush();

    const pc = FakeRTCPeerConnection.latest;
    expect(pc.activeSenders('video')).toHaveLength(1);
    expect(socket.lastSent('track.publish')).toMatchObject({
      trackId: 'app-video',
      source: 'camera',
    });
    expect(socket.lastSent('sdp.offer')).toBeDefined();
  });

  it('still refuses a hand-rolled LocalTrack, and says what to do instead', async () => {
    const { adapter } = await connected();

    const handRolled = {
      kind: 'camera',
      mediaStreamTrack: canvasLikeTrack(),
      delegate: {},
    };

    await expect(adapter.publish(handRolled as never)).rejects.toMatchObject({
      code: 'MEDIA_ERROR',
      message: expect.stringContaining('createCustomTrack()'),
    });
  });
});
