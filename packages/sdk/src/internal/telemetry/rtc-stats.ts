import type { RawTrackStats } from './track-stats';

export type { RawTrackStats } from './track-stats';

/**
 * Reads an `RTCStatsReport` into the flat samples `normalizeTrackStats`
 * already knows how to handle.
 *
 * # Why this walks the whole report instead of grabbing one entry
 *
 * The numbers you want for a single track are scattered across several
 * stats objects, and which object holds what depends on direction:
 *
 * - `outbound-rtp` / `inbound-rtp`: bytes, packets, and video
 *   resolution/framerate.
 * - `remote-inbound-rtp`: the *remote* end's view of a stream we're
 *   sending. It's the only place round-trip time and the loss the far side
 *   actually saw get reported. Send-side loss can't be measured locally at
 *   all; a sender only knows what it handed to the network.
 * - `codec`: the mime type, referenced by id rather than inlined.
 *
 * So a faithful sample is a join across all of those. Doing that here,
 * once, is what keeps `TrackStats` a flat honest shape instead of
 * exposing the report's structure to every caller.
 *
 * Anything the report doesn't contain stays `undefined`. Nothing here
 * swaps a zero in for a missing measurement. Spec §19 forbids inventing
 * quality figures, and "0% loss" versus "no report yet" is exactly the
 * distinction that matters.
 */
export function rawStatsFromReport(report: RTCStatsReport, wanted: 'outbound-rtp' | 'inbound-rtp'): RawTrackStats[] {
  const codecs = new Map<string, string>();
  const remoteInbound: RemoteInboundStats[] = [];
  const rtpEntries: RtpStats[] = [];

  report.forEach((entry) => {
    const stats = entry as { type?: string } & Record<string, unknown>;
    switch (stats.type) {
      case 'codec':
        if (typeof stats.id === 'string' && typeof stats.mimeType === 'string') {
          codecs.set(stats.id, stats.mimeType);
        }
        break;
      case 'remote-inbound-rtp':
        remoteInbound.push(stats as unknown as RemoteInboundStats);
        break;
      case wanted:
        rtpEntries.push(stats as unknown as RtpStats);
        break;
      default:
        break;
    }
  });

  return rtpEntries.map((rtp) => toRawStats(rtp, wanted, codecs, remoteInbound));
}

interface RtpStats {
  id?: string;
  ssrc?: number;
  kind?: string;
  mediaType?: string;
  timestamp?: number;
  codecId?: string;
  bytesSent?: number;
  bytesReceived?: number;
  packetsSent?: number;
  packetsReceived?: number;
  packetsLost?: number;
  jitter?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  mimeType?: string;
}

interface RemoteInboundStats {
  ssrc?: number;
  localId?: string;
  roundTripTime?: number;
  packetsLost?: number;
  jitter?: number;
}

function toRawStats(
  rtp: RtpStats,
  direction: 'outbound-rtp' | 'inbound-rtp',
  codecs: Map<string, string>,
  remoteInbound: RemoteInboundStats[],
): RawTrackStats {
  const kind = rtp.kind ?? rtp.mediaType;
  const sample: RawTrackStats = {
    type: kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : undefined,
    // `RTCStats.timestamp` is a DOMHighResTimeStamp relative to the time
    // origin, and `normalizeTrackStats` only ever uses it as a delta
    // against a previous sample, so the epoch is irrelevant. Falling back
    // to Date.now() keeps the delta usable on the rare browser that omits
    // it.
    timestamp: typeof rtp.timestamp === 'number' ? rtp.timestamp : Date.now(),
  };

  if (typeof rtp.jitter === 'number') sample.jitter = rtp.jitter;
  if (typeof rtp.frameWidth === 'number') sample.frameWidth = rtp.frameWidth;
  if (typeof rtp.frameHeight === 'number') sample.frameHeight = rtp.frameHeight;
  if (typeof rtp.framesPerSecond === 'number') sample.framesPerSecond = rtp.framesPerSecond;

  const mimeType = rtp.mimeType ?? (rtp.codecId ? codecs.get(rtp.codecId) : undefined);
  if (mimeType) sample.mimeType = mimeType;

  if (direction === 'outbound-rtp') {
    if (typeof rtp.bytesSent === 'number') sample.bytesSent = rtp.bytesSent;
    if (typeof rtp.packetsSent === 'number') sample.packetsSent = rtp.packetsSent;

    // Loss and RTT for a stream we're sending are only knowable from the
    // receiver's report. Match on `localId` where the browser gives us
    // one, fall back to SSRC otherwise. Safari has a long history of being
    // inconsistent about `localId`, and a slightly looser match beats no
    // match at all.
    const feedback =
      remoteInbound.find((remote) => rtp.id && remote.localId === rtp.id) ??
      remoteInbound.find((remote) => rtp.ssrc !== undefined && remote.ssrc === rtp.ssrc);
    if (feedback) {
      if (typeof feedback.roundTripTime === 'number') sample.roundTripTime = feedback.roundTripTime;
      if (typeof feedback.packetsLost === 'number') sample.packetsLost = feedback.packetsLost;
      if (sample.jitter === undefined && typeof feedback.jitter === 'number') {
        sample.jitter = feedback.jitter;
      }
    }
    return sample;
  }

  if (typeof rtp.bytesReceived === 'number') sample.bytesReceived = rtp.bytesReceived;
  if (typeof rtp.packetsReceived === 'number') sample.packetsReceived = rtp.packetsReceived;
  if (typeof rtp.packetsLost === 'number') sample.packetsLost = rtp.packetsLost;
  return sample;
}

/**
 * Round-trip time on the negotiated ICE candidate pair, if there is one.
 *
 * Worth having alongside per-track RTT because it still exists on a
 * video-only or receive-only connection, where there's no audio
 * `remote-inbound-rtp` report to carry one.
 */
export async function connectionRoundTripTimeMs(connection: RTCPeerConnection): Promise<number | undefined> {
  const report = await connection.getStats();
  let rttSeconds: number | undefined;

  report.forEach((entry) => {
    const stats = entry as { type?: string } & Record<string, unknown>;
    if (stats.type !== 'candidate-pair') {
      return;
    }
    // Only the pair actually in use. A connection gathers several and
    // reports the lot; the others' timings describe paths nobody is
    // taking.
    if (stats.state !== 'succeeded' || stats.nominated !== true) {
      return;
    }
    if (typeof stats.currentRoundTripTime === 'number') {
      rttSeconds = stats.currentRoundTripTime;
    }
  });

  return rttSeconds === undefined ? undefined : rttSeconds * 1000;
}
