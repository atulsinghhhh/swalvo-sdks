/**
 * Codec preferences: RED for audio and the camera codec / SVC choice
 * (docs/architecture/phase5-contracts.md §2).
 */

/** `RTCRtpCodec` in current DOM typings (`RTCRtpCodecCapability` in older ones). */
type CodecCapability = RTCRtpCodec;

export type VideoCodecName = 'vp8' | 'h264' | 'vp9' | 'av1';

/** The SVC mode the SFU's layer dropping is built for (§2.2). */
export const SVC_SCALABILITY_MODE = 'L3T3_KEY';

/** One SVC encoding carries all three spatial layers, so it gets the whole ladder's budget. */
export const SVC_MAX_BITRATE = 1_700_000;

function capabilities(kind: 'audio' | 'video'): CodecCapability[] {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') return [];
  try {
    return RTCRtpSender.getCapabilities(kind)?.codecs ?? [];
  } catch {
    return [];
  }
}

/** Codecs with `mimeType` moved to the front, everything else in the browser's order. Undefined when absent. */
export function preferCodec(codecs: CodecCapability[], mimeType: string): CodecCapability[] | undefined {
  const wanted = mimeType.toLowerCase();
  const first = codecs.filter((codec) => codec.mimeType.toLowerCase() === wanted);
  if (first.length === 0) return undefined;
  return [...first, ...codecs.filter((codec) => codec.mimeType.toLowerCase() !== wanted)];
}

/** The audio codec list with `audio/red` first, or undefined when the browser has no RED. */
export function redFirstAudioCodecs(): CodecCapability[] | undefined {
  return preferCodec(capabilities('audio'), 'audio/red');
}

/** The video codec list with `codec` first, or undefined when the browser cannot send it. */
export function videoCodecsPreferring(codec: VideoCodecName): CodecCapability[] | undefined {
  return preferCodec(capabilities('video'), `video/${codec}`);
}

/**
 * Whether the browser can send `codec` with L3T3_KEY. A browser that lists
 * the codec but not `scalabilityModes` (older Chrome) is given the benefit
 * of the doubt; negotiation is read back afterwards either way
 * (`confirmSimulcast` reports `'svc'` only when the mode stuck).
 */
export function svcSupported(codec: VideoCodecName): boolean {
  if (codec !== 'vp9' && codec !== 'av1') return false;
  const entries = capabilities('video').filter((c) => c.mimeType.toLowerCase() === `video/${codec}`);
  if (entries.length === 0) return false;
  return entries.some((entry) => {
    const modes = (entry as CodecCapability & { scalabilityModes?: string[] }).scalabilityModes;
    return modes === undefined || modes.includes(SVC_SCALABILITY_MODE);
  });
}

/** The single encoding an SVC camera publishes. */
export function svcSendEncodings(): RTCRtpEncodingParameters[] {
  return [{ scalabilityMode: SVC_SCALABILITY_MODE, maxBitrate: SVC_MAX_BITRATE } as RTCRtpEncodingParameters];
}
