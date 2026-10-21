import { RTCError } from './errors';
import { TypedEventEmitter } from './events';
import { createTelemetryClient, type TelemetryClient } from './internal/telemetry/telemetry-client';
import { detectPlatform } from './internal/telemetry/platform';
import type { Logger } from './logger';
import { LocalParticipant, RemoteParticipant, type Participant, type ParticipantMetadataSnapshot } from './participant';
import type {
  ConnectionQuality,
  DataChannelKind,
  DataSendOptions,
  DisconnectReason,
  ParticipantPermissions,
  RTCWarning,
  ScreenShareOptions,
  SFUAdapter,
  SdkConnectionState,
} from './internal/sfu/types';
import { LocalTrack, RemoteTrack, type TrackKind, type TrackStats } from './track';
import { SDK_VERSION } from './version';
import type { SimulcastStatus } from './internal/sfu/simulcast';
import type { E2EEState } from './e2ee/types';
import type { AgentState, TranscriptionSegment, TranscriptionState } from './transcription';

export type ConnectionState = SdkConnectionState;

/**
 * A diagnostic snapshot that's safe to paste straight into a bug report.
 * No tokens, no secrets, nothing sensitive.
 *
 * Anything we don't know comes back `undefined`; nothing here is guessed.
 * `iceConnectionState` and `signalingState` were always `undefined` under
 * the LiveKit adapter, which never exposed them. The native adapter does,
 * so they now carry the states that actually explain a failed connection.
 */
export interface ConnectionDiagnostics {
  connectionState: ConnectionState;
  iceConnectionState?: string;
  signalingState?: string;
  /**
   * What the SFU makes of this connection. Worth sitting next to the local
   * states, because the two can disagree, and "server says failed, browser
   * says connected" is a diagnosis, not a contradiction.
   */
  remoteIceConnectionState?: string;
  remotePeerConnectionState?: string;
  reconnectCount: number;
  sdkVersion: string;
  platform: string;
  browser: string;
}

/**
 * Live media-quality stats. A separate `async` method rather than another
 * field on `getDiagnostics()`, and that's on purpose. `getDiagnostics()`
 * is synchronous and cheap so you can call it from anywhere at any time.
 * Collecting real WebRTC stats is neither: it costs at least one round
 * trip through the browser's stats API per track, and squashing per-track
 * numbers into one flat object throws away the very thing that made them
 * useful in a room full of people.
 */
export interface ConnectionStats {
  connectionState: ConnectionState;
  /** The SFU's own read on connection health. See `ConnectionQuality`. */
  connectionQuality: ConnectionQuality;
  /** One entry per track this side has published. */
  local: TrackStats[];
  /** One entry per subscribed track, across all remote participants. */
  remote: TrackStats[];
}

