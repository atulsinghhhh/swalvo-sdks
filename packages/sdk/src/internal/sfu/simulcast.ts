import type { TrackKind } from '../../track';

/**
 * The simulcast ladder, and the checks that prove it reached the wire.
 *
 * # Why this is its own module
 *
 * Simulcast was configured in this SDK for a long time without ever being
 * sent. `applySimulcast()` called `addTrack()` and then tried to attach
 * three encodings with `setParameters()`, which the WebRTC specification
 * requires implementations to reject — the number of encodings on a sender
 * is fixed once the sender exists. RIDs also only appear in the SDP
 * (`a=simulcast:send`, `a=rid:`) when they were present *before* the offer
 * was generated, which `setParameters` is by definition too late for. The
 * rejection went to `logger.debug` and nothing else, so every publisher in
 * every room sent one full-resolution layer while the code believed it was
 * sending three.
 *
 * What made it survive was that there was nowhere to look. "Simulcast is
 * on" was a claim about an array in memory, and an array in memory is
 * exactly what a broken implementation has too. So the verification here
 * deliberately reads the two things a broken implementation cannot fake:
 * the sender's *negotiated* parameters, and the local SDP.
 */

/** One rung of the ladder. */
export interface SimulcastLayer {
  rid: 'low' | 'medium' | 'high';
  scaleResolutionDownBy: number;
  maxBitrate: number;
  maxFramerate: number;
}

/**
 * Three spatial layers, each a quarter of the previous one's pixel count.
 * The standard ladder, and the one browsers implement well.
 *
 * `low` is capped at 15fps: at a quarter width it is feeding a thumbnail,
 * where halving the frame rate is invisible and halves the bitrate again.
 *
 * Kept identical to the Flutter SDK's
 * (`sdks/flutter/swalvo_rtc/lib/src/internal/engine.dart`). The RIDs in
 * particular are not labels — they travel in an RTP header extension on
 * every packet and the SFU maps them straight onto its own layer names
 * (`services/sfu/internal/room/downtrack.go`, `layerFromRID`). A RID that
 * does not reach the wire is a layer the SFU cannot offer anyone.
 */
export const SIMULCAST_LAYERS: readonly SimulcastLayer[] = [
  { rid: 'low', scaleResolutionDownBy: 4, maxBitrate: 150_000, maxFramerate: 15 },
  { rid: 'medium', scaleResolutionDownBy: 2, maxBitrate: 500_000, maxFramerate: 30 },
  { rid: 'high', scaleResolutionDownBy: 1, maxBitrate: 1_500_000, maxFramerate: 30 },
];

/** The encodings to hand `addTransceiver`. */
export function simulcastSendEncodings(): RTCRtpEncodingParameters[] {
  return SIMULCAST_LAYERS.map((layer) => ({
    rid: layer.rid,
    scaleResolutionDownBy: layer.scaleResolutionDownBy,
    maxBitrate: layer.maxBitrate,
    maxFramerate: layer.maxFramerate,
  }));
}

/**
 * Whether a kind publishes a ladder.
 *
 * A microphone has no spatial layering to do and Opus manages its own
 * bitrate. A screen share is left at one high-quality layer on purpose: the
 * content is usually text, and dropping resolution wrecks legibility in a
 * way it never does for a face.
 */
export function kindUsesSimulcast(kind: TrackKind): boolean {
  return kind === 'camera';
}

/**
 * Whether a published camera is genuinely sending a ladder.
 *
 * `unsupported` is a real, reachable outcome — some browsers and some
 * codecs refuse — and it is reported rather than hidden, because a room
 * where nobody can drop to a cheaper layer costs every participant the
 * full bitrate of every other participant.
 *
 * `svc` (Phase 5): the camera publishes one VP9/AV1 encoding with
 * `scalabilityMode` L3T3_KEY (`videoCodec: 'vp9' | 'av1'`), which carries the
 * layers inside it — the SFU thins it per subscriber by dropping layers.
 */
export type SimulcastStatus = 'enabled' | 'unsupported' | 'notApplicable' | 'pending' | 'svc';

/**
 * Reads the ladder back off a sender after negotiation.
 *
 * The RID count is the check that matters, because RIDs are what the SFU
 * keys layers on. A sender reporting one encoding is publishing one layer
 * no matter what was requested.
 */
export function confirmSimulcast(sender: RTCRtpSender): {
  status: SimulcastStatus;
  rids: string[];
} {
  let rids: string[] = [];
  try {
    const parameters = sender.getParameters();
    const encodings = parameters.encodings ?? [];
    const mode = (encodings[0] as (RTCRtpEncodingParameters & { scalabilityMode?: string }) | undefined)
      ?.scalabilityMode;
    if (encodings.length === 1 && typeof mode === 'string' && /^L[23]T/.test(mode)) {
      return { status: 'svc', rids: [] };
    }
    rids = encodings
      .map((encoding) => encoding.rid)
      .filter((rid): rid is string => typeof rid === 'string' && rid.length > 0);
  } catch {
    // Reading parameters back can fail on its own. Unknown is reported as
    // unsupported rather than enabled: claiming a ladder that may not exist
    // is the exact failure being fixed.
    return { status: 'unsupported', rids: [] };
  }

  const wanted = SIMULCAST_LAYERS.map((layer) => layer.rid);
  const present = new Set(rids);
  const complete = wanted.every((rid) => present.has(rid));

  return { status: complete ? 'enabled' : 'unsupported', rids };
}

/**
 * Whether an SDP genuinely negotiates simulcast for a send direction.
 *
 * Exported because it is the only falsifiable form of the claim. A test
 * asserting on `getParameters()` alone would have passed against the broken
 * implementation on any browser that tolerated the `setParameters` call;
 * a test asserting on this would not have.
 */
export function sdpNegotiatesSimulcast(sdp: string): boolean {
  const lines = sdp.split(/\r?\n/);
  const hasSimulcastSend = lines.some((line) => line.startsWith('a=simulcast:send'));
  const declaredRids = new Set(
    lines.filter((line) => line.startsWith('a=rid:')).map((line) => line.slice('a=rid:'.length).split(' ')[0]),
  );

  return hasSimulcastSend && SIMULCAST_LAYERS.every((layer) => declaredRids.has(layer.rid));
}
