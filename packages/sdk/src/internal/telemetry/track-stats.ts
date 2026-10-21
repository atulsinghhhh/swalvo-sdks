import type { TrackKind } from '../../track';

/**
 * One flattened WebRTC stats sample.
 *
 * Duck-typed instead of bound to any particular source, which is how this
 * file survived the move off LiveKit's stats objects to reading an
 * `RTCStatsReport` directly (see `internal/telemetry/rtc-stats.ts`). Every
 * field is a raw WebRTC stat in the units the spec uses, so seconds, not
 * milliseconds. `normalizeTrackStats` below translates into Swalvo's own
 * vocabulary.
 */
export interface RawTrackStats {
  type?: 'audio' | 'video';
  /** Epoch ms: when this sample was taken. Bitrate is a delta against a previous one. */
  timestamp: number;
  /** Seconds, per the WebRTC spec. */
  jitter?: number;
  packetsLost?: number;
  packetsSent?: number;
  packetsReceived?: number;
  /** Seconds. Only ever set on an outbound audio stream; WebRTC reports no RTT for video or for the receive direction. */
  roundTripTime?: number;
  bytesSent?: number;
  bytesReceived?: number;
  /** Receive-direction video only. WebRTC doesn't surface it for audio or for sending. */
  mimeType?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
}

/**
 * Swalvo's own normalized shape. A raw WebRTC stats object never appears on
 * a public class.
 *
 * Every field is optional, and gets omitted, not set to `0` or
 * `null` when the browser or SFU didn't report it. "0% packet loss" and
 * "we don't know" are different facts, and this will not fabricate the
 * first to cover for the second.
 */
export interface TrackStats {
  kind: TrackKind;
  /** 'send' for a track we published, 'receive' for one we subscribed to. */
  direction: 'send' | 'receive';
  /** Bytes/sec, from two consecutive samples. Undefined on a track's first sample, since there's nothing to take a delta against yet. */
  bitrateBps?: number;
  packetsLost?: number;
  /** 0-100. The module doc explains why it's an approximation and not a WebRTC-spec figure. */
  packetLossPercent?: number;
  jitterMs?: number;
  roundTripTimeMs?: number;
  /** Only set for a received video track. See `RawTrackStats.mimeType`. */
  codec?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
}

const MS_PER_SECOND = 1000;

/**
 * Turns one raw WebRTC sample into Swalvo's `TrackStats`, using the previous
 * sample where there is one to work bitrate out as a delta over time.
 *
 * Packet loss comes back as a percentage via the usual loss-rate
 * approximation, `lost / (lost + sent-or-received)`, which is what most
 * WebRTC quality tooling uses. It isn't the RFC 3550 formula and it isn't
 * exact: `packetsLost` is a cumulative, remote-reported count with its own
 * delivery lag. But it's close enough to be a useful signal and costs
 * nothing on top of stats we're already collecting.
 */
export function normalizeTrackStats(
  raw: RawTrackStats,
  previous: RawTrackStats | undefined,
  kind: TrackKind,
  direction: 'send' | 'receive',
): TrackStats {
  const stats: TrackStats = { kind, direction };

  if (typeof raw.jitter === 'number') {
    stats.jitterMs = raw.jitter * MS_PER_SECOND;
  }
  if (typeof raw.roundTripTime === 'number') {
    stats.roundTripTimeMs = raw.roundTripTime * MS_PER_SECOND;
  }
  if (typeof raw.mimeType === 'string') {
    stats.codec = raw.mimeType;
  }
  if (typeof raw.frameWidth === 'number') stats.frameWidth = raw.frameWidth;
  if (typeof raw.frameHeight === 'number') stats.frameHeight = raw.frameHeight;
  if (typeof raw.framesPerSecond === 'number') stats.framesPerSecond = raw.framesPerSecond;

  if (typeof raw.packetsLost === 'number') {
    stats.packetsLost = raw.packetsLost;

    const attempted = direction === 'send' ? raw.packetsSent : raw.packetsReceived;
    if (typeof attempted === 'number' && attempted + raw.packetsLost > 0) {
      stats.packetLossPercent = (raw.packetsLost / (attempted + raw.packetsLost)) * 100;
    }
  }

  const bytesField = direction === 'send' ? 'bytesSent' : 'bytesReceived';
  const currentBytes = raw[bytesField];
  const previousBytes = previous?.[bytesField];

  if (typeof currentBytes === 'number' && typeof previousBytes === 'number') {
    const elapsedSeconds = (raw.timestamp - previous!.timestamp) / MS_PER_SECOND;
    // Non-positive elapsed time means the samples are out of order or
    // identical, which happens when a caller polls faster than the
    // underlying stats actually refresh. Computing a rate from that either
    // divides by zero or flips the sign, so skip it instead of reporting
    // junk.
    if (elapsedSeconds > 0 && currentBytes >= previousBytes) {
      stats.bitrateBps = ((currentBytes - previousBytes) * 8) / elapsedSeconds;
    }
  }

  return stats;
}

/**
 * `LocalVideoTrack.getSenderStats()` hands back one entry per simulcast
 * encoding layer, not a single stream. The highest-resolution layer is the
 * one worth calling "this track's" quality. The lower layers exist for
 * viewers on poor connections; they don't describe what this participant
 * is sending at its best.
 */
export function pickBestLayer(layers: RawTrackStats[]): RawTrackStats | undefined {
  return layers.reduce<RawTrackStats | undefined>((best, layer) => {
    const bestWidth = best?.frameWidth ?? -1;
    const layerWidth = layer.frameWidth ?? -1;
    return layerWidth > bestWidth ? layer : best;
  }, undefined);
}
