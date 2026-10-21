import { createChatClient, type ChatClient, type ChatMessage } from '@swalvo/chat';
import { createRTCClient, type Room, type RTCClient } from '@swalvo/rtc';
import { HlsPlayback } from './hls-playback';
import type {
  LiveStreamTranscriptionSegment,
  LiveStreamTranscriptionState,
  LiveStreamCredentials,
  LiveStreamJoinOptions,
  LiveStreamQuality,
  LiveStreamRole,
  LiveStreamStageEvent,
} from './types';

/**
 * Swalvo Live Streaming, for the browser.
 *
 * Not a third real-time system. `LiveStream.join()` takes the credentials
 * your backend minted (`POST /v1/live-streams/:id/hosts` or
 * `.../viewer-tokens`) and gives you a real `@swalvo/rtc` `Room`, plus a
 * real `@swalvo/chat` `ChatClient` when the credentials include one.
 * The very same classes those packages already document, not wrappers
 * round them. `LiveStream.room` **is** an `@swalvo/rtc` `Room`, and
 * every method and event on it behaves exactly as documented there.
 *
 * The "host publishes, viewers subscribe" behaviour of a live stream is
 * just ordinary `room.enableCamera()`/`enableMicrophone()` on one side and
 * nothing at all on the other. The server settled who gets which via the
 * RTC token's permission grant long before either browser saw a byte.
 *
 * ```ts
 * const stream = await LiveStream.join(credentials);
 *
 * if (stream.isHost) {
 *   await stream.room.enableCamera();
 *   await stream.room.enableMicrophone();
 * }
 *
 * stream.room.on('trackSubscribed', (track) => videoEl.srcObject = track.mediaStream);
 * await stream.react('❤️');
 * await stream.leave();
 * ```
 *
 * ## The stage (docs/architecture/live-streaming-v2.md §3.4)
 *
 * A viewer can `raiseHand()`; hosts see a `stage` event. Your backend
 * invites (`POST .../stage/invites`) and promotes (`POST .../stage/promote`,
 * which returns host credentials); the viewer then calls
 * `switchRole(credentials)` and is publishing, without a gap: the new room
 * is joined before the old one is left. `room` and `rtc` change on a
 * switch, so listen on the `LiveStream` (`roleChanged`, and the room events
 * it re-emits) rather than on a `room` you held on to.
 */

type Events = {
  stage: (event: LiveStreamStageEvent) => void;
  roleChanged: (role: LiveStreamRole, room: Room) => void;
  permissionsChanged: (permissions: unknown) => void;
  localTrackMutedByServer: (track: unknown) => void;
  disconnected: (reason: unknown) => void;
  /** Live captions (phase6-contracts.md §4): interim segments share a segmentId and replace each other; `final` closes it. */
  transcriptionSegment: (segment: LiveStreamTranscriptionSegment) => void;
  transcriptionStateChanged: (state: LiveStreamTranscriptionState) => void;
  /** An AI agent in the room changed state (phase6 §4). */
  agentStateChanged: (participant: unknown, state: 'listening' | 'thinking' | 'speaking' | 'ended') => void;
};

/** Stage actions only the server may send (system-sent chat events); anything else claiming them is ignored. */
const SERVER_ONLY_STAGE_ACTIONS = new Set(['invited', 'promoted', 'demoted']);
const VIEWER_STAGE_ACTIONS = new Set(['raise_hand', 'lower_hand']);

export class LiveStream {
  readonly streamId: string;
  /** Your identity in the stream, from the mint response (when it included one). */
  readonly identity?: string;
  /** Present only when the credentials included a chat token. `undefined` for an RTC-only integration. */
  get chat(): ChatClient | undefined {
    return this._chat;
  }
  /** Your current role. Changes on `switchRole()`. */
  get role(): LiveStreamRole {
    return this._role;
  }
  /** The underlying `@swalvo/rtc` client. Replaced on `switchRole()`. */
  get rtc(): RTCClient {
    if (!this._rtc) throw new Error(LiveStream.NO_ROOM);
    return this._rtc;
  }
  /** The joined room. Replaced on `switchRole()`; listen for `roleChanged`. */
  get room(): Room {
    if (!this._room) throw new Error(LiveStream.NO_ROOM);
    return this._room;
  }
  /** How you receive the stream: over WebRTC (`rtc`), or as an HLS viewer of a BROADCAST stream (`hls`). */
  get delivery(): 'rtc' | 'hls' {
    return this._room ? 'rtc' : 'hls';
  }

