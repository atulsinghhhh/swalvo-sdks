import { createRTCClient } from '@swalvo/rtc';
export { RTCError, isRTCError } from '@swalvo/rtc';
import { createChatClient } from '@swalvo/chat';
export { isRavenChatError, isSwalvoChatError } from '@swalvo/chat';

// src/index.ts

// src/live/hls-playback.ts
var defaultLoader = () => import('hls.js');
var RETRY_MS = 2e3;
var HlsPlayback = class _HlsPlayback {
  constructor(url, loader = defaultLoader, lowLatencyUrl = null, beacon = null) {
    this.url = url;
    this.loader = loader;
    this.lowLatencyUrl = lowLatencyUrl;
    this.beacon = beacon;
    this.destroyed = false;
    this.quality = "auto";
    this.lowLatency = Boolean(lowLatencyUrl);
  }
  /**
   * Reports watch time every `intervalSec` while the video is actually
   * playing (not paused, not stalled before the first frame). Best-effort:
   * a failed beat is dropped, never retried, and never affects playback.
   */
  startBeacon(video) {
    const beacon = this.beacon;
    if (!beacon || this.beaconTimer || typeof fetch !== "function") return;
    this.beaconTimer = setInterval(() => {
      if (this.destroyed || video.paused || video.ended || video.readyState < 2) return;
      void fetch(beacon.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: beacon.token }),
        keepalive: true
      }).catch(() => void 0);
    }, Math.max(5, beacon.intervalSec) * 1e3);
  }
  /** The URL currently being played: LL-HLS until it fails, then the standard one. */
  get currentUrl() {
    return this.lowLatency && this.lowLatencyUrl ? this.lowLatencyUrl : this.url;
  }
  /**
   * Pins a rung (the master lists the top rung first) or returns to ABR.
   * hls.js only: Safari's native player always chooses for itself.
   */
  setQuality(quality) {
    this.quality = quality;
    if (this.hls) this.hls.currentLevel = _HlsPlayback.levelOf(quality);
  }
  static levelOf(quality) {
    return quality === "high" ? 0 : quality === "medium" ? 1 : quality === "low" ? 2 : -1;
  }
  /** Whether playback is on the low-latency origin. */
  get isLowLatency() {
    return this.lowLatency;
  }
  /** Starts playing into `video`. Resolves once playback has been set up (not once the first frame shows). */
  async attach(video) {
    this.detach();
    this.destroyed = false;
    this.video = video;
    this.startBeacon(video);
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      const onError = () => {
        if (this.destroyed) return;
        this.lowLatency = false;
        this.retry = setTimeout(() => {
          video.src = this.currentUrl;
          void video.play().catch(() => void 0);
        }, RETRY_MS);
      };
      video.addEventListener("error", onError);
      video.src = this.currentUrl;
      void video.play().catch(() => void 0);
      return;
    }
    let mod;
    try {
      mod = await this.loader();
    } catch {
      throw new Error(
        "This stream is delivered over HLS, and this browser needs hls.js to play it. Install it: `npm install hls.js`."
      );
    }
    const Hls = mod.default;
    if (!Hls.isSupported()) throw new Error("This browser supports neither native HLS nor Media Source Extensions.");
    const hls = new Hls(
      this.lowLatency ? {
        // LL-HLS: hls.js follows the playlist's PART-HOLD-BACK and blocking reloads.
        lowLatencyMode: true,
        startLevel: _HlsPlayback.levelOf(this.quality),
        maxLiveSyncPlaybackRate: 1.2,
        backBufferLength: 30,
        manifestLoadingMaxRetry: 0
      } : {
        startLevel: _HlsPlayback.levelOf(this.quality),
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 6,
        maxLiveSyncPlaybackRate: 1.1,
        backBufferLength: 30,
        manifestLoadingMaxRetry: 0
        // we retry ourselves, forever, while the stream starts
      }
    );
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || this.destroyed) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR || this.lowLatency) {
        if (this.lowLatency) {
          this.lowLatency = false;
          void this.attach(video);
          return;
        }
        this.retry = setTimeout(() => {
          hls.loadSource(this.url);
          hls.startLoad();
        }, RETRY_MS);
      }
    });
    hls.loadSource(this.currentUrl);
    hls.attachMedia(video);
    this.hls = hls;
    void video.play().catch(() => void 0);
  }
  /** Stops playback and releases the element. */
  detach() {
    this.destroyed = true;
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    this.beaconTimer = void 0;
    if (this.retry) clearTimeout(this.retry);
    this.hls?.destroy();
    this.hls = void 0;
    if (this.video) {
      this.video.removeAttribute("src");
      this.video.load?.();
      this.video = void 0;
    }
  }
};

