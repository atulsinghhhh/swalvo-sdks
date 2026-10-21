import { RTCError, type LogLevel, type Room } from '@swalvo/rtc';
import { Swalvo } from './swalvo';
import type { SwalvoAppState } from './internal/lifecycle';
import type { ChatMessage } from '@swalvo/chat';
import type { SwalvoChatHandle, LiveStreamCredentials, LiveStreamRole } from './types';

/** A stage signal from the stream's chat (live-streaming-v2.md §3.4). */
export interface LiveStageEvent {
  action: 'raise_hand' | 'lower_hand' | 'invited' | 'promoted' | 'demoted';
  identity: string;
  role?: LiveStreamRole;
  forMe: boolean;
}

const SERVER_ONLY_STAGE_ACTIONS = new Set(['invited', 'promoted', 'demoted']);
const VIEWER_STAGE_ACTIONS = new Set(['raise_hand', 'lower_hand']);

export interface SwalvoLiveStreamOptions {
  logLevel?: LogLevel;
  /** Defaults to true. */
  autoReconnect?: boolean;
  /** Fresh RTC token for this stream's room and identity. See `SwalvoConfig.refreshToken`. */
  refreshToken?: () => Promise<string>;
  /** Set false if your app already owns the audio session. */
  manageAudioSession?: boolean;
  onAppStateChange?: (state: SwalvoAppState) => void;
  onNetworkReconnect?: () => void;
  onChatTokenExpiring?: () => Promise<string> | string;
}

/**
 * Swalvo Live Streaming on React Native (Phase 14).
 *
 * A thin wrapper round `Swalvo` on purpose, not a parallel implementation.
 * A stream's host and viewers are ordinary RTC participants in one room,
 * and its chat is an ordinary `@swalvo/chat` conversation. Both are
 * exactly what `Swalvo` already joins and connects to. So every mobile-only
 * concern `Swalvo.join()` handles already, permissions, audio session, app
 * lifecycle, network recovery, applies to a live stream untouched rather
 * than being solved a second time here.
 *
 * ```ts
 * const stream = await joinLiveStream(credentials);
 * await stream.room?.enableCamera(); // only meaningful for a host/co-host
 * await stream.react('❤️');
 * await stream.leave();
 * ```
 */
export class SwalvoLiveStream {
  readonly streamId: string;
  readonly role: LiveStreamRole;
  readonly identity?: string;
  /** Undefined only for an HLS viewer without chat: there is nothing for Swalvo to connect. */
  private readonly swalvo?: Swalvo;
  private readonly chatRootMessageId?: string | null;
  private readonly credentials: LiveStreamCredentials;

  constructor(credentials: LiveStreamCredentials, options: SwalvoLiveStreamOptions = {}) {
    this.streamId = credentials.streamId;
    this.role = credentials.role;
    this.identity = credentials.identity;
    this.chatRootMessageId = credentials.chatRootMessageId;
    this.credentials = credentials;

    // A BROADCAST viewer (playback, no rtc) gets a chat-only Swalvo: HLS is
    // played by <LiveStreamPlayer>, not by WebRTC (live-streaming-v2.md §3.5).
    if (!credentials.rtc && !credentials.chat) return;
    this.swalvo = new Swalvo({
      token: credentials.rtc?.token,
      endpoint: credentials.rtc?.endpoint,
      iceServers: credentials.rtc?.iceServers,
      telemetryUrl: credentials.rtc?.telemetryUrl,
      chatToken: credentials.chat?.token,
      chatApiUrl: credentials.chat?.apiUrl,
      chatUrl: credentials.chat?.chatUrl,
      logLevel: options.logLevel,
      autoReconnect: options.autoReconnect,
      refreshToken: options.refreshToken,
      manageAudioSession: options.manageAudioSession,
      onAppStateChange: options.onAppStateChange,
      onNetworkReconnect: options.onNetworkReconnect,
      onChatTokenExpiring: options.onChatTokenExpiring,
    });
  }

  /** `true` for HOST and CO_HOST. Never inferred; only ever what the credentials said. */
  get isHost(): boolean {
    return this.role === 'HOST' || this.role === 'CO_HOST';
  }

  /** The room, once joined. Always undefined for an HLS viewer. */
  get room(): Room | undefined {
    return this.swalvo?.room;
  }

  /** `rtc` (in the room) or `hls` (a BROADCAST viewer: render `<LiveStreamPlayer url={stream.playbackUrl} />`). */
  get delivery(): 'rtc' | 'hls' {
    return this.credentials.rtc ? 'rtc' : 'hls';
  }

  /** The HLS manifest for a BROADCAST viewer; undefined otherwise. */
  get playbackUrl(): string | undefined {
    return this.credentials.playback?.url ?? undefined;
  }