export interface RoomEventMap {
  connectionStateChanged: (state: ConnectionState) => void;
  connected: () => void;
  /**
   * The room is no longer connected and the SDK will not reconnect it on
   * its own. `reason` says why — `'REMOVED'` and `'ROOM_CLOSED'` come from
   * the server and must not be answered with a rejoin. See
   * `DisconnectReason`. A handler declared with no parameter keeps working.
   */
  disconnected: (reason: DisconnectReason) => void;
  /**
   * The connection dropped and the SDK is recovering it. Signaling
   * reconnects resume the previous session when the server allows, so
   * media may keep flowing throughout; otherwise the media connection is
   * rebuilt and local tracks republished. Either way `reconnected` (or
   * `disconnected`) follows.
   */
  reconnecting: () => void;
  reconnected: () => void;
  participantJoined: (participant: RemoteParticipant) => void;
  participantLeft: (participant: RemoteParticipant) => void;
  trackPublished: (kind: TrackKind, participant: RemoteParticipant) => void;
  trackUnpublished: (kind: TrackKind, participant: RemoteParticipant) => void;
  trackSubscribed: (track: RemoteTrack, participant: RemoteParticipant) => void;
  trackUnsubscribed: (track: RemoteTrack, participant: RemoteParticipant) => void;
  /** Phase 11 addition. A remote participant muted or unmuted a track they'd already published. */
  trackMuted: (kind: TrackKind, participant: RemoteParticipant) => void;
  trackUnmuted: (kind: TrackKind, participant: RemoteParticipant) => void;
  localTrackPublished: (track: LocalTrack) => void;
  localTrackUnpublished: (track: LocalTrack) => void;
  /**
   * A data message arrived. `participant` is the sender as the SFU saw it
   * (never the sender's own claim), or `undefined` for a message from the
   * server (`POST /v1/rooms/:roomId/data`) or from a client on the legacy
   * format. `topic` is whatever the sender passed to `sendData()`, if any.
   */
  dataReceived: (payload: Uint8Array, participant?: RemoteParticipant, topic?: string) => void;
  /**
   * The SFU dropped some of this participant's data messages over its rate
   * limit (reliable: 100 msg/s and 1 MiB/s; lossy: 300 msg/s). Slow down.
   */
  dataThrottled: (channel: DataChannelKind) => void;
  /**
   * Someone's `metadata` or `attributes` changed — the local participant
   * included, once the server confirms a `setMetadata()` / `setAttributes()`.
   * `prev` holds the values from before.
   */
  participantMetadataChanged: (participant: Participant, prev: ParticipantMetadataSnapshot) => void;
  error: (error: RTCError) => void;
  /**
   * The server changed what this participant may do, mid-session: a
   * moderator revoked publishing, or a live-stream viewer was promoted to
   * the stage. If publish rights were withdrawn the SDK has already
   * stopped the affected local tracks (each gets `localTrackUnpublished`;
   * no `error`). Rights gained take effect at once: `enableCamera()` works
   * without reconnecting. Also readable at any time as `room.permissions`.
   */
  permissionsChanged: (permissions: ParticipantPermissions) => void;
  /**
   * The server muted one of this participant's own tracks (moderation).
   * The track is already muted locally (`track.isMuted` is true) and the
   * SFU has stopped forwarding it. Kept apart from `trackMuted`, which is
   * about *remote* participants. Unmuting is left to the user, through the
   * usual `enableMicrophone()` / `track.unmute()`.
   */
  localTrackMutedByServer: (track: LocalTrack) => void;
  /** Non-fatal conditions, such as a token refresh that failed. The call carries on. */
  warning: (warning: RTCWarning) => void;
  /**
   * The set of people speaking changed, as the SFU measures it from the
   * audio levels it receives (docs/architecture/phase2-media-contracts.md
   * §2). Loudest first, at most eight, the local participant included when
   * they are talking; an empty array means silence. Arrives at most every
   * 300 ms. Each participant also has `isSpeaking` / `audioLevel` and its
   * own `isSpeakingChanged` event. Never fires against a server that
   * predates speaker detection.
   */
  activeSpeakersChanged: (speakers: Participant[]) => void;
  /**
   * The SFU re-scored someone's connection (§3), at most once a second.
   * `participant` may be `room.localParticipant` — your own score is the
   * one to show a "your connection is unstable" banner from. Also readable
   * any time as `participant.connectionQuality`.
   */
  connectionQualityChanged: (participant: Participant, quality: ConnectionQuality) => void;
  /**
   * A subscribed track's `subscriptionState` or `layer` changed (§4): the
   * SFU paused a video because your bandwidth cannot carry it, resumed it,
   * switched layer, or confirmed a pause you asked for. Show a "video
   * paused" overlay from `track.subscriptionState === 'paused_bandwidth'`
   * rather than leaving a frozen frame.
   */
  trackSubscriptionStateChanged: (track: RemoteTrack, participant: RemoteParticipant) => void;
  /**
   * End-to-end encryption state changed for someone (docs: /rtc/e2ee).
   * For `room.localParticipant` it describes encrypting what you send; for
   * a remote participant, decrypting what they send. `'missing_key'` and
   * `'decrypt_failed'` mean their media is being dropped — usually a wrong
   * or missing key. Only fires in an E2EE room with `e2ee` configured.
   */
  e2eeStateChanged: (participant: Participant, state: E2EEState) => void;
  /**
   * A live caption (docs: /ai/transcription). Interim segments share a
   * `segmentId` and replace each other; the `final` one closes it, and a
   * final with empty `text` means "clear the interim". An agent's own
   * speech arrives here too, with `participantId` set to the agent. To
   * render captions, fold these through a `CaptionStore`.
   */
  transcriptionSegment: (segment: TranscriptionSegment) => void;
  /** The room's transcription started, became active, stopped, or failed. */
  transcriptionStateChanged: (state: TranscriptionState) => void;
  /**
   * An AI voice agent is now `listening`, `thinking`, `speaking`, or has
   * `ended` (docs: /ai/agents). Also readable as `participant.agentState`.
   */
  agentStateChanged: (participant: Participant, state: AgentState) => void;
}