// src/live/live-stream.ts
var SERVER_ONLY_STAGE_ACTIONS = /* @__PURE__ */ new Set(["invited", "promoted", "demoted"]);
var VIEWER_STAGE_ACTIONS = /* @__PURE__ */ new Set(["raise_hand", "lower_hand"]);
var _LiveStream = class _LiveStream {
  constructor(credentials, rtc, room, chat, options) {
    this.quality = "auto";
    this.listeners = /* @__PURE__ */ new Map();
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
        void 0,
        credentials.playback.llhlsUrl ?? null,
        credentials.playback.beacon ?? null
      );
    }
  }
  /** Present only when the credentials included a chat token. `undefined` for an RTC-only integration. */
  get chat() {
    return this._chat;
  }
  /** Your current role. Changes on `switchRole()`. */
  get role() {
    return this._role;
  }
  /** The underlying `@swalvo/rtc` client. Replaced on `switchRole()`. */
  get rtc() {
    if (!this._rtc) throw new Error(_LiveStream.NO_ROOM);
    return this._rtc;
  }
  /** The joined room. Replaced on `switchRole()`; listen for `roleChanged`. */
  get room() {
    if (!this._room) throw new Error(_LiveStream.NO_ROOM);
    return this._room;
  }
  /** How you receive the stream: over WebRTC (`rtc`), or as an HLS viewer of a BROADCAST stream (`hls`). */
  get delivery() {
    return this._room ? "rtc" : "hls";
  }
  /** True for HOST and CO_HOST, the only roles the server grants publish permissions to. */
  get isHost() {
    return this._role === "HOST" || this._role === "CO_HOST";
  }
  /**
   * Joins a live stream. One entry point for hosts and viewers alike.
   * Which one you end up as follows entirely from the credentials your
   * backend minted; it's never a parameter here.
   */
  static async join(credentials, options = {}) {
    if (!credentials.rtc) {
      if (!credentials.playback?.url) {
        throw new Error(
          "These credentials have neither `rtc` nor a `playback.url`. For a BROADCAST stream, mint the viewer token with acceptPlayback: true once the stream has started."
        );
      }
      const chat2 = await _LiveStream.connectChat(credentials);
      return new _LiveStream(credentials, void 0, void 0, chat2, options);
    }
    const { rtc, room } = await _LiveStream.connectRtc(credentials, options);
    const chat = await _LiveStream.connectChat(credentials);
    return new _LiveStream(credentials, rtc, room, chat, options);
  }
  /** HLS viewers: plays the stream into `video`. Retries while the stream is still starting. */
  async attachPlayer(video) {
    if (!this.playback) {
      throw new Error("attachPlayer() is for HLS viewers; this LiveStream is in an RTC room, render its tracks instead.");
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
  setPreferredQuality(quality) {
    this.quality = quality;
    this.playback?.setQuality(quality);
    if (this.playback) return;
    for (const participant of this.room.remoteParticipants) {
      for (const track of participant.tracks) if (track.kind !== "microphone") track.setLayer(quality);
    }
  }
  get preferredQuality() {
    return this.quality;
  }
  /** Stops HLS playback (also done by leave()). */
  detachPlayer() {
    this.playback?.detach();
  }
  static async connectRtc(credentials, options) {
    const isHost = credentials.role === "HOST" || credentials.role === "CO_HOST";
    if (!credentials.rtc) throw new Error("switchRole() needs credentials with an `rtc` field.");
    const rtc = createRTCClient({
      token: credentials.rtc.token,
      endpoint: credentials.rtc.endpoint,
      iceServers: credentials.rtc.iceServers,
      telemetryUrl: credentials.rtc.telemetryUrl,
      // A host on H.264 lets the stream's HLS and RTMP output copy the
      // host's own encoding instead of re-encoding it
      // (docs/architecture/live-streaming-v2.md §3.3). Viewers never
      // publish, so it changes nothing for them.
      ...isHost ? { preferredVideoCodec: "h264" } : {},
      ...options.refreshToken ? { refreshToken: options.refreshToken } : {}
    });
    const room = await rtc.join(credentials.rtcRoom ?? credentials.streamId);
    return { rtc, room };
  }
  static async connectChat(credentials) {
    if (!credentials.chat) return void 0;
    const chat = createChatClient({
      token: credentials.chat.token,
      apiUrl: credentials.chat.apiUrl,
      chatUrl: credentials.chat.chatUrl
    });
    await chat.connect({ room: credentials.chat.conversations[0] });
    return chat;
  }
  on(event, handler) {
    let set = this.listeners.get(event);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }
  emit(event, ...args) {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(...args);
    }
  }
  /** Room events that must survive a `switchRole()` are re-emitted here. */
  bindRoom(room) {
    this.unbindRoom?.();
    const r = room;
    const forward = (event) => {
      const handler = (...args) => this.emit(event, ...args);
      const unsubscribe = r.on(event, handler);
      return () => typeof unsubscribe === "function" ? unsubscribe() : r.off?.(event, handler);
    };
    const onTrack = (track) => {
      const t = track;
      if (this.quality !== "auto" && t.kind !== "microphone") t.setLayer?.(this.quality);
    };
    const offTrack = r.on("trackSubscribed", onTrack);
    const offs = [
      forward("permissionsChanged"),
      forward("localTrackMutedByServer"),
      forward("disconnected"),
      forward("transcriptionSegment"),
      forward("transcriptionStateChanged"),
      forward("agentStateChanged"),
      () => typeof offTrack === "function" ? offTrack() : r.off?.("trackSubscribed", onTrack)
    ];
    this.unbindRoom = () => offs.forEach((off) => off());
  }
  bindChat(chat) {
    this.unbindChat?.();
    this.unbindChat = chat.on("message", (message) => this.onChatMessage(message));
  }
  onChatMessage(message) {
    const meta = message.metadata;
    if (!meta || meta.livqeno !== "stage" || typeof meta.action !== "string") return;
    const action = meta.action;
    if (SERVER_ONLY_STAGE_ACTIONS.has(action)) {
      if (message.senderId !== "system") return;
      this.emit("stage", {
        action,
        identity: String(meta.identity ?? ""),
        role: typeof meta.role === "string" ? meta.role : void 0,
        forMe: !!this.identity && meta.identity === this.identity
      });
    } else if (VIEWER_STAGE_ACTIONS.has(action)) {
      this.emit("stage", {
        action,
        identity: message.senderId,
        forMe: message.senderId === this.identity
      });
    }
  }
  async sendStage(action) {
    if (!this._chat) {
      throw new Error("raiseHand()/lowerHand() need the `chat` field on the credentials passed to join().");
    }
    await this._chat.sendMessage({ type: "event", metadata: { livqeno: "stage", action } });
  }
  /** Asks the hosts to bring you on stage. They see a `stage` event (`raise_hand`). */
  raiseHand() {
    return this.sendStage("raise_hand");
  }
  lowerHand() {
    return this.sendStage("lower_hand");
  }
  /**
   * Switches to new credentials: promoted to co-host (from
   * `POST .../stage/promote`), or back to viewer. Joins the new room before
   * leaving the old one, so there's no gap in what you see, then swaps
   * `rtc`/`room` and emits `roleChanged`. Chat moves to the new chat token
   * when the credentials carry one.
   */
  async switchRole(credentials) {
    if (credentials.streamId !== this.streamId) {
      throw new Error(`switchRole() needs credentials for stream ${this.streamId}, got ${credentials.streamId}`);
    }
    const next = await _LiveStream.connectRtc(credentials, this.options);
    const previous = this._rtc;
    this._rtc = next.rtc;
    this._room = next.room;
    this._role = credentials.role;
    this.bindRoom(next.room);
    this.playback?.detach();
    this.playback = void 0;
    await previous?.leave().catch(() => void 0);
    if (credentials.chat) {
      const chat = await _LiveStream.connectChat(credentials);
      const oldChat = this._chat;
      this._chat = chat;
      if (chat) this.bindChat(chat);
      await oldChat?.disconnect().catch(() => void 0);
    }
    this.chatRootMessageId = credentials.chatRootMessageId ?? this.chatRootMessageId;
    this.emit("roleChanged", this._role, this._room);
  }
  /**
   * The TikTok-style heart tap. Reactions ride on the stream's own root
   * chat message through `@swalvo/chat`'s existing, already-aggregated
   * reaction model (`chat.messages.addReaction`).
   */
  async react(emoji) {
    if (!this._chat) {
      throw new Error(
        "This LiveStream has no chat credentials; react() needs the `chat` field on the credentials passed to join()."
      );
    }
    if (!this.chatRootMessageId) {
      throw new Error("This stream has no chatRootMessageId to react to.");
    }
    await this._chat.messages.addReaction(this.chatRootMessageId, emoji);
  }
  /**
   * Leaves the room and disconnects chat. The stream carries on for
   * everybody else; this only tears down *your* connection to it.
   */
  async leave() {
    this.unbindRoom?.();
    this.unbindChat?.();
    this.playback?.detach();
    await this._rtc?.leave();
    await this._chat?.disconnect();
  }
};
_LiveStream.NO_ROOM = "This viewer watches over HLS (a BROADCAST stream) and has no RTC room; use attachPlayer(videoElement).";
var LiveStream = _LiveStream;
function joinLiveStream(credentials, options) {
  return LiveStream.join(credentials, options);
}
var Swalvo = class {
  constructor(config) {
    this.live = { join: (credentials) => LiveStream.join(credentials) };
    if (Boolean(config.token) !== Boolean(config.endpoint)) {
      throw new Error(
        "Swalvo needs both `token` and `endpoint` for RTC, or neither for a messaging-only app. Both come from the same token-mint response."
      );
    }
    if (!config.token && !config.chatToken) {
      throw new Error(
        "Swalvo needs at least one credential: `token` + `endpoint` for calls, `chatToken` for messaging, or both."
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
        logLevel: config.logLevel
      });
    }
    if (config.chatToken) {
      this.chat = createChatClient({
        token: config.chatToken,
        apiUrl: config.chatApiUrl ?? config.telemetryUrl,
        chatUrl: config.chatUrl,
        logLevel: config.logLevel,
        onTokenExpiring: config.onChatTokenExpiring
      });
    }
  }
  /** True if this instance got RTC credentials. */
  get hasRtc() {
    return this.rtc !== void 0;
  }
  /** True if this instance got a chat token. */
  get hasChat() {
    return this.chat !== void 0;
  }
  /** The room currently joined, if any. */
  get room() {
    return this.currentRoom;
  }
  /**
   * Joins a room. If this instance has no RTC credentials it throws
   * straight away with an error explaining why, instead of blowing up
   * later as a null reference.
   */
  async join(roomId) {
    if (!this.rtc) {
      throw new Error(
        "This Swalvo instance has no RTC credentials, so it cannot join a room. Pass `token` and `endpoint` to enable calls, or use `swalvo.chat` for messaging."
      );
    }
    this.currentRoom = await this.rtc.join(roomId);
    return this.currentRoom;
  }
  /** Leaves the room, keeping any chat connection open. */
  async leave() {
    await this.currentRoom?.leave();
    this.currentRoom = void 0;
  }
  /**
   * Tears down the lot, chat included. Call it when the feature itself is
   * going away. Moving between rooms? `leave()` on its own is what you want.
   */
  async dispose() {
    await this.leave();
    await this.chat?.disconnect();
  }
};
function createSwalvo(config) {
  return new Swalvo(config);
}
var Raven = Swalvo;
var createRaven = createSwalvo;

export { LiveStream, Raven, Swalvo, createRaven, createSwalvo, joinLiveStream };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map