  private static readonly NO_ROOM =
    'This viewer watches over HLS (a BROADCAST stream) and has no RTC room; use attachPlayer(videoElement).';

  private _role: LiveStreamRole;
  private _rtc?: RTCClient;
  private _room?: Room;
  private playback?: HlsPlayback;
  private quality: LiveStreamQuality = 'auto';
  private _chat?: ChatClient;
  private chatRootMessageId?: string | null;
  private readonly options: LiveStreamJoinOptions;
  private readonly listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();
  private unbindRoom?: () => void;
  private unbindChat?: () => void;

  private constructor(
    credentials: LiveStreamCredentials,
    rtc: RTCClient | undefined,
    room: Room | undefined,
    chat: ChatClient | undefined,
    options: LiveStreamJoinOptions,
  ) {
    this.streamId = credentials.streamId;
    this.identity = credentials.identity;
    this._role = credentials.role;
    this._rtc = rtc;
    this._room = room;
    this._chat = chat;
    this.chatRootMessageId = credentials.chatRootMessageId;
    this.options = options;
    if (room) this.bindRoom(room);
    if (chat) this.bindChat(chat);
    if (!room && credentials.playback?.url) {
      this.playback = new HlsPlayback(
        credentials.playback.url,
        undefined,
        credentials.playback.llhlsUrl ?? null,
        credentials.playback.beacon ?? null,
      );
    }
  }

  /** True for HOST and CO_HOST, the only roles the server grants publish permissions to. */
  get isHost(): boolean {
    return this._role === 'HOST' || this._role === 'CO_HOST';
  }

  /**
   * Joins a live stream. One entry point for hosts and viewers alike.
   * Which one you end up as follows entirely from the credentials your
   * backend minted; it's never a parameter here.
   */
  static async join(credentials: LiveStreamCredentials, options: LiveStreamJoinOptions = {}): Promise<LiveStream> {
    if (!credentials.rtc) {
      // A BROADCAST viewer: chat as usual, video over HLS (§3.5).
      if (!credentials.playback?.url) {
        throw new Error(
          'These credentials have neither `rtc` nor a `playback.url`. For a BROADCAST stream, mint the viewer ' +
            'token with acceptPlayback: true once the stream has started.',
        );
      }
      const chat = await LiveStream.connectChat(credentials);
      return new LiveStream(credentials, undefined, undefined, chat, options);
    }
    const { rtc, room } = await LiveStream.connectRtc(credentials, options);
    let chat: ChatClient | undefined;
    try {
      chat = await LiveStream.connectChat(credentials);
    } catch (err) {
      // The room already joined successfully; a chat failure must not
      // leak it. Mirrors leave()'s own cleanup call (rtc.leave(), not
      // room.leave() — same underlying teardown, this is the documented
      // entry point for it).
      await rtc.leave().catch(() => undefined);
      throw err;
    }
    return new LiveStream(credentials, rtc, room, chat, options);
  }

  /** HLS viewers: plays the stream into `video`. Retries while the stream is still starting. */
  async attachPlayer(video: HTMLVideoElement): Promise<void> {
    if (!this.playback) {
      throw new Error(
        'attachPlayer() is for HLS viewers; this LiveStream is in an RTC room, render its tracks instead.',
      );
    }
    await this.playback.attach(video);
  }

  /**
   * The video quality this viewer wants (phase4-contracts.md §2.3). On RTC
   * (origin or an edge, which forward every simulcast layer) it pins each
   * remote video track's layer, and `auto` hands them back to adaptive
   * streaming. On HLS it pins an hls.js rung, or returns to ABR. Applies to
   * tracks that arrive later too.
   */
  setPreferredQuality(quality: LiveStreamQuality): void {
    this.quality = quality;
    this.playback?.setQuality(quality);
    if (this.playback) return;
    for (const participant of this.room.remoteParticipants) {
      for (const track of participant.tracks) if (track.kind !== 'microphone') track.setLayer(quality);
    }
  }

  get preferredQuality(): LiveStreamQuality {
    return this.quality;
  }