/**
 * A joined room. You get one from `client.join(roomId)`; don't build it
 * yourself. It owns participant and track state plus every room-scoped
 * action. No SDP, ICE candidates or RTCPeerConnection leak out here.
 */
export class Room extends TypedEventEmitter<RoomEventMap> {
  readonly roomId: string;
  /** Stable for the whole life of this connection. This is the id to quote in a bug report (Phase 9 spec §8). */
  readonly connectionId: string;
  readonly localParticipant: LocalParticipant;
  private readonly adapter: SFUAdapter;
  private readonly logger: Logger;
  private readonly telemetry: TelemetryClient;
  private reconnectCount = 0;
  private statsTimer?: ReturnType<typeof setInterval>;

  /**
   * How often the stats monitor samples and reports. Often enough that a
   * dashboard showing "now" isn't showing you five minutes ago, rarely
   * enough that it doesn't hammer the telemetry endpoint on a call where
   * dozens of participants are all doing exactly this.
   */
  private static readonly STATS_INTERVAL_MS = 5_000;

  /** @internal Use `client.join(roomId)`. The telemetry client defaults to a no-op, so tests and advanced setups can build a Room directly without wiring one up. */
  constructor(
    adapter: SFUAdapter,
    roomId: string,
    logger: Logger,
    telemetry: TelemetryClient = createTelemetryClient({ enabled: false, token: '', sdkVersion: SDK_VERSION, logger }),
  ) {
    super();
    this.adapter = adapter;
    this.roomId = roomId;
    this.logger = logger;
    this.telemetry = telemetry;
    this.connectionId = telemetry.connectionId;
    this.localParticipant = adapter.localParticipant;
    this.wireAdapterEvents();
  }

  get remoteParticipants(): RemoteParticipant[] {
    return Array.from(this.adapter.remoteParticipants.values());
  }

  get connectionState(): ConnectionState {
    return this.adapter.connectionState;
  }

  /**
   * Whether this room is end-to-end encrypted (created with `e2ee: true`).
   * In such a room publishing needs `RTCClientConfig.e2ee`; see
   * `isE2EEActive` for whether this client is actually encrypting.
   */
  get isE2EE(): boolean {
    return this.adapter.e2eeRequired === true;
  }

  /** True while this client encrypts what it sends (an E2EE room, with a key provider, on a capable browser). */
  get isE2EEActive(): boolean {
    return this.adapter.isE2EEActive === true;
  }

  /** Who is speaking right now, loudest first. See the `activeSpeakersChanged` event. */
  get activeSpeakers(): Participant[] {
    return this.adapter.activeSpeakers ?? [];
  }

  /**
   * What this participant may currently do: the token's grants, updated
   * live by the server. Undefined when the token carries no grants and the
   * server has not said. The server enforces these regardless; this is for
   * deciding which controls to show.
   */
  get permissions(): ParticipantPermissions | undefined {
    return this.adapter.permissions;
  }

  /**
   * Tells the SDK the device's network just changed — Wi-Fi to cellular,
   * a VPN coming up — so it can recover straight away instead of waiting
   * for timeouts: a pending reconnect runs now, and a live media
   * connection restarts ICE onto the new network.
   *
   * Browsers seldom give a page a reliable signal for this, so the web SDK
   * never calls it on its own; the React Native SDK calls it from NetInfo.
   * Safe to call at any time, and a no-op once the room has been left.
   */
  handleNetworkChange(): void {
    this.adapter.handleNetworkChange?.();
  }

