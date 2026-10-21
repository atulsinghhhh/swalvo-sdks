import { HlsPlayback } from '../src/live/hls-playback';

function fakeVideo(nativeHls: boolean) {
  const listeners: Record<string, () => void> = {};
  return {
    src: '',
    canPlayType: (t: string) => (nativeHls && t === 'application/vnd.apple.mpegurl' ? 'maybe' : ''),
    play: jest.fn().mockResolvedValue(undefined),
    addEventListener: (e: string, h: () => void) => (listeners[e] = h),
    removeAttribute: jest.fn(),
    load: jest.fn(),
    fire: (e: string) => listeners[e]?.(),
  };
}

function fakeHlsModule() {
  const instances: any[] = [];
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'hlsError' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    handlers: Record<string, (e: string, d: unknown) => void> = {};
    loadSource = jest.fn();
    attachMedia = jest.fn();
    startLoad = jest.fn();
    destroy = jest.fn();
    constructor(readonly config: Record<string, unknown>) {
      instances.push(this);
    }
    on(e: string, h: (e: string, d: unknown) => void) {
      this.handlers[e] = h;
    }
  }
  return { mod: { default: Hls }, instances };
}

describe('HlsPlayback', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('plays natively where the browser can (Safari), retrying while the manifest is missing', async () => {
    const loader = jest.fn();
    const video = fakeVideo(true);
    const p = new HlsPlayback('https://cdn/x/master.m3u8', loader);
    await p.attach(video as never);
    expect(video.src).toBe('https://cdn/x/master.m3u8');
    expect(loader).not.toHaveBeenCalled(); // no hls.js download on Safari
    video.src = '';
    video.fire('error');
    jest.advanceTimersByTime(2000);
    expect(video.src).toBe('https://cdn/x/master.m3u8');
  });

  it('uses hls.js elsewhere with live-edge settings, and retries network errors while the stream starts', async () => {
    const { mod, instances } = fakeHlsModule();
    const p = new HlsPlayback('https://cdn/x/master.m3u8', async () => mod as never);
    const video = fakeVideo(false);
    await p.attach(video as never);
    const hls = instances[0];
    expect(hls.config).toMatchObject({ liveSyncDurationCount: 2, maxLiveSyncPlaybackRate: 1.1 });
    expect(hls.loadSource).toHaveBeenCalledWith('https://cdn/x/master.m3u8');
    expect(hls.attachMedia).toHaveBeenCalledWith(video);

    hls.handlers.hlsError('hlsError', { fatal: true, type: 'networkError' });
    jest.advanceTimersByTime(2000);
    expect(hls.loadSource).toHaveBeenCalledTimes(2);

    p.detach();
    expect(hls.destroy).toHaveBeenCalled();
  });

  it('prefers the LL-HLS URL in low-latency mode, and falls back to the standard URL when it fails', async () => {
    const { mod, instances } = fakeHlsModule();
    const p = new HlsPlayback(
      'https://cdn/x/master.m3u8',
      async () => mod as never,
      'https://egress-1/llhls/x/master.m3u8',
    );
    const video = fakeVideo(false);
    await p.attach(video as never);
    expect(instances[0].config).toMatchObject({ lowLatencyMode: true });
    expect(instances[0].loadSource).toHaveBeenCalledWith('https://egress-1/llhls/x/master.m3u8');

    instances[0].handlers.hlsError('hlsError', { fatal: true, type: 'mediaError' });
    await Promise.resolve();
    await Promise.resolve();
    expect(instances[0].destroy).toHaveBeenCalled();
    expect(p.isLowLatency).toBe(false);
    expect(instances[1].config).toMatchObject({ liveSyncDurationCount: 2 });
    expect(instances[1].loadSource).toHaveBeenCalledWith('https://cdn/x/master.m3u8');
  });

  it('native players also start on LL-HLS and drop to the standard URL on error', async () => {
    const video = fakeVideo(true);
    const p = new HlsPlayback('https://cdn/x/master.m3u8', jest.fn(), 'https://egress-1/llhls/x/master.m3u8');
    await p.attach(video as never);
    expect(video.src).toBe('https://egress-1/llhls/x/master.m3u8');
    video.fire('error');
    jest.advanceTimersByTime(2000);
    expect(video.src).toBe('https://cdn/x/master.m3u8');
  });

  it('pins an hls.js rung (top rung first) and returns to ABR on auto', async () => {
    const { mod, instances } = fakeHlsModule();
    const p = new HlsPlayback('https://cdn/x/master.m3u8', async () => mod as never);
    p.setQuality('medium');
    await p.attach(fakeVideo(false) as never);
    expect(instances[0].config).toMatchObject({ startLevel: 1 });
    p.setQuality('low');
    expect(instances[0].currentLevel).toBe(2);
    p.setQuality('auto');
    expect(instances[0].currentLevel).toBe(-1);
  });

  it('sends the watch-time beacon only while the video is playing, and stops on detach', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    const { mod } = fakeHlsModule();
    const p = new HlsPlayback('https://cdn/x/master.m3u8', async () => mod as never, null, {
      url: 'https://api/v1/live-streams/playback/heartbeat',
      token: 'tok',
      intervalSec: 30,
    });
    const video = { ...fakeVideo(false), paused: true, ended: false, readyState: 4 };
    await p.attach(video as never);
    jest.advanceTimersByTime(30_000);
    expect(fetchMock).not.toHaveBeenCalled(); // paused
    video.paused = false;
    jest.advanceTimersByTime(30_000);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api/v1/live-streams/playback/heartbeat',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'tok' }) }),
    );
    p.detach();
    jest.advanceTimersByTime(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('explains how to fix a missing hls.js', async () => {
    const p = new HlsPlayback('https://cdn/x/master.m3u8', async () => {
      throw new Error('Cannot find module');
    });
    await expect(p.attach(fakeVideo(false) as never)).rejects.toThrow(/npm install hls\.js/);
  });
});
