import { createRTCClient, type RTCClient, type RTCClientConfig, type Room } from '@swalvo/rtc';
import { createChatClient, type ChatClient, type ChatClientConfig } from '@swalvo/chat';
import { LiveStream } from './live/live-stream';
import type { LiveStreamCredentials } from './live/types';

export type { Swalvo as SwalvoClient };

/**
 * Everything `new Swalvo(...)` accepts.
 *
 * RTC and chat credentials are independent of each other, and so are the
 * two halves of this config. Supply whichever planes your app actually
 * uses. All three of these are valid:
 *
 * ```ts
 * new Swalvo({ token, endpoint });                                  // calls only
 * new Swalvo({ chatToken, chatApiUrl });                            // messaging only
 * new Swalvo({ token, endpoint, chatToken, chatApiUrl });           // both
 * ```
 *
 * Every value here comes out of your backend's token-mint response. Don't
 * hand-construct any of them.
 */
export interface SwalvoConfig {
  /**
   * RTC token from your backend. Never mint one in the browser.
   * Optional alongside `endpoint`; leave both out for a messaging-only app.
   */
  token?: string;
  /** The `endpoint` field from the same mint response. Required whenever `token` is set. */
  endpoint?: string;
  /** The `iceServers` array from the same response. Forward it untouched; never build your own. */
  iceServers?: RTCIceServer[];
  /** Defaults to true. Telemetry is best-effort and never blocks a call. */
  telemetry?: boolean;
  telemetryUrl?: string;
  /** Defaults to true. */
  autoReconnect?: boolean;
  /** Fresh RTC token for the same room and identity. See `RTCClientConfig.refreshToken` in `@swalvo/rtc`. */
  refreshToken?: () => Promise<string>;

  /**
   * Chat token from your backend's `POST /v1/chat/tokens`. Separate from
   * `token` by design: neither one works on the other plane.
   */
  chatToken?: string;
  /**
   * REST base for chat, i.e. the `apiUrl` field from the chat-token
   * response. Falls back to `telemetryUrl`, which is the same host in a
   * standard deployment.
   *
   * In practice you need it whenever `chatToken` is set. Without it, or
   * `chatUrl`, there's nowhere to connect, and `@swalvo/chat` says so at
   * construction instead of falling over later.
   */
  chatApiUrl?: string;
  /** Chat WebSocket URL. Derived from `chatApiUrl` when omitted. */
  chatUrl?: string;
  /**
   * Called shortly before the chat token expires. Hand back a fresh one and
   * the connection re-establishes itself without anyone noticing.
   */
  onChatTokenExpiring?: () => Promise<string> | string;

  logLevel?: RTCClientConfig['logLevel'];
}

/**
 * Swalvo for the browser, RTC and chat behind a single object.
 *
 * A facade, not a third implementation. `swalvo.rtc` is a genuine
 * `RTCClient` from `@swalvo/rtc`, and `swalvo.chat` a genuine `ChatClient`
 * from `@swalvo/chat`. Every method, event and type documented for those
 * packages applies here untouched, because they *are* those objects.
 *
 * ```ts
 * const swalvo = new Swalvo({ token, endpoint, chatToken, chatApiUrl });
 *
 * const room = await swalvo.join('room_123');
 * await room.enableCamera();
 *
 * await swalvo.chat!.connect({ room: 'room_123' });
 * await swalvo.chat!.sendMessage({ text: 'Hello' });
 * ```
 *
 * **If you only want calls, use `@swalvo/rtc` directly.** It's around
 * 10 KB gzipped and drags in no messaging code at all. This package is for
 * apps that want both halves without wiring up two clients by hand, and it
 * mirrors the shape `@swalvo/react-native` already gives mobile so the
 * same mental model carries across.
 */
export class Swalvo {
  /** Not there for a messaging-only app. See the constructor. */
  readonly rtc?: RTCClient;
  /** Not there for an RTC-only app. See the constructor. */
  readonly chat?: ChatClient;
  /**
   * Swalvo Live Streaming. Unlike `rtc` and `chat` above, this doesn't care
   * what credentials the `Swalvo` instance was built with. A live stream's
   * host, co-host and viewer tokens are minted per stream and per role by
   * your backend (`POST /v1/live-streams/:id/hosts` or
   * `.../viewer-tokens`), so `live.join()` is there on every instance no
   * matter what you passed to `new Swalvo(...)`.
   *
   * ```ts
   * const stream = await swalvo.live.join(credentials);
   * if (stream.isHost) await stream.room.enableCamera();
   * ```
   */
  readonly live: { join(credentials: LiveStreamCredentials): Promise<LiveStream> };

