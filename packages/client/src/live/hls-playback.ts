/**
 * HLS playback for a BROADCAST stream's audience (live-streaming-v2.md
 * §3.5), so one `LiveStream.join()` works for every delivery mode.
 *
 * Safari (and iOS) play HLS natively; everywhere else this loads hls.js,
 * an optional peer dependency fetched only when a viewer actually gets a
 * playback credential, so RTC-only apps never pay for it.
 *
 * Tuned for live, not VOD: start two segments from the live edge (~4-6 s
 * behind with 2 s segments) and speed up slightly to catch back up after a
 * stall, rather than drifting further behind.
 *
 * With a `lowLatencyUrl` (the egress worker's LL-HLS origin,
 * phase4-contracts.md §2.1) it plays that first, about 2 s behind live,
 * using hls.js's LL-HLS mode or Safari's native support. If the
 * low-latency origin fails, it falls back to the standard URL for good.
 */

interface HlsLike {
  loadSource(url: string): void;
  attachMedia(media: HTMLMediaElement): void;
  on(event: string, handler: (event: string, data: { fatal?: boolean; type?: string; details?: string }) => void): void;
  startLoad(): void;
  destroy(): void;
  /** -1 = automatic (ABR); otherwise the rung index, 0 = the top rung. */
  currentLevel: number;
}

interface HlsModule {
  default: {
    new (config: Record<string, unknown>): HlsLike;
    isSupported(): boolean;
    Events: { ERROR: string };
    ErrorTypes: { NETWORK_ERROR: string; MEDIA_ERROR: string };
  };
}

export type HlsLoader = () => Promise<HlsModule>;

/** Where to report watch time (the credential's `playback.beacon`): viewer-minute billing. */
export interface PlaybackBeacon {
  url: string;
  token: string;
  intervalSec: number;
}

const defaultLoader: HlsLoader = () => import('hls.js') as unknown as Promise<HlsModule>;

/** How long to wait between attempts while the manifest isn't published yet (stream STARTING). */
const RETRY_MS = 2000;

export class HlsPlayback {
  private hls?: HlsLike;
  private video?: HTMLVideoElement;
  private retry?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private lowLatency: boolean;
  private beaconTimer?: ReturnType<typeof setInterval>;
  private quality: 'auto' | 'high' | 'medium' | 'low' = 'auto';

  constructor(
    readonly url: string,
    private readonly loader: HlsLoader = defaultLoader,
    readonly lowLatencyUrl: string | null = null,
    private readonly beacon: PlaybackBeacon | null = null,
  ) {
    this.lowLatency = Boolean(lowLatencyUrl);
  }

  /**
   * Reports watch time every `intervalSec` while the video is actually
   * playing (not paused, not stalled before the first frame). Best-effort:
   * a failed beat is dropped, never retried, and never affects playback.
   */
  private startBeacon(video: HTMLVideoElement): void {
    const beacon = this.beacon;
    if (!beacon || this.beaconTimer || typeof fetch !== 'function') return;
    this.beaconTimer = setInterval(
      () => {
        if (this.destroyed || video.paused || video.ended || video.readyState < 2) return;
        void fetch(beacon.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: beacon.token }),
          keepalive: true,
        }).catch(() => undefined);
      },
      Math.max(5, beacon.intervalSec) * 1000,
    );
  }

  /** The URL currently being played: LL-HLS until it fails, then the standard one. */
  get currentUrl(): string {
    return this.lowLatency && this.lowLatencyUrl ? this.lowLatencyUrl : this.url;
  }

  /**
   * Pins a rung (the master lists the top rung first) or returns to ABR.
   * hls.js only: Safari's native player always chooses for itself.
   */
  setQuality(quality: 'auto' | 'high' | 'medium' | 'low'): void {
    this.quality = quality;
    if (this.hls) this.hls.currentLevel = HlsPlayback.levelOf(quality);
  }

  private static levelOf(quality: 'auto' | 'high' | 'medium' | 'low'): number {
    return quality === 'high' ? 0 : quality === 'medium' ? 1 : quality === 'low' ? 2 : -1;
  }

  /** Whether playback is on the low-latency origin. */
  get isLowLatency(): boolean {
    return this.lowLatency;
  }

  /** Starts playing into `video`. Resolves once playback has been set up (not once the first frame shows). */
  async attach(video: HTMLVideoElement): Promise<void> {
    this.detach();
    this.destroyed = false;
    this.video = video;
    this.startBeacon(video);
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS: retry by re-assigning src while the manifest 404s.
      const onError = () => {
        if (this.destroyed) return;
        // The LL-HLS origin lives on the worker; once it fails, use the CDN copy.
        this.lowLatency = false;
        this.retry = setTimeout(() => {
          video.src = this.currentUrl;
          void video.play().catch(() => undefined);
        }, RETRY_MS);
      };
      video.addEventListener('error', onError);
      video.src = this.currentUrl;
      void video.play().catch(() => undefined);
      return;
    }

    let mod: HlsModule;
    try {
      mod = await this.loader();
    } catch {
      throw new Error(
        'This stream is delivered over HLS, and this browser needs hls.js to play it. Install it: `npm install hls.js`.',
      );
    }
    const Hls = mod.default;
    if (!Hls.isSupported()) throw new Error('This browser supports neither native HLS nor Media Source Extensions.');
    const hls = new Hls(
      this.lowLatency
        ? {
            // LL-HLS: hls.js follows the playlist's PART-HOLD-BACK and blocking reloads.
            lowLatencyMode: true,
            startLevel: HlsPlayback.levelOf(this.quality),
            maxLiveSyncPlaybackRate: 1.2,
            backBufferLength: 30,
            manifestLoadingMaxRetry: 0,
          }
        : {
            startLevel: HlsPlayback.levelOf(this.quality),
            liveSyncDurationCount: 2,
            liveMaxLatencyDurationCount: 6,
            maxLiveSyncPlaybackRate: 1.1,
            backBufferLength: 30,
            manifestLoadingMaxRetry: 0, // we retry ourselves, forever, while the stream starts
          },
    );
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || this.destroyed) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR || this.lowLatency) {
        if (this.lowLatency) {
          // The low-latency origin failed: start over on the standard URL.
          this.lowLatency = false;
          void this.attach(video);
          return;
        }
        // Most often: the manifest isn't up yet because the stream is
        // still STARTING. Keep trying.
        this.retry = setTimeout(() => {
          hls.loadSource(this.url);
          hls.startLoad();
        }, RETRY_MS);
      }
    });
    hls.loadSource(this.currentUrl);
    hls.attachMedia(video);
    this.hls = hls;
    void video.play().catch(() => undefined);
  }

  /** Stops playback and releases the element. */
  detach(): void {
    this.destroyed = true;
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    this.beaconTimer = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.hls?.destroy();
    this.hls = undefined;
    if (this.video) {
      this.video.removeAttribute('src');
      this.video.load?.();
      this.video = undefined;
    }
  }
}
