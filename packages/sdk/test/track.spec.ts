import { LocalTrack, RemoteTrack } from '../src/track';
import type { LocalTrackDelegate, RemoteTrackDelegate, TrackDelegate } from '../src/track';
import type { RawTrackStats } from '../src/internal/telemetry/track-stats';

function fakeMediaStreamTrack(): MediaStreamTrack {
  return { id: 'track-1', stop: jest.fn() } as unknown as MediaStreamTrack;
}

function fakeDelegate(overrides: Partial<LocalTrackDelegate> = {}): LocalTrackDelegate {
  return {
    mediaStreamTrack: fakeMediaStreamTrack(),
    mediaStream: undefined,
    isMuted: false,
    attach: jest.fn((el?: HTMLMediaElement) => el ?? document.createElement('video')),
    detach: jest.fn((el?: HTMLMediaElement) => (el ? el : [])),
    mute: jest.fn().mockResolvedValue(undefined),
    unmute: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('RemoteTrack', () => {
  it('exposes kind, mediaStreamTrack, mediaStream, and isMuted from its delegate', () => {
    const delegate: TrackDelegate = {
      mediaStreamTrack: fakeMediaStreamTrack(),
      mediaStream: new MediaStream(),
      isMuted: true,
      attach: jest.fn(() => document.createElement('video')),
      detach: jest.fn(() => []),
    };

    const track = new RemoteTrack(delegate, 'camera');

    expect(track.kind).toBe('camera');
    expect(track.mediaStreamTrack).toBe(delegate.mediaStreamTrack);
    expect(track.mediaStream).toBe(delegate.mediaStream);
    expect(track.isMuted).toBe(true);
  });

  it('attach() delegates to the underlying track and returns the element', () => {
    const delegate = fakeDelegate();
    const track = new RemoteTrack(delegate, 'microphone');
    const el = document.createElement('audio');

    const result = track.attach(el);

    expect(delegate.attach).toHaveBeenCalledWith(el);
    expect(result).toBe(el);
  });

  it('detach() always normalizes to an array, whether the delegate returns one element or a list', () => {
    const el = document.createElement('video');
    const singleReturnDelegate = fakeDelegate({ detach: jest.fn(() => el) });
    const arrayReturnDelegate = fakeDelegate({ detach: jest.fn(() => [el]) });

    expect(new RemoteTrack(singleReturnDelegate, 'camera').detach(el)).toEqual([el]);
    expect(new RemoteTrack(arrayReturnDelegate, 'camera').detach()).toEqual([el]);
  });
});

describe('LocalTrack', () => {
  it('mute()/unmute() delegate to the underlying track', async () => {
    const delegate = fakeDelegate();
    const track = new LocalTrack(delegate, 'camera');

    await track.mute();
    await track.unmute();

    expect(delegate.mute).toHaveBeenCalledTimes(1);
    expect(delegate.unmute).toHaveBeenCalledTimes(1);
  });

  it('stop() stops the underlying native MediaStreamTrack', () => {
    const delegate = fakeDelegate();
    const track = new LocalTrack(delegate, 'microphone');

    track.stop();

    expect(delegate.mediaStreamTrack.stop).toHaveBeenCalledTimes(1);
  });
});

describe('LocalTrack.getStats()', () => {
  it('returns undefined when the delegate has no stats capability at all', async () => {
    // A plain TrackDelegate-shaped fake with no getSenderStats still has
    // to satisfy LocalTrackDelegate. The method is additive, not required.
    const track = new LocalTrack(fakeDelegate({ getSenderStats: undefined }), 'microphone');

    await expect(track.getStats()).resolves.toBeUndefined();
  });

  it('returns undefined when the delegate resolves to nothing', async () => {
    const track = new LocalTrack(
      fakeDelegate({ getSenderStats: jest.fn().mockResolvedValue(undefined) }),
      'microphone',
    );

    await expect(track.getStats()).resolves.toBeUndefined();
  });

  it('normalizes a single (audio-shaped) sample as a send-direction stat', async () => {
    const raw: RawTrackStats = { timestamp: 1000, jitter: 0.01, packetsLost: 0, packetsSent: 100 };
    const track = new LocalTrack(fakeDelegate({ getSenderStats: jest.fn().mockResolvedValue(raw) }), 'microphone');

    const stats = await track.getStats();

    expect(stats).toMatchObject({ kind: 'microphone', direction: 'send', jitterMs: 10 });
  });

  it('picks the best simulcast layer out of an array (video-shaped) sample', async () => {
    const layers: RawTrackStats[] = [
      { timestamp: 1000, frameWidth: 320 },
      { timestamp: 1000, frameWidth: 1280 },
    ];
    const track = new LocalTrack(fakeDelegate({ getSenderStats: jest.fn().mockResolvedValue(layers) }), 'camera');

    const stats = await track.getStats();

    expect(stats?.frameWidth).toBe(1280);
  });

  it('returns undefined when the delegate resolves to an empty layer array', async () => {
    const track = new LocalTrack(fakeDelegate({ getSenderStats: jest.fn().mockResolvedValue([]) }), 'camera');

    await expect(track.getStats()).resolves.toBeUndefined();
  });

  it('computes bitrate across two calls, using its own remembered previous sample', async () => {
    const getSenderStats = jest
      .fn()
      .mockResolvedValueOnce({ timestamp: 0, bytesSent: 0 })
      .mockResolvedValueOnce({ timestamp: 1000, bytesSent: 12_500 });
    const track = new LocalTrack(fakeDelegate({ getSenderStats }), 'microphone');

    const first = await track.getStats();
    const second = await track.getStats();

    expect(first?.bitrateBps).toBeUndefined();
    expect(second?.bitrateBps).toBeCloseTo(100_000);
  });
});

describe('RemoteTrack.getStats()', () => {
  function fakeRemoteDelegate(overrides: Partial<RemoteTrackDelegate> = {}): RemoteTrackDelegate {
    return {
      mediaStreamTrack: fakeMediaStreamTrack(),
      mediaStream: undefined,
      isMuted: false,
      attach: jest.fn((el?: HTMLMediaElement) => el ?? document.createElement('video')),
      detach: jest.fn((el?: HTMLMediaElement) => (el ? el : [])),
      ...overrides,
    };
  }

  it('returns undefined when the delegate has no receiver-stats capability', async () => {
    const track = new RemoteTrack(fakeRemoteDelegate(), 'camera');

    await expect(track.getStats()).resolves.toBeUndefined();
  });

  it('normalizes a receiver sample as a receive-direction stat', async () => {
    const raw: RawTrackStats = { timestamp: 1000, packetsLost: 2, packetsReceived: 98, mimeType: 'video/VP8' };
    const track = new RemoteTrack(fakeRemoteDelegate({ getReceiverStats: jest.fn().mockResolvedValue(raw) }), 'camera');

    const stats = await track.getStats();

    expect(stats).toMatchObject({ kind: 'camera', direction: 'receive', codec: 'video/VP8' });
    expect(stats?.packetLossPercent).toBeCloseTo(2);
  });

  it('computes bitrate across two calls the same way LocalTrack does', async () => {
    const getReceiverStats = jest
      .fn()
      .mockResolvedValueOnce({ timestamp: 0, bytesReceived: 0 })
      .mockResolvedValueOnce({ timestamp: 1000, bytesReceived: 5_000 });
    const track = new RemoteTrack(fakeRemoteDelegate({ getReceiverStats }), 'microphone');

    await track.getStats();
    const second = await track.getStats();

    expect(second?.bitrateBps).toBeCloseTo(40_000);
  });

  it('keeps its previous-sample state independent per track instance', async () => {
    // Two subscribed tracks polled on the same interval mustn't leak each
    // other's byte counters into a nonsense bitrate.
    const trackA = new RemoteTrack(
      fakeRemoteDelegate({
        getReceiverStats: jest
          .fn()
          .mockResolvedValueOnce({ timestamp: 0, bytesReceived: 0 })
          .mockResolvedValueOnce({ timestamp: 1000, bytesReceived: 1_000 }),
      }),
      'microphone',
    );
    const trackB = new RemoteTrack(
      fakeRemoteDelegate({
        getReceiverStats: jest
          .fn()
          .mockResolvedValueOnce({ timestamp: 0, bytesReceived: 0 })
          .mockResolvedValueOnce({ timestamp: 1000, bytesReceived: 9_000 }),
      }),
      'camera',
    );

    await trackA.getStats();
    await trackB.getStats();
    const statsA = await trackA.getStats();
    const statsB = await trackB.getStats();

    expect(statsA?.bitrateBps).toBeCloseTo(8_000);
    expect(statsB?.bitrateBps).toBeCloseTo(72_000);
  });
});