  private wireAdapterEvents(): void {
    let prevState: ConnectionState = this.adapter.connectionState;

    this.adapter.on('connectionStateChanged', (state) => {
      this.emit('connectionStateChanged', state);

      if (state === 'connected') {
        if (prevState === 'reconnecting') {
          this.reconnectCount++;
          this.telemetry.send('reconnected');
          this.emit('reconnected');
        } else {
          this.telemetry.send('connected');
          this.emit('connected');
        }
        this.startStatsMonitor();
      } else if (state === 'reconnecting' && prevState !== 'reconnecting') {
        this.telemetry.send('reconnecting');
        this.emit('reconnecting');
      } else if (state === 'disconnected' || state === 'failed') {
        this.stopStatsMonitor();
        this.telemetry.send(state === 'failed' ? 'connection_failed' : 'disconnected');
        const last = this.adapter.lastDisconnect;
        const reason: DisconnectReason =
          last?.reason ?? (state === 'failed' ? 'CONNECTION_FAILED' : 'CLIENT_INITIATED');
        this.emit('disconnected', reason);
        if (state === 'failed') {
          // The adapter's own error when it has one: "the token expired"
          // is something an application can act on, and the generic line
          // below is not.
          const error =
            last?.error ?? new RTCError('CONNECTION_FAILED', 'Connection failed after exhausting reconnect attempts');
          this.telemetry.send('error', { code: error.code, message: error.message });
          this.emit('error', error);
        }
      }

      prevState = state;
    });

    this.adapter.on('participantJoined', (participant) => {
      this.telemetry.send('participant_joined', { participantIdentity: participant.identity });
      this.emit('participantJoined', participant);
    });
    this.adapter.on('participantLeft', (participant) => {
      this.telemetry.send('participant_left', { participantIdentity: participant.identity });
      this.emit('participantLeft', participant);
    });
    this.adapter.on('trackPublished', (kind, participant) => this.emit('trackPublished', kind, participant));
    this.adapter.on('trackUnpublished', (kind, participant) => this.emit('trackUnpublished', kind, participant));
    this.adapter.on('trackSubscribed', (track, participant) => this.emit('trackSubscribed', track, participant));
    this.adapter.on('trackUnsubscribed', (track, participant) => this.emit('trackUnsubscribed', track, participant));
    this.adapter.on('trackMuted', (kind, participant) => this.emit('trackMuted', kind, participant));
    this.adapter.on('trackUnmuted', (kind, participant) => this.emit('trackUnmuted', kind, participant));
    this.adapter.on('localTrackPublished', (track) => {
      this.telemetry.send('track_published', { kind: track.kind });
      this.emit('localTrackPublished', track);
    });
    this.adapter.on('localTrackUnpublished', (track) => {
      this.telemetry.send('track_unpublished', { kind: track.kind });
      this.emit('localTrackUnpublished', track);
    });
    this.adapter.on('dataReceived', (payload, participant, topic) =>
      this.emit('dataReceived', payload, participant, topic),
    );
    this.adapter.on('dataThrottled', (channel) => {
      this.logger.warn('data messages throttled', channel);
      this.emit('dataThrottled', channel);
    });
    this.adapter.on('participantMetadataChanged', (participant, prev) =>
      this.emit('participantMetadataChanged', participant, prev),
    );
    this.adapter.on('permissionsChanged', (permissions) => this.emit('permissionsChanged', permissions));
    this.adapter.on('localTrackMutedByServer', (track) => this.emit('localTrackMutedByServer', track));
    this.adapter.on('activeSpeakersChanged', (speakers) => this.emit('activeSpeakersChanged', speakers));
    this.adapter.on('connectionQualityChanged', (participant, quality) =>
      this.emit('connectionQualityChanged', participant, quality),
    );
    this.adapter.on('e2eeStateChanged', (participant, state) => this.emit('e2eeStateChanged', participant, state));
    this.adapter.on('transcriptionSegment', (segment) => this.emit('transcriptionSegment', segment));
    this.adapter.on('transcriptionStateChanged', (state) => this.emit('transcriptionStateChanged', state));
    this.adapter.on('agentStateChanged', (participant, state) => this.emit('agentStateChanged', participant, state));
    this.adapter.on('trackSubscriptionStateChanged', (track, participant) =>
      this.emit('trackSubscriptionStateChanged', track, participant),
    );
    this.adapter.on('warning', (warning) => {
      this.logger.warn('rtc warning', warning.code, warning.message);
      this.emit('warning', warning);
    });
    this.adapter.on('mediaError', (error) => {
      this.logger.warn('media device error', error.message);
      const rtcError = new RTCError('MEDIA_ERROR', error.message, error);
      this.telemetry.send('error', { code: rtcError.code, message: rtcError.message });
      this.emit('error', rtcError);
    });
  }

