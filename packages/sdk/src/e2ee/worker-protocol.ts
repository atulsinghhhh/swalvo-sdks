import type { E2EECodec } from './crypto';
import type { CryptorDirection, E2EEState } from './frame-cryptor';

/** Options handed to `RTCRtpScriptTransform`, and the legacy `transform` message. */
export interface TransformOptions {
  transformId: string;
  direction: CryptorDirection;
  kind: 'audio' | 'video';
  /** Receivers: whose frames these are. May arrive later via `setTransformParticipant`. */
  participantId?: string;
  codec?: E2EECodec;
}

export type MainToWorkerMessage =
  | { type: 'init'; sharedKey: boolean; ratchetWindow: number; localParticipantId: string; enabled: boolean }
  | { type: 'setKey'; participantId?: string; material: Uint8Array; keyIndex: number }
  | { type: 'ratchet'; requestId: number; participantId?: string; keyIndex?: number }
  | { type: 'enable'; enabled: boolean }
  | { type: 'setLocalParticipant'; participantId: string }
  | { type: 'setTransformParticipant'; transformId: string; participantId: string }
  | { type: 'payloadTypes'; direction: CryptorDirection; map: Record<number, E2EECodec> }
  | { type: 'forget'; participantId: string }
  | ({ type: 'transform'; readable: ReadableStream; writable: WritableStream } & TransformOptions);

export type WorkerToMainMessage =
  | { type: 'state'; participantId: string; direction: CryptorDirection; state: E2EEState }
  | { type: 'ratcheted'; participantId?: string; keyIndex: number; material: Uint8Array; requestId?: number }
  | { type: 'error'; message: string };

/** Maps an RTP mime type (`video/VP8`, `audio/opus`) to the codec the frame format cares about. */
export function codecFromMimeType(mimeType: string | undefined): E2EECodec | undefined {
  switch (mimeType?.toLowerCase().split('/')[1]) {
    case 'vp8':
      return 'vp8';
    case 'vp9':
      return 'vp9';
    case 'av1':
    case 'av1x':
      return 'av1';
    case 'h264':
      return 'h264';
    case 'opus':
      return 'opus';
    default:
      return undefined;
  }
}

/** `a=rtpmap:<pt> <codec>/...` lines of an SDP → payload type → codec. */
export function payloadTypesFromSdp(sdp: string): Record<number, E2EECodec> {
  const map: Record<number, E2EECodec> = {};
  for (const line of sdp.split(/\r?\n/)) {
    const match = /^a=rtpmap:(\d+) ([^/\s]+)\//.exec(line);
    if (!match) continue;
    const codec = codecFromMimeType(`x/${match[2]}`);
    if (codec) map[Number(match[1])] = codec;
  }
  return map;
}