  private currentRoom?: Room;

  constructor(config: SwalvoConfig) {
    this.live = { join: (credentials) => LiveStream.join(credentials) };

    // One without the other is always a mistake, and failing here is a lot
    // kinder than failing at join() with a baffling connection error.
    if (Boolean(config.token) !== Boolean(config.endpoint)) {
      throw new Error(
        'Swalvo needs both `token` and `endpoint` for RTC, or neither for a messaging-only app. ' +
          'Both come from the same token-mint response.',
      );
    }

    if (!config.token && !config.chatToken) {
      throw new Error(
        'Swalvo needs at least one credential: `token` + `endpoint` for calls, `chatToken` for messaging, or both.',
      );
    }

    if (config.token && config.endpoint) {
      this.rtc = createRTCClient({
        token: config.token,
        endpoint: config.endpoint,
        iceServers: config.iceServers,
        telemetry: config.telemetry,
        telemetryUrl: config.telemetryUrl,
        autoReconnect: config.autoReconnect,
        refreshToken: config.refreshToken,
        logLevel: config.logLevel,
      });
    }

    if (config.chatToken) {
      this.chat = createChatClient({
        token: config.chatToken,
        apiUrl: config.chatApiUrl ?? config.telemetryUrl,
        chatUrl: config.chatUrl,
        logLevel: config.logLevel,
        onTokenExpiring: config.onChatTokenExpiring,
      } as ChatClientConfig);
    }
  }

  /** True if this instance got RTC credentials. */
  get hasRtc(): boolean {
    return this.rtc !== undefined;
  }

  /** True if this instance got a chat token. */
  get hasChat(): boolean {
    return this.chat !== undefined;
  }

  /** The room currently joined, if any. */
  get room(): Room | undefined {
    return this.currentRoom;
  }

  /**
   * Joins a room. If this instance has no RTC credentials it throws
   * straight away with an error explaining why, instead of blowing up
   * later as a null reference.
   */
  async join(roomId: string): Promise<Room> {
    if (!this.rtc) {
      throw new Error(
        'This Swalvo instance has no RTC credentials, so it cannot join a room. ' +
          'Pass `token` and `endpoint` to enable calls, or use `swalvo.chat` for messaging.',
      );
    }

    this.currentRoom = await this.rtc.join(roomId);
    return this.currentRoom;
  }

  /** Leaves the room, keeping any chat connection open. */
  async leave(): Promise<void> {
    await this.currentRoom?.leave();
    this.currentRoom = undefined;
  }

  /**
   * Tears down the lot, chat included. Call it when the feature itself is
   * going away. Moving between rooms? `leave()` on its own is what you want.
   */
  async dispose(): Promise<void> {
    await this.leave();
    await this.chat?.disconnect();
  }
}

/** Functional alias, to match `createRTCClient` and `createChatClient`. */
export function createSwalvo(config: SwalvoConfig): Swalvo {
  return new Swalvo(config);
}

// Re-exported so an app on this facade doesn't need direct imports from
// the underlying packages just to name a common type.
export type { Room, RTCClient, RTCClientConfig } from '@swalvo/rtc';
export { RTCError, isRTCError } from '@swalvo/rtc';
export type { ChatClient, ChatMessage, ChatConnectionState } from '@swalvo/chat';
export { isSwalvoChatError } from '@swalvo/chat';

// Deprecated Raven* aliases (renamed to Swalvo*); same values, so `instanceof` and existing imports keep working.
/** @deprecated Renamed to {@link Swalvo}. */
export const Raven = Swalvo;
/** @deprecated Renamed to {@link Swalvo}. */
export type Raven = Swalvo;
/** @deprecated Renamed to {@link SwalvoClient}. */
export type RavenClient = Swalvo;
/** @deprecated Renamed to {@link SwalvoConfig}. */
export type RavenConfig = SwalvoConfig;
/** @deprecated Renamed to {@link createSwalvo}. */
export const createRaven = createSwalvo;
/** @deprecated Renamed to {@link isSwalvoChatError}. */
export { isRavenChatError } from '@swalvo/chat';

export { LiveStream, joinLiveStream } from './live/live-stream';
export type {
  LiveStreamCredentials,
  LiveStreamJoinOptions,
  LiveStreamQuality,
  LiveStreamRole,
  LiveStreamStageEvent,
  LiveStreamTranscriptionSegment,
  LiveStreamTranscriptionState,
} from './live/types';