  /**
   * A non-secret diagnostic snapshot for support and debugging.
   *
   * Synchronous and cheap by design, so you can call it from anywhere at
   * any time, error handlers included. Live media stats are a separate
   * `async` call; see `getConnectionStats()`.
   */
  getDiagnostics(): ConnectionDiagnostics {
    const { platform, browser } = detectPlatform();
    const remote = this.adapter.getRemoteConnectionState?.() ?? {};
    return {
      connectionState: this.connectionState,
      iceConnectionState: this.adapter.getIceConnectionState?.(),
      signalingState: this.adapter.getSignalingState?.(),
      remoteIceConnectionState: remote.iceState,
      remotePeerConnectionState: remote.peerState,
      reconnectCount: this.reconnectCount,
      sdkVersion: SDK_VERSION,
      platform,
      browser,
    };
  }

  /**
   * Live media-quality stats for every published and subscribed track.
   * RTT, jitter, packet loss, bitrate, codec, resolution/fps, and the
   * SFU's own connection-quality read. `ConnectionStats` explains why this
   * is kept apart from `getDiagnostics()`.
   *
   * Call it whenever you like, including before anything is published or
   * subscribed. You just get empty `local`/`remote` arrays then, not an
   * error.
   */
  async getConnectionStats(): Promise<ConnectionStats> {
    const localTracks = this.localParticipant.tracks;
    const remoteTracks = this.remoteParticipants.flatMap((participant) => participant.tracks);

    const [local, remote] = await Promise.all([
      Promise.all(localTracks.map((track) => track.getStats())),
      Promise.all(remoteTracks.map((track) => track.getStats())),
    ]);

    return {
      connectionState: this.connectionState,
      connectionQuality: this.adapter.getConnectionQuality(),
      local: local.filter((stats): stats is TrackStats => stats !== undefined),
      remote: remote.filter((stats): stats is TrackStats => stats !== undefined),
    };
  }

  /**
   * Polls `getConnectionStats()` on a timer and ships the result as
   * telemetry, so the dashboard's RTC view (spec §23) has numbers to show
   * without every developer wiring it up by hand. Best-effort, same as
   * every other telemetry event here: failures get swallowed. A hiccup
   * collecting stats is no reason to disturb the call it's describing.
   */
  private startStatsMonitor(): void {
    if (this.statsTimer) {
      return;
    }
    this.statsTimer = setInterval(() => {
      this.getConnectionStats()
        .then((stats) => this.telemetry.send('stats', stats as unknown as Record<string, unknown>))
        .catch(() => {
          // Silent on purpose. See the method doc.
        });
    }, Room.STATS_INTERVAL_MS);
  }