  /** Watch-time heartbeat for viewer-minute billing: pass as `<LiveStreamPlayer beacon>`. */
  get playbackBeacon(): { url: string; token: string; intervalSec: number } | undefined {
    return this.credentials.playback?.beacon ?? undefined;
  }

  /** LL-HLS for a BROADCAST viewer when the deployment serves it: pass as `<LiveStreamPlayer lowLatencyUrl>`. */
  get lowLatencyPlaybackUrl(): string | undefined {
    return this.credentials.playback?.llhlsUrl ?? undefined;
  }

  /**
   * Stage signals from the stream's chat. Invites / promotions / demotions
   * are only accepted from the server, so a viewer can't forge one.
   * Returns an unsubscribe function.
   */
  onStage(handler: (event: LiveStageEvent) => void): () => void {
    const chat = this.chat;
    if (!chat) return () => undefined;
    return chat.on('message', (message: ChatMessage) => {
      // legacy: `livqeno` is the stage-event metadata key the API sends; kept for wire compatibility.
      const meta = message.metadata as {
        livqeno?: unknown;
        action?: unknown;
        identity?: unknown;
        role?: unknown;
      } | null;
      if (!meta || meta.livqeno !== 'stage' || typeof meta.action !== 'string') return;
      if (SERVER_ONLY_STAGE_ACTIONS.has(meta.action)) {
        if (message.senderId !== 'system') return;
        const identity = String(meta.identity ?? '');
        handler({
          action: meta.action as LiveStageEvent['action'],
          identity,
          role: typeof meta.role === 'string' ? (meta.role as LiveStreamRole) : undefined,
          forMe: !!this.identity && identity === this.identity,
        });
      } else if (VIEWER_STAGE_ACTIONS.has(meta.action)) {
        handler({
          action: meta.action as LiveStageEvent['action'],
          identity: message.senderId,
          forMe: message.senderId === this.identity,
        });
      }
    });
  }

  /** Asks the hosts to bring you on stage (a `raise_hand` stage event). */
  async raiseHand(): Promise<void> {
    await this.sendStage('raise_hand');
  }

  async lowerHand(): Promise<void> {
    await this.sendStage('lower_hand');
  }

  private async sendStage(action: 'raise_hand' | 'lower_hand'): Promise<void> {
    if (!this.chat) {
      throw new RTCError('INVALID_TOKEN', 'raiseHand()/lowerHand() need chat credentials on this stream.');
    }
    await this.chat.sendMessage({ type: 'event', metadata: { livqeno: 'stage', action } });
  }

  /** Only here when the stream has a chat conversation attached. */
  get chat(): SwalvoChatHandle | undefined {
    return this.swalvo?.chat;
  }

  get appState(): SwalvoAppState {
    return this.swalvo?.appState ?? 'active';
  }

  /**
   * Joins the stream's room and connects its chat, if there is one.
   *
   * `requestPermissions` defaults to whether this credential can publish at
   * all. Prompting a VIEWER for camera access would put a dialog in front
   * of them for a permission their token can never use.
   */
  async join(options: { requestPermissions?: boolean } = {}): Promise<Room | undefined> {
    if (!this.credentials.rtc) {
      if (!this.credentials.playback?.url) {
        throw new RTCError(
          'INVALID_TOKEN',
          'These credentials have neither rtc nor a playback url. For a BROADCAST stream, mint the viewer token with acceptPlayback: true.',
        );
      }
      const conversation = this.credentials.chat?.conversations[0];
      if (conversation) await this.chat?.connect(conversation);
      return undefined;
    }
    // A cascaded viewer's credential names an edge room (§3.1).
    return this.swalvo!.join(this.credentials.rtcRoom ?? this.streamId, {
      requestPermissions: options.requestPermissions ?? this.isHost,
    });
  }

  /**
   * Reacts to the stream. Same reaction model as web, CLI and server, hung
   * off the chat message every viewer's reaction lands on. Throws if this
   * stream has no chat conversation attached.
   */
  async react(emoji: string): Promise<void> {
    if (!this.chat || !this.chatRootMessageId) {
      throw new RTCError(
        'INVALID_TOKEN',
        'This stream has no chat conversation attached, so reactions are unavailable.',
      );
    }
    await this.chat.messages.addReaction(this.chatRootMessageId, emoji);
  }

  /** Leaves the room and closes the chat connection. Safe to call twice. */
  async leave(): Promise<void> {
    await this.swalvo?.dispose();
  }
}

/** `SwalvoLiveStream.join()` in a single call, which is the common case. */
export async function joinLiveStream(
  credentials: LiveStreamCredentials,
  options: SwalvoLiveStreamOptions = {},
): Promise<SwalvoLiveStream> {
  const stream = new SwalvoLiveStream(credentials, options);
  await stream.join();
  return stream;
}