  /** Stops HLS playback (also done by leave()). */
  detachPlayer(): void {
    this.playback?.detach();
  }

  private static async connectRtc(
    credentials: LiveStreamCredentials,
    options: LiveStreamJoinOptions,
  ): Promise<{ rtc: RTCClient; room: Room }> {
    const isHost = credentials.role === 'HOST' || credentials.role === 'CO_HOST';
    if (!credentials.rtc) throw new Error('switchRole() needs credentials with an `rtc` field.');
    const rtc = createRTCClient({
      token: credentials.rtc.token,
      endpoint: credentials.rtc.endpoint,
      iceServers: credentials.rtc.iceServers,
      telemetryUrl: credentials.rtc.telemetryUrl,
      // A host on H.264 lets the stream's HLS and RTMP output copy the
      // host's own encoding instead of re-encoding it
      // (docs/architecture/live-streaming-v2.md §3.3). Viewers never
      // publish, so it changes nothing for them.
      ...(isHost ? { preferredVideoCodec: 'h264' as const } : {}),
      ...(options.refreshToken ? { refreshToken: options.refreshToken } : {}),
    });
    // No roomId argument: `rtc.join()` defaults to whatever room the token
    // itself names (`rid`/`rnm` claims), which is the right room whether
    // this is a normal join or a cascaded viewer seated on an edge room
    // (live-streaming-v2.md §3.1) — the server never names that edge room
    // in `credentials.rtcRoom`, so this SDK never needs to inspect it.
    const room = await rtc.join();
    return { rtc, room };
  }

  private static async connectChat(credentials: LiveStreamCredentials): Promise<ChatClient | undefined> {
    if (!credentials.chat) return undefined;
    const chat = createChatClient({
      token: credentials.chat.token,
      apiUrl: credentials.chat.apiUrl,
      chatUrl: credentials.chat.chatUrl,
    });
    await chat.connect({ room: credentials.chat.conversations[0] });
    return chat;
  }