  private stopStatsMonitor(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = undefined;
    }
  }

  /** Captures and publishes the camera in one go. Resolves to the published track. */
  /**
   * Whether a kind you publish is genuinely sending a simulcast ladder.
   *
   * Read back from the negotiated sender, not from what was requested. A
   * browser that refuses the ladder publishes one full-quality layer and
   * reports `'unsupported'` here, having already logged a warning —
   * subscribers then cannot drop to a cheaper layer, which is what makes a
   * large call expensive for everyone in it.
   */
  simulcastStatus(kind: TrackKind): SimulcastStatus {
    return this.adapter.simulcastStatus?.(kind) ?? 'notApplicable';
  }

  async enableCamera(): Promise<LocalTrack | undefined> {
    return this.adapter.enableCamera(true);
  }

  /** Stops publishing and releases the camera. */
  async disableCamera(): Promise<void> {
    await this.adapter.enableCamera(false);
  }

  /** Captures and publishes the microphone in one call. Resolves to the published track. */
  async enableMicrophone(): Promise<LocalTrack | undefined> {
    return this.adapter.enableMicrophone(true);
  }

  /** Stops publishing and releases the microphone. */
  async disableMicrophone(): Promise<void> {
    await this.adapter.enableMicrophone(false);
  }

  /**
   * Captures and publishes a screen share in one call. With
   * `{ audio: true }` the shared tab's or system's audio is published too,
   * as a `screenShareAudio` track, where the browser offers it (Chrome:
   * a tab, or the screen on Windows/ChromeOS). Resolves to the video track;
   * the audio one shows up in `localParticipant.tracks`. Disabling the
   * share, or the browser's own "Stop sharing", unpublishes both.
   */
  async enableScreenShare(options?: ScreenShareOptions): Promise<LocalTrack | undefined> {
    return options ? this.adapter.enableScreenShare(true, options) : this.adapter.enableScreenShare(true);
  }

  async disableScreenShare(): Promise<void> {
    await this.adapter.enableScreenShare(false);
  }

  /**
   * Two events get special treatment here.
   *
   * **`dataReceived`** is what provisions this participant's data channel.
   * The SFU fans data out over each recipient's own channel, and a channel
   * is only created on demand — most calls never send a byte, and an SCTP
   * association for every participant regardless is a cost with nothing
   * behind it. So a page that never called `sendData()` could not
   * *receive* either, which made data one-way in exactly the setup people
   * try first. Subscribing to the event is the signal that one is wanted.
   *
   * **`trackSubscribed`** is replayed for tracks that were already
   * subscribed when the handler was added.
   *
   * Without that, joining a room where somebody is *already* publishing
   * never tells you about them. `client.join()` subscribes to the existing
   * publishers and emits during `connect()`, which is before the promise
   * resolves — so by the time a caller has a `Room` to call `.on()` on,
   * the events are gone. Media arrives and decodes; the application simply
   * never hears about it and renders nothing. That is the normal case for
   * a live stream, where every viewer joins a broadcast already in
   * progress, and the shape the documented example uses:
   *
   * ```ts
   * const room = await client.join(name);           // subscribes here
   * room.on('trackSubscribed', (t) => …);           // …handler added here
   * ```
   *
   * Only tracks a handler demonstrably missed are replayed — the ones
   * subscribed before it was added — so a handler registered up front
   * still sees each track exactly once, and adding a second handler later
   * cannot double-deliver to the first. Delivery is deferred to a
   * microtask so `.on()` stays a plain registration call and never
   * re-enters the caller before it has returned. `Promise.resolve()`
   * rather than `queueMicrotask`, so this holds on every engine the SDK
   * ships to, React Native's included.
   */
  on<E extends keyof RoomEventMap>(event: E, handler: RoomEventMap[E]): this {
    if (event === 'dataReceived') {
      this.adapter.ensureDataChannel?.();
    }

    if (event === 'trackSubscribed') {
      const missed = this.remoteParticipants.flatMap((participant) =>
        participant.tracks.map((track) => ({ track, participant })),
      );
      if (missed.length > 0) {
        const subscribed = handler as RoomEventMap['trackSubscribed'];
        void Promise.resolve().then(() => {
          for (const { track, participant } of missed) {
            subscribed(track, participant);
          }
        });
      }
    }

    return super.on(event, handler);
  }

  /**
   * Publishes a track you made with `client.createCameraTrack()` and
   * friends, or one you wrapped with `client.createCustomTrack()`.
   */
  async publish(track: LocalTrack): Promise<void> {
    await this.adapter.publish(track);
  }

  async unpublish(track: LocalTrack): Promise<void> {
    await this.adapter.unpublish(track);
  }

  /** Switches the active camera without republishing. */
  async setCameraDevice(deviceId: string): Promise<void> {
    await this.adapter.setDevice('videoinput', deviceId);
  }

  /** Switches the active microphone without republishing. */
  async setMicrophoneDevice(deviceId: string): Promise<void> {
    await this.adapter.setDevice('audioinput', deviceId);
  }

  /**
   * Switches the audio output ("speaker") device for this room's remote
   * audio elements. Phase 11 addition. Not supported everywhere: Safari
   * has no `HTMLMediaElement.setSinkId`. Browsers that don't implement it
   * get a `DEVICE_NOT_FOUND` throw instead of a silent no-op.
   */
  async setSpeakerDevice(deviceId: string): Promise<void> {
    if (typeof document !== 'undefined') {
      const probe = document.createElement('audio') as HTMLAudioElement & { setSinkId?: unknown };
      if (typeof probe.setSinkId !== 'function') {
        throw new RTCError(
          'DEVICE_NOT_FOUND',
          "This browser doesn't support selecting an audio output device (no setSinkId)",
        );
      }
    }
    await this.adapter.setDevice('audiooutput', deviceId);
  }

  /**
   * Sends a small payload to everyone, or with `destinationIdentities` to
   * just those people. Requires the token's `publishData` grant; throws
   * PERMISSION_DENIED without it.
   *
   * Options (phase7-contracts §1.6): `topic` (≤255 bytes) labels the
   * message for recipients; `reliable: false` uses the lossy channel
   * (≤1,200 bytes, may drop, lowest latency). Without options this sends
   * exactly what it always has. Invalid options, and a payload over the
   * size limit (64 KiB reliable, 1,200 bytes lossy), throw INVALID_ARGUMENT.
   * Data messages are not end-to-end encrypted, even in an E2EE room.
   *
   * Works in an empty room with nothing published. The first call has to
   * negotiate a data channel — one round trip — which this awaits on your
   * behalf; payloads sent while the channel is still opening are queued
   * and go out in order. Rejects with CONNECTION_FAILED if the connection
   * dies before the channel can open, rather than hanging.
   */
  async sendData(payload: string | Uint8Array, options?: DataSendOptions): Promise<void> {
    // Rewrap as a plain ArrayBuffer-backed Uint8Array, so callers never
    // have to think about ArrayBuffer vs SharedArrayBuffer generics.
    const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : new Uint8Array(payload);
    if (options) {
      await this.adapter.sendData(bytes, options);
    } else {
      await this.adapter.sendData(bytes);
    }
  }

  /**
   * Resolves once the media connection is genuinely up.
   *
   * # Why this exists
   *
   * `client.join()` resolves when the **control plane** lets you in: room
   * joined, you know who else is here, you can publish. The media
   * connection finishes a moment later, once ICE and DTLS are done, which
   * means `connectionState` sits at `'connecting'` for a short window
   * after `join()` returns. That's the honest shape of an SFU connection,
   * and it's why `'connected'` is an event, not something joining
   * guarantees you.
   *
   * Most callers need none of this. `enableCamera()` and
   * `enableMicrophone()` work fine inside that window, and the `connected`
   * event is what you want driving a UI. This is for code that genuinely
   * has to block: a test, or a flow that mustn't move on until media is
   * live.
   *
   * Resolves straight away if already connected. Rejects on `'failed'` and
   * on timeout, rather than handing back a connection that isn't there.
   *
   * Careful: a subscriber joining a room where nobody is publishing can
   * quite legitimately stay `'connecting'`. With no tracks on either side
   * there's nothing to negotiate, so waiting here times out on a
   * connection that isn't broken at all. Where you can, drive the UI off
   * the `connected` event instead of blocking on this.
   */
  waitUntilConnected(timeoutMs = 15_000): Promise<void> {
    if (this.connectionState === 'connected') {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        this.off('connectionStateChanged', onState);
        fn();
      };

      const onState = (state: ConnectionState) => {
        if (state === 'connected') {
          settle(resolve);
        } else if (state === 'failed') {
          settle(() => reject(new RTCError('CONNECTION_FAILED', 'The connection failed while waiting for it')));
        }
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new RTCError(
              'CONNECTION_FAILED',
              `Still ${this.connectionState} after ${timeoutMs}ms; the media connection did not establish`,
            ),
          ),
        );
      }, timeoutMs);

      this.on('connectionStateChanged', onState);
    });
  }

  /** Leaves the room, stops local tracks and closes the underlying connection. */
  async leave(): Promise<void> {
    this.stopStatsMonitor();
    await this.adapter.disconnect();
  }
}
