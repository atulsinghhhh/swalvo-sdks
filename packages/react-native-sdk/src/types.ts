import type { LogLevel } from '@swalvo/rtc';
import type { ChatClient } from '@swalvo/chat';
import type { SwalvoAppState } from './internal/lifecycle';

/**
 * Everything `new Swalvo(...)` needs.
 *
 * The RTC fields are exactly what `createRTCClient` takes on web, same
 * meanings, same rule: they come from your backend's token-mint response,
 * and none of them should ever be built by hand.
 */
export interface SwalvoConfig {
  /**
   * RTC token from your backend. Never mint one in the app (spec §15).
   *
   * Optional alongside `endpoint`. Leave both out for a messaging-only app
   * and `swalvo.chat` works with no RTC connection ever being created.
   * `join()` then throws a clear error rather than a baffling null
   * reference.
   */
  token?: string;
  /** The `endpoint` field from the same mint response. Required whenever `token` is set. */
  endpoint?: string;
  /** The `iceServers` array from the same response. Forward it untouched. */
  iceServers?: RTCIceServer[];
  /** The `telemetryUrl` from the same response. Doubles as the chat REST base when `chatApiUrl` is left out. */
  telemetryUrl?: string;
  /** Defaults to true. Telemetry is best-effort and never blocks a call. */
  telemetry?: boolean;
  logLevel?: LogLevel;
  /** Defaults to true. */
  autoReconnect?: boolean;
  /**
   * Returns a fresh RTC token from your backend, for the same room and
   * identity. Same contract as `refreshToken` in `createRTCClient()` on
   * web: called before the token expires (handed to the live session, no
   * reconnect) and before reconnecting with an expired one. Without it a
   * call cannot outlive its token where the server enforces expiry.
   */
  refreshToken?: () => Promise<string>;
  /**
   * Defaults to true. Pauses remote video nobody can see — a
   * `SwalvoVideoView` with `visible={false}`, laid out at zero size, or no
   * longer mounted — and resumes it when it is shown again. Same option as
   * on web; there it also sizes each video's layer to its element, which a
   * React Native view cannot report yet.
   */
  adaptiveStream?: boolean;
  /**
   * Defaults to true. Set false for a large room: remote video then starts
   * paused until a `SwalvoVideoView` shows it, or `track.setEnabled(true)`.
   * Audio is always on. Same option as `createRTCClient()` on web.
   */
  autoSubscribe?: boolean;
  /**
   * Defaults to true: offer Opus with RED redundancy first (the web
   * SDK's `audioRed`), so a lost audio packet is recovered from the next.
   */
  audioRed?: boolean;
  /**
   * Camera codec offered first (the web SDK's `videoCodec`). `'vp8'` and
   * `'h264'` only: react-native-webrtc cannot set `scalabilityMode`, so
   * the VP9/AV1 SVC the web SDK publishes is not available here.
   */
  videoCodec?: 'vp8' | 'h264';

  /**
   * Chat token from your backend's `POST /v1/chat/tokens`. Leave it out for
   * an RTC-only app and `swalvo.chat` simply isn't there. Supply it
   * *without* `token`/`endpoint` for a messaging-only app.
   *
   * A *separate* credential from `token` above, by design. The two planes
   * are independent and neither token works on the other
   * (docs/chat/overview.md).
   */
  chatToken?: string;
  /** REST base for chat. Defaults to `telemetryUrl`, which is the same host. */
  chatApiUrl?: string;
  /** Chat WebSocket URL. Derived from `chatApiUrl` when omitted. */
  chatUrl?: string;
  /**
   * Called shortly before the chat token expires. Hand back a fresh one and
   * the SDK reconnects without anyone noticing. Without it, a long call's
   * chat connection just closes when the token runs out.
   */
  onChatTokenExpiring?: () => Promise<string> | string;

  /**
   * Set false if your app already owns the audio session. Otherwise Swalvo
   * starts one on join and stops it on leave.
   */
  manageAudioSession?: boolean;

  /** Notified when the app moves between foreground and background. */
  onAppStateChange?: (state: SwalvoAppState) => void;
  /**
   * Fires when connectivity comes back *and* the room is beyond the SDK's
   * own recovery (`disconnected` or `failed`): somewhere to offer a rejoin.
   * A room that is still connected or reconnecting does not need this; the
   * SDK recovers it by itself the moment the network returns (a pending
   * reconnect runs at once, a live connection restarts ICE).
   * Needs `@react-native-community/netinfo` installed.
   */
  onNetworkReconnect?: () => void;
}

/**
 * The chat surface hanging off `swalvo.chat`.
 *
 * Structurally it's `@swalvo/chat`'s `ChatClient` with a mobile-shaped
 * `connect(room)` bolted on the front. On web you construct a client and
 * connect it; here the client already exists and joining a room is the only
 * step left. Everything else is the identical API, because it *is* the
 * same object: `sendMessage`, `on`, `messages.list`, presence, typing,
 * reactions, read receipts, threads.
 */
export interface SwalvoChatHandle extends Omit<ChatClient, 'connect'> {
  /** Connects if it needs to, then joins a conversation. Takes a `conv_` id, a name, or an attached RTC room id. */
  connect(room: string): Promise<void>;
  /** Shorthand for `sendMessage({ text })`, which is the common case on a phone. */
  send(text: string): Promise<unknown>;
}

export type { SwalvoAppState };

/**
 * Live Streaming (Phase 14). Mirrors `@swalvo/live`'s
 * `LiveStreamCredentials` and `LiveStreamRole` field for field.
 *
 * This package keeps its own copy instead of depending on
 * `@swalvo/live`, which composes `@swalvo/rtc` and `@swalvo/chat`
 * for a *browser*. Out here `Swalvo` already does that composition in a
 * way that suits mobile.
 */
export type LiveStreamRole = 'HOST' | 'CO_HOST' | 'VIEWER';

export interface LiveStreamCredentials {
  streamId: string;
  role: LiveStreamRole;
  /** Your identity in the stream, from the mint response. */
  identity?: string;
  /** The RTC room to join: the stream id, or an edge room for a cascaded viewer (live-streaming-v2.md §3.1). */
  rtcRoom?: string;
  /** A BROADCAST viewer's HLS playback (mint with acceptPlayback). Present instead of `rtc`. */
  playback?: {
    url: string | null;
    llhlsUrl?: string | null;
    status: string;
    /** Watch-time heartbeat for viewer-minute billing: pass it to the player untouched. */
    beacon?: { url: string; token: string; intervalSec: number };
  };
  /** Absent on a BROADCAST viewer's playback credential. */
  rtc?: {
    token: string;
    endpoint: string;
    iceServers?: RTCIceServer[];
    telemetryUrl?: string;
  };
  chat?: {
    token: string;
    apiUrl?: string;
    chatUrl?: string;
    conversations: string[];
  };
  chatRootMessageId?: string | null;
}
