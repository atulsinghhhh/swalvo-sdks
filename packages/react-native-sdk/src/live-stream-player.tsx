import React, { useEffect, useRef, useState } from 'react';
import type { ViewStyle } from 'react-native';

export interface LiveStreamPlayerProps {
  /** `stream.playbackUrl` of an HLS viewer (`stream.delivery === 'hls'`). */
  url: string;
  /**
   * `stream.lowLatencyPlaybackUrl`: LL-HLS (about 2 s behind live), played
   * first when given. AVPlayer and ExoPlayer support LL-HLS natively; on
   * any error the player switches to `url` for good.
   */
  lowLatencyUrl?: string | null;
  style?: ViewStyle;
  /** `'contain'` (default) letterboxes, `'cover'` crops to fill. */
  resizeMode?: 'contain' | 'cover';
  /** Wait between attempts while the stream is still starting and the manifest 404s. */
  retryMs?: number;
  /**
   * `stream.playbackBeacon`: watch-time heartbeat for viewer-minute billing.
   * Sent every `intervalSec` while the video is actually playing.
   */
  beacon?: { url: string; token: string; intervalSec: number } | null;
}

type VideoComponent = React.ComponentType<Record<string, unknown>>;

/** react-native-video is an optional peer dependency: only HLS viewers need it. */
function loadVideo(): VideoComponent {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-video') as { default?: VideoComponent };
    if (mod.default) return mod.default;
  } catch {
    // fall through
  }
  throw new Error(
    'LiveStreamPlayer plays HLS with react-native-video. Install it: `npm install react-native-video`, then rebuild the app.',
  );
}

/**
 * Plays a BROADCAST stream's HLS for a viewer (docs/architecture/
 * live-streaming-v2.md §3.5), on the platform players (AVPlayer, ExoPlayer),
 * which handle ABR and the live edge themselves.
 *
 * While the stream is starting the manifest may not exist yet, so a load
 * error remounts the player after `retryMs` until it plays.
 */
export function LiveStreamPlayer({
  url,
  lowLatencyUrl,
  style,
  resizeMode = 'contain',
  retryMs = 2000,
  beacon,
}: LiveStreamPlayerProps) {
  const Video = useRef<VideoComponent>(loadVideo()).current;
  const [attempt, setAttempt] = useState(0);
  const [lowLatency, setLowLatency] = useState(Boolean(lowLatencyUrl));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    setAttempt(0);
    setLowLatency(Boolean(lowLatencyUrl));
  }, [url, lowLatencyUrl]);
  const current = lowLatency && lowLatencyUrl ? lowLatencyUrl : url;

  // Playing = a progress event in the last few seconds (react-native-video
  // stops sending them when paused, stalled or backgrounded).
  const lastProgress = useRef(0);
  useEffect(() => {
    if (!beacon) return;
    const every = Math.max(5, beacon.intervalSec) * 1000;
    const id = setInterval(() => {
      if (Date.now() - lastProgress.current > 5000) return;
      void fetch(beacon.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: beacon.token }),
      }).catch(() => undefined);
    }, every);
    return () => clearInterval(id);
  }, [beacon?.url, beacon?.token, beacon?.intervalSec]);

  return (
    <Video
      key={`${current}#${attempt}`}
      source={{ uri: current, type: 'm3u8' }}
      style={style}
      resizeMode={resizeMode}
      paused={false}
      playInBackground={false}
      onProgress={() => {
        lastProgress.current = Date.now();
      }}
      onError={() => {
        clearTimeout(timer.current);
        if (lowLatency) {
          // The low-latency origin lives on the egress worker; fall back to the CDN copy.
          setLowLatency(false);
          return;
        }
        timer.current = setTimeout(() => setAttempt((n) => n + 1), retryMs);
      }}
    />
  );
}
