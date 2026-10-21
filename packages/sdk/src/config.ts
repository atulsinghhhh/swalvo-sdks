import { RTCError } from './errors';
import type { LogLevel } from './logger';
import type { E2EEOptions } from './e2ee/types';

/** Video codecs `RTCClientConfig.videoCodec` accepts. */
export type VideoCodec = 'vp8' | 'h264' | 'vp9' | 'av1';

export interface RTCClientConfig {
  /** The RTC token your backend minted through Swalvo's Control API. Never mint one in the browser. */
  token: string;
  /**
   * RTC infrastructure URL to connect to. It's the `endpoint` field out of
   * the same mint response as `token`. Forward both through untouched;
   * don't build this by hand.
   */
  endpoint: string;
  /**
   * The `iceServers` array from the same mint response. Optional so tests
   * and advanced setups can skip it, but ordinarily you just forward it.
   * Don't go configuring STUN/TURN by hand.
   */
  iceServers?: RTCIceServer[];
  logLevel?: LogLevel;
  /** Defaults to true. Set false to disable automatic reconnect on network loss. */
  autoReconnect?: boolean;
  /**
   * Returns a fresh RTC token from your backend, minted for the same
   * room, identity, project and environment as `token`.
   *
   * Called when the server says the session's token is about to expire
   * (the SDK then hands the new token to the live session, with no
   * reconnect), when a reconnect would otherwise present an expired token,
   * and after the server closes the session because the token expired.
   * Without it a session cannot outlive its token wherever the server
   * enforces expiry, and the room emits a `TOKEN_EXPIRING` warning instead.
   *
   * A rejection is not fatal: the session carries on under the old token
   * and the room emits a `TOKEN_REFRESH_FAILED` warning.
   */
  refreshToken?: () => Promise<string>;
  /**
   * Base URL for best-effort connection telemetry. Comes from the
   * `telemetryUrl` field of the same token-mint response as `token` and
   * `endpoint`; never build it yourself. Leave it out, or set
   * `telemetry: false`, to turn telemetry off completely. RTC never
   * depends on it either way. See docs/telemetry.md.
   */
  telemetryUrl?: string;
  /** Defaults to true. Set false to switch telemetry off; RTC never needs it (Phase 9 spec §31). */
  telemetry?: boolean;
  /**
   * Defaults to true. Keeps each subscribed video on the smallest simulcast
   * layer that still covers the element it is rendered in.
   *
   * On by default because the alternative is every subscriber receiving
   * every publisher's full-quality stream regardless of how small it is
   * being shown, which is what makes a six- or eight-person call
   * unaffordable on a phone. Turn it off only if you intend to choose
   * layers yourself with `RemoteTrack.setLayer()`, which keeps working
   * either way.
   */
  adaptiveStream?: boolean;
  /**
   * Video codec to offer first when publishing a camera or screen share.
   * Leave unset for the browser's own order (VP8 first in Chrome).
   *
   * `'h264'` is what a live-stream host wants: the stream's HLS and RTMP
   * output can then copy the host's own encoding instead of decoding and
   * re-encoding it (docs/architecture/live-streaming-v2.md §3.3). If the
   * browser cannot send the codec, publishing falls back to its default.
   *
   * @deprecated Use `videoCodec`, which it is now an alias of (with SVC for
   * `'vp9'`/`'av1'`). When both are set, `videoCodec` wins.
   */
  preferredVideoCodec?: VideoCodec;
  /**
   * Video codec for the camera and screen share (docs: /rtc/codecs).
   * Leave unset for the browser's default (VP8 simulcast in Chrome).
   *
   * - `'vp8'`, `'h264'`: offered first; the camera publishes the usual
   *   three-layer simulcast. `'h264'` lets live-stream egress copy the
   *   host's encoding instead of transcoding.
   * - `'vp9'`, `'av1'`: SVC — one encoding with `scalabilityMode: 'L3T3_KEY'`
   *   that the SFU thins per subscriber by dropping layers. Falls back to
   *   VP8 simulcast when the browser cannot encode the codec or the mode.
   *
   * Replaces `preferredVideoCodec`, which remains as an alias.
   */
  videoCodec?: VideoCodec;
  /**
   * Defaults to true. Offers Opus with RED (RFC 2198 redundancy,
   * `audio/red`) first, so a lost audio packet is recovered from the next
   * one. Costs roughly double the audio bitrate (~30 kbps extra); the SFU
   * strips it for subscribers that don't support it. Turned off
   * automatically while end-to-end encryption is active, where the frame
   * transform would see RED-wrapped payloads other platforms can't read.
   */
  audioRed?: boolean;
  /**
   * End-to-end encryption (docs: /rtc/e2ee). Media is encrypted on this
   * device with keys from `keyProvider` and the media server only ever
   * forwards ciphertext. Takes effect in rooms created with `e2ee: true`;
   * in such a room a client *without* this option cannot publish
   * (`E2EE_REQUIRED`).
   *
   * ```ts
   * import { createRTCClient, createSharedKeyProvider } from '@swalvo/rtc';
   * const client = createRTCClient({ token, endpoint, e2ee: { keyProvider: createSharedKeyProvider(passphrase) } });
   * ```
   */
  e2ee?: E2EEOptions;
  /**
   * Defaults to true: every remote video starts flowing as soon as it is
   * subscribed.
   *
   * Set false for a large room where most tiles are off screen. Video
   * subscriptions then start paused (`track.subscriptionState` is
   * `'paused_client'`) and cost nothing until the track is wanted: when it
   * is attached to a visible element (with `adaptiveStream` on), or when
   * you call `track.setEnabled(true)` or `track.setLayer(...)`. Audio is
   * always forwarded either way.
   */
  autoSubscribe?: boolean;
}