  on<E extends keyof Events>(event: E, handler: Events[E]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (...args: never[]) => void);
    return () => set!.delete(handler as (...args: never[]) => void);
  }

  private emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
    for (const handler of this.listeners.get(event) ?? []) {
      (handler as unknown as (...a: Parameters<Events[E]>) => void)(...args);
    }
  }

  /** Room events that must survive a `switchRole()` are re-emitted here. */
  private bindRoom(room: Room): void {
    this.unbindRoom?.();
    const r = room as unknown as {
      on: (e: string, h: (...a: unknown[]) => void) => (() => void) | void;
      off?: (e: string, h: (...a: unknown[]) => void) => void;
    };
    const forward = (
      event:
        | 'permissionsChanged'
        | 'localTrackMutedByServer'
        | 'disconnected'
        | 'transcriptionSegment'
        | 'transcriptionStateChanged'
        | 'agentStateChanged',
    ) => {
      const handler = (...args: unknown[]) => (this.emit as (e: string, ...a: unknown[]) => void)(event, ...args);
      const unsubscribe = r.on(event, handler);
      return () => (typeof unsubscribe === 'function' ? unsubscribe() : r.off?.(event, handler));
    };
    // A pinned quality follows new tracks (and a switchRole() into a new room).
    const onTrack = (track: unknown) => {
      const t = track as { kind?: string; setLayer?: (layer: LiveStreamQuality) => void };
      if (this.quality !== 'auto' && t.kind !== 'microphone') t.setLayer?.(this.quality);
    };
    const offTrack = r.on('trackSubscribed', onTrack);
    const offs = [
      forward('permissionsChanged'),
      forward('localTrackMutedByServer'),
      forward('disconnected'),
      forward('transcriptionSegment'),
      forward('transcriptionStateChanged'),
      forward('agentStateChanged'),
      () => (typeof offTrack === 'function' ? offTrack() : r.off?.('trackSubscribed', onTrack)),
    ];
    this.unbindRoom = () => offs.forEach((off) => off());
  }

  private bindChat(chat: ChatClient): void {
    this.unbindChat?.();
    this.unbindChat = chat.on('message', (message: ChatMessage) => this.onChatMessage(message));
  }

  private onChatMessage(message: ChatMessage): void {
    // legacy: the `livqeno` metadata key is the stage-event wire contract with the API; kept for wire compatibility.
    const meta = message.metadata as { livqeno?: unknown; action?: unknown; identity?: unknown; role?: unknown } | null;
    if (!meta || meta.livqeno !== 'stage' || typeof meta.action !== 'string') return;
    const action = meta.action;
    if (SERVER_ONLY_STAGE_ACTIONS.has(action)) {
      if (message.senderId !== 'system') return; // forged: only the server announces role changes
      this.emit('stage', {
        action: action as LiveStreamStageEvent['action'],
        identity: String(meta.identity ?? ''),
        role: typeof meta.role === 'string' ? (meta.role as LiveStreamRole) : undefined,
        forMe: !!this.identity && meta.identity === this.identity,
      });
    } else if (VIEWER_STAGE_ACTIONS.has(action)) {
      this.emit('stage', {
        action: action as LiveStreamStageEvent['action'],
        identity: message.senderId,
        forMe: message.senderId === this.identity,
      });
    }
  }

  private async sendStage(action: 'raise_hand' | 'lower_hand'): Promise<void> {
    if (!this._chat) {
      throw new Error('raiseHand()/lowerHand() need the `chat` field on the credentials passed to join().');
    }
    await this._chat.sendMessage({ type: 'event', metadata: { livqeno: 'stage', action } });
  }

  /** Asks the hosts to bring you on stage. They see a `stage` event (`raise_hand`). */
  raiseHand(): Promise<void> {
    return this.sendStage('raise_hand');
  }

  lowerHand(): Promise<void> {
    return this.sendStage('lower_hand');
  }

  /**
   * Switches to new credentials: promoted to co-host (from
   * `POST .../stage/promote`), or back to viewer. Joins the new room before
   * leaving the old one, so there's no gap in what you see, then swaps
   * `rtc`/`room` and emits `roleChanged`. Chat moves to the new chat token
   * when the credentials carry one.
   */
  async switchRole(credentials: LiveStreamCredentials): Promise<void> {
    if (credentials.streamId !== this.streamId) {
      throw new Error(`switchRole() needs credentials for stream ${this.streamId}, got ${credentials.streamId}`);
    }
    const next = await LiveStream.connectRtc(credentials, this.options);
    const previous = this._rtc;
    this._rtc = next.rtc;
    this._room = next.room;
    this._role = credentials.role;
    this.bindRoom(next.room);
    // An HLS viewer promoted on stage now has a room; the player stops
    // only once the room is live, so there's no gap either way.
    this.playback?.detach();
    this.playback = undefined;
    await previous?.leave().catch(() => undefined);

    if (credentials.chat) {
      const chat = await LiveStream.connectChat(credentials);
      const oldChat = this._chat;
      this._chat = chat;
      if (chat) this.bindChat(chat);
      await oldChat?.disconnect().catch(() => undefined);
    }
    this.chatRootMessageId = credentials.chatRootMessageId ?? this.chatRootMessageId;
    this.emit('roleChanged', this._role, this._room);
  }

  /**
   * The TikTok-style heart tap. Reactions ride on the stream's own root
   * chat message through `@swalvo/chat`'s existing, already-aggregated
   * reaction model (`chat.messages.addReaction`).
   */
  async react(emoji: string): Promise<void> {
    if (!this._chat) {
      throw new Error(
        'This LiveStream has no chat credentials; react() needs the `chat` field on the credentials passed to join().',
      );
    }
    if (!this.chatRootMessageId) {
      throw new Error('This stream has no chatRootMessageId to react to.');
    }
    await this._chat.messages.addReaction(this.chatRootMessageId, emoji);
  }

  /**
   * Leaves the room and disconnects chat. The stream carries on for
   * everybody else; this only tears down *your* connection to it.
   */
  async leave(): Promise<void> {
    this.unbindRoom?.();
    this.unbindChat?.();
    this.playback?.detach();
    await this._rtc?.leave();
    await this._chat?.disconnect();
  }
}

/** Functional alias, to match `createRTCClient`, `createChatClient` and `createSwalvo`. */
export function joinLiveStream(
  credentials: LiveStreamCredentials,
  options?: LiveStreamJoinOptions,
): Promise<LiveStream> {
  return LiveStream.join(credentials, options);
}
