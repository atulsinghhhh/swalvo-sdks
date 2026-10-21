/**
 * HOST created the stream, CO_HOST was invited into it, VIEWER can only
 * subscribe. Which one you get is decided entirely server-side, by whether
 * your backend called `POST /v1/live-streams/:id/hosts` or
 * `.../viewer-tokens`. Never by anything this SDK sends.
 */
export type LiveStreamRole = 'HOST' | 'CO_HOST' | 'VIEWER';

/**
 * What `LiveStream.join()` wants: the response from `POST
 * /v1/live-streams/:id/hosts` or `.../viewer-tokens`, forwarded out of
 * your backend untouched. Those endpoints already return it shaped exactly
 * like this. Nothing needs reassembling.
 */
export interface LiveStreamCredentials {
  /** The stream's id (`stream_...`). */
  streamId: string;
  role: LiveStreamRole;
  /** Your identity in the stream (in every mint response). Lets stage events tell you when they're about you. */
  identity?: string;
  /**
   * A BROADCAST viewer's HLS playback (mint with `acceptPlayback: true`).
   * `url` can name a manifest that isn't published yet while `status` is
   * STARTING; the player keeps retrying until it is.
   */
  /** `llhlsUrl`: low-latency HLS (about 2 s), preferred when present; `url` is the fallback. */
  playback?: {
    url: string | null;
    llhlsUrl?: string | null;
    status: string;
    /** Watch-time heartbeat for viewer-minute billing; the player sends it. */
    beacon?: { url: string; token: string; intervalSec: number };
  };
  /**
   * The stream's public id, from the mint response. `LiveStream.join()`
   * doesn't use this to pick a room — it joins whatever room the `rtc`
   * token itself names, which for a cascaded viewer of a stream with
   * `edgeScaling` may be an edge room on another media node. That edge
   * placement is never surfaced here; this field stays the stream id
   * either way, and exists only for display/logging.
   */
  rtcRoom?: string;
  /**
   * The `rtc` field from the mint response. Forward it untouched, like any
   * other `@swalvo/rtc` token. Absent on a BROADCAST viewer's playback
   * credential, which carries `playback` instead.
   */
  rtc?: {
    token: string;
    endpoint: string;
    iceServers?: RTCIceServer[];
    telemetryUrl?: string;
  };
  /**
   * The `chat` field from the mint response. Leave it out entirely for an
   * RTC-only integration. `LiveStream.chat` is then undefined, and
   * `react()` throws instead of quietly doing nothing.
   */
  chat?: {
    token: string;
    apiUrl?: string;
    chatUrl?: string;
    /** Which conversation to connect to. Comes from the mint response's `conversations` field, which always has exactly one entry for a stream's chat token. */
    conversations: string[];
  };
  /** The stream's `chatRootMessageId`, which is what `react()` hangs reactions off. Leave it out if this stream has no chat. */
  chatRootMessageId?: string | null;
}

/** Options for `LiveStream.join()`. */
export interface LiveStreamJoinOptions {
  /**
   * Called to get a fresh RTC token before the current one expires, so a
   * long session (a webinar, a lecture) isn't cut off at the token's TTL.
   * Your backend mints it; passed straight to `@swalvo/rtc`.
   */
  refreshToken?: () => Promise<string>;
}

/**
 * A stage signal (docs/architecture/live-streaming-v2.md §3.4).
 * `invited` / `promoted` / `demoted` only ever come from the server;
 * `raise_hand` / `lower_hand` come from the viewer named in `identity`.
 */
export interface LiveStreamStageEvent {
  action: 'raise_hand' | 'lower_hand' | 'invited' | 'promoted' | 'demoted';
  identity: string;
  role?: LiveStreamRole;
  /** True when `identity` is you. */
  forMe: boolean;
}

/**
 * A viewer's video quality preference (phase4-contracts.md §2.3). `auto`
 * lets adaptive streaming (RTC) or hls.js ABR (HLS) choose; the others pin
 * the top, middle or bottom simulcast layer / HLS rung.
 */
export type LiveStreamQuality = 'auto' | 'high' | 'medium' | 'low';

/** One caption segment (phase6-contracts.md §4). Interim segments share `segmentId`; the `final` one closes it. */
export interface LiveStreamTranscriptionSegment {
  type: 'transcription.segment';
  transcriptionId: string;
  /** Who was speaking. */
  participantId: string;
  segmentId: string;
  text: string;
  final: boolean;
  language: string;
  startMs: number;
  endMs: number;
}

/** A transcription's lifecycle in this room. */
export interface LiveStreamTranscriptionState {
  transcriptionId: string;
  status: 'STARTING' | 'ACTIVE' | 'STOPPING' | 'ENDED' | 'FAILED';
  language: string;
}