export interface ResolvedRTCClientConfig {
  token: string;
  endpoint: string;
  iceServers?: RTCIceServer[];
  logLevel: LogLevel;
  autoReconnect: boolean;
  refreshToken?: () => Promise<string>;
  telemetryUrl?: string;
  telemetry: boolean;
  adaptiveStream: boolean;
  /** `videoCodec ?? preferredVideoCodec`. */
  preferredVideoCodec?: VideoCodec;
  /** Optional so a hand-built config (tests) keeps compiling; the adapter defaults it to true. */
  audioRed?: boolean;
  e2ee?: E2EEOptions;
  /** Optional so a hand-built config (tests) keeps compiling; the adapter defaults it to true. */
  autoSubscribe?: boolean;
}

interface DecodedTokenPayload {
  /** The `rid` claim: the room's `rooms.id` primary key. */
  roomId?: string;
  /** The `rnm` claim: the room's display name, carried next to `rid` so this check accepts either. */
  roomName?: string;
  exp?: number;
  sub?: string;
}

/**
 * Decodes the JWT payload. Doesn't verify it; the server is the source of truth.
 *
 * Reads Swalvo's own claim names (`rid`/`rnm`/`sub`/`exp`, see
 * `RtcTokenClaims` in the control plane). It used to read `video.room`,
 * which was LiveKit's claim shape and stopped existing when Swalvo's own
 * token signer replaced it — so every field here came back `undefined` and
 * `assertTokenMatchesRoom` below silently passed everything.
 */
export function decodeTokenPayload(token: string): DecodedTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new RTCError('INVALID_TOKEN', 'RTC token is malformed (expected a JWT with 3 parts)');
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(base64));
    return {
      roomId: typeof json?.rid === 'string' ? json.rid : undefined,
      roomName: typeof json?.rnm === 'string' ? json.rnm : undefined,
      exp: typeof json?.exp === 'number' ? json.exp : undefined,
      sub: typeof json?.sub === 'string' ? json.sub : undefined,
    };
  } catch (error) {
    throw new RTCError('INVALID_TOKEN', 'RTC token payload could not be decoded', error);
  }
}

export function validateConfig(config: RTCClientConfig): ResolvedRTCClientConfig {
  if (!config || typeof config !== 'object') {
    throw new RTCError('INVALID_TOKEN', 'createRTCClient(config) requires a configuration object');
  }
  if (!config.token || typeof config.token !== 'string') {
    throw new RTCError('INVALID_TOKEN', 'config.token is required; the RTC token from your backend');
  }
  if (config.refreshToken !== undefined && typeof config.refreshToken !== 'function') {
    throw new RTCError(
      'INVALID_TOKEN',
      'config.refreshToken must be a function returning a Promise of a new RTC token',
    );
  }
  if (!config.endpoint || typeof config.endpoint !== 'string') {
    throw new RTCError(
      'INVALID_TOKEN',
      'config.endpoint is required; the "endpoint" field from the same token-mint response as config.token',
    );
  }

  const codec = config.videoCodec ?? config.preferredVideoCodec;
  if (codec !== undefined && !['vp8', 'h264', 'vp9', 'av1'].includes(codec)) {
    throw new RTCError(
      'NOT_SUPPORTED',
      `config.videoCodec must be 'vp8', 'h264', 'vp9' or 'av1', not "${String(codec)}"`,
    );
  }
  if (config.e2ee !== undefined && !config.e2ee?.keyProvider) {
    throw new RTCError(
      'E2EE_REQUIRED',
      'config.e2ee needs a keyProvider: createSharedKeyProvider(passphrase) or createKeyProvider()',
    );
  }

  const { exp } = decodeTokenPayload(config.token);
  if (exp !== undefined && exp * 1000 <= Date.now()) {
    throw new RTCError('TOKEN_EXPIRED', 'RTC token has already expired');
  }

  return {
    token: config.token,
    endpoint: config.endpoint,
    iceServers: config.iceServers,
    logLevel: config.logLevel ?? 'silent',
    autoReconnect: config.autoReconnect ?? true,
    refreshToken: config.refreshToken,
    telemetryUrl: config.telemetryUrl,
    telemetry: config.telemetry ?? true,
    adaptiveStream: config.adaptiveStream ?? true,
    preferredVideoCodec: config.videoCodec ?? config.preferredVideoCodec,
    audioRed: config.audioRed ?? true,
    e2ee: config.e2ee,
    autoSubscribe: config.autoSubscribe ?? true,
  };
}

/**
 * Bails out client-side, before any connection is attempted, if the token
 * was minted for a different room than the one being joined. Much clearer
 * than letting the connection fail and working backwards from that.
 *
 * Either the room id or the room name is accepted, because a token carries
 * both (`rid` and `rnm`) and application code legitimately holds whichever
 * one it happened to pass to its own backend.
 *
 * A token carrying neither claim passes. That's deliberate: this is a
 * courtesy check, not authorization. The signaling gateway re-verifies the
 * signed room on every join, so the only thing a missing claim costs is a
 * later, less obvious error message.
 */
export function assertTokenMatchesRoom(token: string, room: string): void {
  const { roomId, roomName } = decodeTokenPayload(token);
  if (!roomId && !roomName) {
    return;
  }
  if (room === roomId || room === roomName) {
    return;
  }
  // Named by name where we have one: logs and error reports get read by
  // humans, who know rooms by name rather than by primary key.
  const minted = roomName ?? roomId;
  throw new RTCError('ROOM_NOT_FOUND', `This token was minted for room "${minted}", not "${room}"`);
}
