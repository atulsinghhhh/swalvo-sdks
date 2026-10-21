import { RTCError } from '../../errors';
import { TypedEventEmitter } from '../../events';
import type { Logger } from '../../logger';
import { LocalParticipant, RemoteParticipant, type Participant } from '../../participant';
import {
  parseAgentState,
  parseTranscriptionSegment,
  parseTranscriptionState,
  type AgentState,
} from '../../transcription';
import {
  LocalTrack,
  RemoteTrack,
  trackKindToMediaKind,
  type ForwardedLayer,
  type TrackKind,
  type TrackSubscriptionState,
} from '../../track';
import { createCameraTrack, createMicrophoneTrack, createScreenShareTracks } from '../media/capture';
import {
  DataEnvelopeError,
  MAX_LOSSY_PAYLOAD_BYTES,
  MAX_RELIABLE_PAYLOAD_BYTES,
  decodeDataMessage,
  encodeDataEnvelope,
} from '../data-envelope';
import { NativeLocalTrackDelegate, NativeRemoteTrackDelegate } from '../media/native-track';
import { AdaptiveStreamController, type VideoLayer } from '../media/adaptive-stream';
import {
  SIMULCAST_LAYERS,
  confirmSimulcast,
  kindUsesSimulcast,
  simulcastSendEncodings,
  type SimulcastStatus,
} from './simulcast';
import { listDevices } from '../devices/enumerate';
import {
  redFirstAudioCodecs,
  svcSendEncodings,
  svcSupported,
  videoCodecsPreferring,
  type VideoCodecName,
} from './codecs';
import { isE2EESupported } from '../../e2ee/support';
import type { E2EEController, E2EEControllerFactory, E2EEOptions, E2EEState } from '../../e2ee/types';
import { connectionRoundTripTimeMs } from '../telemetry/rtc-stats';
import {
  ClientMessageType,
  ServerMessageType,
  type ServerMessage,
  type ServerPermissions,
  type ServerTrack,
  type SubscriptionLayer,
} from '../signaling/protocol';
import { SignalingClient, type JoinedPayload } from '../signaling/signaling-client';
import type {
  ConnectionQuality,
  DataChannelKind,
  DataSendOptions,
  DeviceInfo,
  DeviceKind,
  DisconnectReason,
  ParticipantPermissions,
  ScreenShareOptions,
  SFUAdapter,
  SFUAdapterEventMap,
  SdkConnectionState,
} from './types';

/**
 * Data channel label. Has to match the SFU's `dataChannelLabel`. A channel
 * the node doesn't recognise gets closed, not quietly ignored.
 */
const DATA_CHANNEL_LABEL = 'raven-data';

/**
 * The unordered, no-retransmit channel (phase7-contracts §1.1). Only
 * opened against a server that announced `data.v2`; an older SFU closes
 * a channel it does not recognise.
 */
const LOSSY_DATA_CHANNEL_LABEL = 'raven-data-lossy';

/** Lossy payloads parked while the lossy channel opens. Oldest dropped first: latest wins. */
const MAX_LOSSY_QUEUE = 64;

/**
 * RTCDataChannel `protocol` on both channels: tells the SFU this client
 * reads the 0x52 0x03 delivery framing (phase7-contracts §1.3). Set even
 * against an older SFU, which ignores it.
 */
const DATA_V2_PROTOCOL = 'raven.v2';

/** The `room.joined.capabilities` entry that turns on data messages v2. */
const DATA_V2_CAPABILITY = 'data.v2';

/**
 * Payload ceiling for `room.sendData()` (spec §18).
 *
 * SCTP happily fragments bigger messages, but a browser's send buffer is
 * finite, and anyone pushing megabytes down a data channel will stall
 * their own media. The channel shares the transport. 64 KiB is plenty for
 * what this is actually for (reactions, cursor positions, chat) and small
 * enough to fail loudly instead of quietly wrecking a call.
 */
const MAX_DATA_PAYLOAD_BYTES = MAX_RELIABLE_PAYLOAD_BYTES;

/**
 * How many times a failed media connection is rebuilt, with signaling still
 * up, before the room is reported `failed`. The count resets every time
 * the media connection reaches `connected`, so this bounds a connection
 * that can never come up (a network that blocks every candidate), not a
 * long call that fails now and then.
 */
const MEDIA_REJOIN_MAX_ATTEMPTS = 5;
const MEDIA_REJOIN_BASE_MS = 1_000;
const MEDIA_REJOIN_MAX_MS = 10_000;

/** Server source string → the SDK's own track kinds. */
function trackKindFromSource(source: string, kind: 'audio' | 'video'): TrackKind {
  switch (source) {
    case 'camera':
      return 'camera';
    case 'microphone':
      return 'microphone';
    case 'screenShare':
      return 'screenShare';
    case 'screenShareAudio':
      return 'screenShareAudio';
    default:
      return kind === 'audio' ? 'microphone' : 'camera';
  }
}

/** Options the client hands the adapter (see `RTCClientConfig`). */
export interface AdapterOptions {
  adaptiveStream: boolean;
  preferredVideoCodec?: 'h264' | 'vp8' | 'vp9' | 'av1';
  /** See `RTCClientConfig.refreshToken`. */
  refreshToken?: () => Promise<string>;
  /** See `RTCClientConfig.autoSubscribe`. Defaults to true. */
  autoSubscribe?: boolean;
  /** See `RTCClientConfig.audioRed`. Defaults to true. */
  audioRed?: boolean;
  /** See `RTCClientConfig.e2ee`. */
  e2ee?: E2EEOptions;
}

interface SubscribedTrack {
  track: RemoteTrack;
  delegate: NativeRemoteTrackDelegate;
  participantId: string;
  trackId: string;
  /** The layer adaptive streaming last chose from element size, pinned or not. */
  adaptiveLayer?: Exclude<VideoLayer, 'auto'>;
  /** Adaptive streaming says nothing on screen shows this track. */
  hidden: boolean;
}

/** SFU quality names this SDK accepts; anything else is ignored rather than trusted. */
const SERVER_QUALITIES: ReadonlySet<string> = new Set(['excellent', 'good', 'poor', 'lost']);
const SUBSCRIPTION_STATES: ReadonlySet<string> = new Set(['active', 'paused_bandwidth', 'paused_client']);
const FORWARDED_LAYERS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'off']);

/**
 * RID spellings that mean the same rung. The web SDK negotiates
 * `low`/`medium`/`high` (see `SIMULCAST_LAYERS`); the contract's examples
 * use `q`/`h`/`f`, which is what other WebRTC stacks commonly send. A
 * `publisher.layers` frame is matched against the sender's own RIDs under
 * either spelling, so neither side's naming can silently disable dynacast.
 */
const RID_ALIASES: Record<string, string> = { q: 'low', h: 'medium', f: 'high', low: 'q', medium: 'h', high: 'f' };

/**
 * Swalvo's native `SFUAdapter`: an `RTCPeerConnection` driven by Swalvo's own
 * signaling.
 *
 * This replaced the LiveKit adapter. `Room` and `RTCClient` were already
 * written against `SFUAdapter` and never imported livekit-client, so the
 * public API (`createRTCClient`, `room.enableCamera()`, the event names)
 * came through the swap untouched. Which is exactly why that boundary was
 * there in the first place.
 *
 * # Negotiation
 *
 * Both peers offer on one PeerConnection: the SFU offers at join and for
 * every subscription, and this adapter offers when a local track needs an
 * m-section that does not exist yet (the first publish of each kind).
 *
 * Every operation that touches the signaling state machine therefore goes
 * through one chain — `enqueue()` — and nothing else is allowed near
 * `setLocalDescription` / `setRemoteDescription`. Checking
 * `signalingState` and *then* awaiting `createOffer()` is not enough and
 * was the bug this replaced: the check passes, the await yields, the SFU's
 * offer lands in that gap, and `setLocalDescription` throws "Called in
 * wrong state: have-remote-offer". The track keeps its sender, the
 * m-section stays `recvonly`, and the room sees no media while the SDK
 * reports a successful publish.
 *
 * Local changes never offer directly. Adding a track or creating a data
 * channel sets the browser's own negotiation-needed bit; its
 * `negotiationneeded` event queues one offer task, and however many
 * changes are pending collapse into that single offer — or into none, if a
 * round is already in flight, in which case the end of that round looks
 * again. So publishing a microphone and a camera back to back never races,
 * and no timers are involved anywhere.
 *
 * The browser's bit is the source of truth on purpose. It clears when some
 * description covers the change — including one the *SFU* offered — which
 * an SDK-side "something changed" flag cannot know. An earlier version of
 * this kept its own flag and re-offered until answered; against a real SFU
 * that produced 48 rounds of offer/rollback on a single join, until the
 * connection's message rate limit tripped.
 *
 * Glare — both sides offering at once — resolves politely: the SFU's offer
 * wins, ours rolls back and is re-queued. The SFU independently refuses a
 * client offer mid-round with a retryable `NEGOTIATION_GLARE`, which lands
 * in the same re-queue.
 *
 * # Track identity
 *
 * A subscribed track is identified by `(publisherId, trackId)`, pulled off
 * the SFU's `track.published` event and matched against the `MediaStream`
 * id and track id the SFU stamps on the forwarded track. `ontrack` on its
 * own won't do: it fires with a track whose id only means anything next to
 * what signaling already told us.
 */
export class SwalvoAdapter extends TypedEventEmitter<SFUAdapterEventMap> implements SFUAdapter {
  readonly localParticipant: LocalParticipant;
  readonly remoteParticipants = new Map<string, RemoteParticipant>();
  /**
   * Phase 6 §4.2: an `agent.state` for an agent whose `participant.joined`
   * has not arrived yet (the worker reports `listening` as it connects).
   * Applied the moment the participant appears.
   */
  private pendingAgentStates = new Map<string, AgentState>();

  private readonly logger: Logger;
  private readonly autoReconnect: boolean;

  private pc?: RTCPeerConnection;
  private signaling?: SignalingClient;
  private dataChannel?: RTCDataChannel;
  /** `raven-data-lossy`, when opened (phase7-contracts §1.1). */
  private lossyChannel?: RTCDataChannel;
  /** Desired state like `dataChannelWanted`: re-opened on a new connection. */
  private lossyChannelWanted = false;
  private lossyQueue: Uint8Array[] = [];
  /** `room.joined.capabilities` includes `data.v2`. Refreshed on every join. */
  private supportsDataV2 = false;
  private lossyFallbackWarned = false;
  private iceServers: RTCIceServer[] = [];

  private _connectionState: SdkConnectionState = 'disconnected';
  private intentionalDisconnect = false;

  /** See `SFUAdapter.lastDisconnect`. */
  private _lastDisconnect?: { reason: DisconnectReason; error?: RTCError };

  /** What the server last said this participant may do. See `permissions`. */
  private _permissions?: ParticipantPermissions;

  /**
   * The signaling socket dropped and the reconnect will offer a resume
   * token, so the PeerConnection was kept: if the server re-binds the old
   * SFU session it is still carrying our media. Settled by the next
   * `joined`, which either confirms it (`resumed: true`) or says the
   * session is new and the connection must be rebuilt.
   */
  private awaitingResume = false;

  /** Media-only rejoins since the media connection was last `connected`. */
  private mediaRejoinAttempts = 0;
  private mediaRejoinTimer?: ReturnType<typeof setTimeout>;

  /** The next offer we make should restart ICE (a network change). */
  private iceRestartRequested = false;

  /**
   * What this participant *wants* published, by kind.
   *
   * Desired state, deliberately not PeerConnection state. A reconnect
   * throws the PeerConnection away and with it every `RTCRtpSender`, but
   * the camera is still on and the developer never asked for it to stop —
   * so `sender` is the only field here that a replacement connection
   * invalidates, and `restoreLocalPublications()` refills it. Before this
   * split, a reconnect left the map holding senders belonging to a closed
   * connection: the tracks looked published, the new connection had no
   * transceivers for them, and the room went quiet.
   */
  private readonly published = new Map<
    TrackKind,
    {
      track: LocalTrack;
      delegate: NativeLocalTrackDelegate;
      sender?: RTCRtpSender;
      trackId: string;
      /** Whether the ladder genuinely survived negotiation. */
      simulcast: SimulcastStatus;
    }
  >();

  /** Subscribed tracks by `publisherId/trackId`. */
  private readonly subscribed = new Map<string, SubscribedTrack>();

  /**
   * Layers an application pinned explicitly, by `publisherId/trackId`.
   * Adaptive streaming never overrides one. See {@link requestLayer}.
   */
  private readonly pinnedLayers = new Map<string, VideoLayer>();

  /**
   * The layer last *sent* for a subscription, keyed the same way. Purely to
   * avoid re-sending a preference the SFU already has.
   */
  private readonly sentLayers = new Map<string, SubscriptionLayer>();

  /** Per-track size observers, by `publisherId/trackId`. */
  private readonly adaptiveControllers = new Map<string, AdaptiveStreamController>();

  /**
   * Transceivers this SDK created for a simulcast kind.
   *
   * Deliberately not on the publication: a publication is deleted by
   * `unpublish`, and the transceiver has to outlive that. A ladder can only
   * be declared when a transceiver is created, so a camera toggled off and
   * on again cannot go back through `addTransceiver` without adding an
   * m-section that never goes away — a call where somebody fiddles with
   * their camera would carry an SDP to match.
   *
   * Cleared with the peer connection: a transceiver belongs to the
   * connection that created it, and a reconnect builds a new one.
   */
  private readonly simulcastTransceivers = new Map<TrackKind, RTCRtpTransceiver>();

  /**
   * What the server says each participant publishes, ahead of the media
   * actually turning up. `ontrack` and `track.published` race and either
   * can win, so both paths check in here and whichever lands second
   * finishes the subscription.
   */
  private readonly announcedTracks = new Map<string, { participantId: string; track: ServerTrack }>();

  /** Tracks whose media arrived before the announcement. */
  private readonly pendingMedia = new Map<
    string,
    { stream: MediaStream; track: MediaStreamTrack; receiver: RTCRtpReceiver }
  >();

  /** Last ICE/peer state the SFU told us about. Diagnostics only. */
  private sfuIceState?: string;
  private sfuPeerState?: string;

  /**
   * Serializes everything that touches the signaling state machine —
   * remote offers, remote answers, our own offers, remote candidates.
   * See `enqueue()`.
   */
  private negotiationChain: Promise<void> = Promise.resolve();

  /** A local change is waiting for an offer to carry it. */
  private negotiationNeeded = false;

  /** An offer task is already on the chain, so more requests coalesce into it. */
  private negotiationScheduled = false;

  /** Callers of `dataChannelOpened()`, settled when the channel opens. */
  private dataChannelWaiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];

  /** In-flight enable/disable per track kind. See `withKindLock()`. */
  private readonly kindOperations = new Map<TrackKind, Promise<void>>();

  /**
   * Whether this page has asked for a data channel.
   *
   * Desired state, like `published`: the channel itself belongs to a
   * PeerConnection and does not survive a reconnect, but the intent does.
   */
  private dataChannelWanted = false;

  /** Payloads accepted while the channel was still opening. */
  private dataQueue: Uint8Array[] = [];

  /**
   * Track ids we have already offered once to get onto the wire.
   *
   * `publishedTracksMissingFromSdp()` asks for one corrective offer per
   * published track and then stops asking, whatever the outcome. A
   * standing condition instead of a one-shot is a treadmill: if the
   * browser will not put our id in the description — a reused transceiver
   * whose msid it considers settled — then re-checking after every round
   * trip re-offers forever. Bounding it costs a mislabelled track source
   * in that corner; not bounding it costs the connection.
   */
  private readonly msidRefreshAttempted = new Set<string>();

  constructor(logger: Logger, autoReconnect: boolean, options?: AdapterOptions) {
    super();
    this.logger = logger;
    this.autoReconnect = autoReconnect;
    // Defaulted here rather than made required, so a caller constructing an
    // adapter directly (tests, embedders) gets the same behaviour as one
    // going through RTCClient.
    this.adaptiveStream = options?.adaptiveStream ?? true;
    this.preferredVideoCodec = options?.preferredVideoCodec;
    this.refreshToken = options?.refreshToken;
    this.autoSubscribe = options?.autoSubscribe ?? true;
    this.audioRed = options?.audioRed ?? true;
    this.e2eeOptions = options?.e2ee;
    this.localParticipant = new LocalParticipant('');
    this.localParticipant._setUpdater({
      canUpdateMetadata: () => this._permissions?.updateOwnMetadata === true,
      sendUpdate: (update) => {
        if (!this.signaling) {
          throw new RTCError('CONNECTION_FAILED', 'Not connected to a room');
        }
        this.signaling.send({ type: ClientMessageType.PARTICIPANT_UPDATE, ...update });
      },
    });
  }

  /** Whether the server announced data messages v2 (`room.joined.capabilities`). */
  get dataV2Supported(): boolean {
    return this.supportsDataV2;
  }

  private readonly refreshToken?: () => Promise<string>;

  /** See `RTCClientConfig.autoSubscribe`. */
  private readonly autoSubscribe: boolean;

  /** See `RTCClientConfig.audioRed`. */
  private readonly audioRed: boolean;

  /** See `RTCClientConfig.e2ee`. */
  private readonly e2eeOptions?: E2EEOptions;

  /** This connection's E2EE worker and transforms; only when a key provider was configured and the browser can encrypt. */
  private e2ee?: E2EEController;

  /** The room requires E2EE: the token's `e2ee` claim or `room.joined.e2ee` (phase5-contracts §3.1). */
  private roomE2EE = false;

  /**
   * The id the shared passphrase is salted with: the token's `rid`, which is
   * also the `roomId` every SDK sends in `room.join` — so web, Flutter and
   * the native SDKs derive the same key for the same room.
   */
  private e2eeRoomId = '';

  /** Last reported E2EE state per participant, so `e2eeStateChanged` fires on changes only. */
  private readonly e2eeStates = new Map<string, E2EEState>();

  /** Current active speakers, loudest first (§2). */
  private _activeSpeakers: Participant[] = [];

  /**
   * Subscription states that arrived before their track did (§4). The SFU
   * can report a subscription as paused before `ontrack` has fired here;
   * dropping that report would leave the track claiming `active` until the
   * next change, which may never come.
   */
  private readonly pendingSubscriptionStates = new Map<
    string,
    { state: TrackSubscriptionState; layer?: ForwardedLayer }
  >();

  /**
   * Subscriptions the application paused with `track.setEnabled(false)`,
   * by `publisherId/trackId`. Application intent, like `pinnedLayers`, so
   * it survives a reconnect that rebuilds the track objects.
   */
  private readonly disabledTracks = new Set<string>();

  /**
   * What `publisher.layers` (§5) last asked of each published track's
   * encodings, by RID, keyed by publication kind. Re-applied after every
   * negotiation round, because some engines reset encoding parameters
   * when a description is applied; cleared whenever a publication gets a
   * new sender, since the SFU session behind it re-announces its demand.
   */
  private readonly layerActivity = new Map<TrackKind, Map<string, boolean>>();

  /** Serializes `setParameters` per sender: a read-modify-write that must not interleave. */
  private readonly senderParameterChains = new WeakMap<RTCRtpSender, Promise<void>>();

  /** Whether subscriptions follow the size their element is rendered at. */
  private readonly adaptiveStream: boolean;
  private readonly preferredVideoCodec: AdapterOptions['preferredVideoCodec'];

  get connectionState(): SdkConnectionState {
    return this._connectionState;
  }

  get lastDisconnect(): { reason: DisconnectReason; error?: RTCError } | undefined {
    return this._lastDisconnect;
  }

  /**
   * This participant's permissions: the token's grants at first, then
   * whatever the server last pushed (§1.4). Undefined when the token
   * carries no grants to read.
   */
  get permissions(): ParticipantPermissions | undefined {
    return this._permissions ? { ...this._permissions } : undefined;
  }

  /**
   * The SFU's read on this connection's health.
   *
   * `'lost'` once the connection has failed, either side's view. Otherwise
   * the score the SFU last sent for this participant
   * (docs/architecture/phase2-media-contracts.md §3), which has a vantage
   * point no client can get near: it sees loss and jitter on every leg of
   * the room, not just this one. Before the first score, and against a
   * server that does not score at all, it is `'unknown'` — dressing a
   * client-side guess up as a server verdict is precisely the fabricated
   * metric spec §19 rules out. `room.getConnectionStats()` gives real
   * per-track numbers either way.
   */
  getConnectionQuality(): ConnectionQuality {
    if (this.sfuPeerState === 'failed' || this._connectionState === 'failed') {
      return 'lost';
    }
    // The SFU's own score for us (§3), once it has sent one. `'unknown'`
    // against a server that does not score, which is still the honest
    // answer: a client-side guess is not a server verdict.
    return this.localParticipant.connectionQuality;
  }

  /** Current active speakers, loudest first. Empty when nobody is speaking. */
  get activeSpeakers(): Participant[] {
    return [...this._activeSpeakers];
  }

  /**
   * The media connection's raw stats report, for the pre-call test.
   * Undefined with no connection. Not on `SFUAdapter`: nothing public
   * should depend on a raw WebRTC report.
   */
  async getStatsReport(): Promise<RTCStatsReport | undefined> {
    return this.pc ? this.pc.getStats() : undefined;
  }

  /** Diagnostics the LiveKit adapter never could give us (see `Room.getDiagnostics()`). */
  getIceConnectionState(): string | undefined {
    return this.pc?.iceConnectionState;
  }

  getSignalingState(): string | undefined {
    return this.pc?.signalingState;
  }

  /** The SFU's own view. It can disagree with the local one, and that disagreement is usually the interesting bit. */
  getRemoteConnectionState(): { iceState?: string; peerState?: string } {
    return { iceState: this.sfuIceState, peerState: this.sfuPeerState };
  }

  async getConnectionRoundTripTimeMs(): Promise<number | undefined> {
    return this.pc ? connectionRoundTripTimeMs(this.pc) : undefined;
  }

  // --- Connection --------------------------------------------------------

  async connect(endpoint: string, token: string, iceServers?: RTCIceServer[]): Promise<void> {
    this.iceServers = iceServers ?? [];
    this.intentionalDisconnect = false;
    this._lastDisconnect = undefined;
    this.mediaRejoinAttempts = 0;
    this.setConnectionState('connecting');

    const roomId = roomIdFromToken(token);
    // Before the join, not after it: `joined` is handled synchronously
    // inside `signaling.connect()`, and anything it emits should already
    // carry who we are.
    this.localParticipant._setIdentity(participantIdFromToken(token));
    this._permissions = permissionsFromToken(token);
    const claims = decodeClaims(token);
    this.localParticipant._applyMetadata({
      metadata: typeof claims?.md === 'string' ? claims.md : undefined,
      attributes:
        claims?.attrs && typeof claims.attrs === 'object' ? (claims.attrs as Record<string, string>) : undefined,
    });
    this.roomE2EE = claims?.e2ee === true;
    this.e2eeRoomId = roomId;
    this.setupE2EE();

    const signaling = new SignalingClient({
      endpoint,
      token,
      roomId,
      autoReconnect: this.autoReconnect,
      logger: this.logger,
      refreshToken: this.refreshToken,
      autoSubscribe: this.autoSubscribe,
    });
    this.signaling = signaling;

    signaling.on('message', (message) => void this.handleSignalingMessage(message));
    signaling.on('reconnecting', ({ resuming }) => {
      this.setConnectionState('reconnecting');
      if (resuming && this.pc) {
        // The server may re-bind our SFU session, in which case this
        // PeerConnection never stopped carrying media and rebuilding it
        // would be the outage. Kept until `joined` says either way.
        this.awaitingResume = true;
        return;
      }
      // No session to resume, so the server allocates a fresh one on
      // rejoin and this PeerConnection is no use to us. Tear it down now
      // instead of at rejoin time, so anyone inspecting state mid-reconnect
      // doesn't find a connection that looks alive and forwards nothing.
      this.awaitingResume = false;
      this.discardMediaConnection();
    });
    signaling.on('joined', (payload) => void this.handleSignalingJoined(payload));
    signaling.on('failed', (error, reason) => {
      this.logger.error('signaling failed', error.message);
      this._lastDisconnect = { reason, error };
      this.cancelMediaRejoin();
      this.abortDataChannelWaiters('The connection failed before the data channel could open');
      this.setConnectionState('failed');
    });
    signaling.on('ended', (reason) => {
      // The server ended the session on purpose (§1.5). Not a failure, and
      // nothing to reconnect: release the devices, drop the media
      // connection and report why.
      this._lastDisconnect = { reason };
      this.endSession('The session was ended by the server before the data channel could open');
    });
    signaling.on('closed', () => {
      this.abortDataChannelWaiters('The connection closed before the data channel could open');
      this.setConnectionState(this.intentionalDisconnect ? 'disconnected' : 'failed');
    });
    signaling.on('warning', (warning) => this.emit('warning', warning));

    try {
      // The join's room state is applied by the `joined` handler above,
      // which runs before this await returns.
      await signaling.connect();
    } catch (error) {
      this.setConnectionState('failed');
      throw error instanceof RTCError ? error : new RTCError('CONNECTION_FAILED', 'Could not join the room', error);
    }
  }

  /**
   * Every `room.joined` the signaling client completes: the first one, and
   * one after each reconnect.
   *
   * After a reconnect that offered a resume token, this is where the kept
   * PeerConnection's fate is decided. `resumed: true` means the SFU still
   * has the session and the connection is live, so nothing local is
   * rebuilt; anything else means the server started a fresh session, and
   * the old connection is discarded and everything republished onto a new
   * one — the same path a reconnect without resume always takes.
   */
  private async handleSignalingJoined(payload: JoinedPayload): Promise<void> {
    const wasAwaitingResume = this.awaitingResume;
    this.awaitingResume = false;

    if (payload.resumed) {
      this.logger.info('session resumed; keeping the media connection');
      await this.handleJoined(payload, { restorePublications: false });
      // The socket was down, so the connection state never got to say
      // `connected` again on its own if the PeerConnection stayed up.
      if (this.pc?.connectionState === 'connected') {
        this.setConnectionState('connected');
      }
      return;
    }

    if (wasAwaitingResume) {
      this.logger.info('the server started a fresh session; rebuilding the media connection');
      this.discardMediaConnection();
    }
    await this.handleJoined(payload, { restorePublications: true });
  }

  /**
   * Applies whatever room state the server reported at join.
   *
   * Runs on first join and after every reconnect. On a reconnect the
   * server's participant list wins outright and the old one goes in the
   * bin: anyone who left during the outage must not linger, anyone who
   * joined during it must show up.
   */
  private async handleJoined(
    payload: Omit<JoinedPayload, 'resumed'>,
    options: { restorePublications: boolean } = { restorePublications: true },
  ): Promise<void> {
    this.logger.debug(
      'room state at join',
      `${payload.participants.length} participant(s)`,
      payload.rtcServer ? `on ${payload.rtcServer}` : '',
    );

    this.applyRoomE2EE(payload.roomId, payload.e2ee === true);
    if (Array.isArray(payload.capabilities)) {
      this.supportsDataV2 = payload.capabilities.includes(DATA_V2_CAPABILITY);
    }

    // Reconcile, don't append. Leaves for anyone gone, joins for anyone
    // new, everybody else untouched, so a reconnect doesn't make every
    // tile in the UI flash.
    const present = new Set(payload.participants.map((participant) => participant.id));
    for (const [id, participant] of this.remoteParticipants) {
      if (!present.has(id)) {
        this.removeRemoteParticipant(participant);
      }
    }

    // A rejoin is a new SFU session with a new PeerConnection, so
    // everything local has to be put back on it. No-op on a first join
    // (nothing published yet) and idempotent on a re-sent room state.
    // Skipped on a resumed session, whose SFU side still has every track.
    if (options.restorePublications) {
      this.restoreLocalPublications();
    }

    // phase7-contracts §1.1: a v2 client opens both channels at connect,
    // with protocol `raven.v2`, so the SFU frames deliveries for it from
    // the first message on (§1.3 "Legacy recipients"). Without the
    // capability the channels stay lazy, exactly as before.
    //
    // Only when the token grants publishData: opening a channel is an
    // offer, and the API refuses offers from a participant that may neither
    // publish nor publishData (a live-stream viewer, say) with
    // PERMISSION_DENIED, failing the whole connection. The SFU closes such
    // a channel anyway. applyPermissions opens them if the grant arrives later.
    if (this.supportsDataV2 && this.mayOpenDataChannels()) {
      if (!this.dataChannel) {
        this.openDataChannel();
      }
      if (!this.lossyChannel) {
        this.openLossyChannel();
      }
    }

    for (const entry of payload.participants) {
      let participant = this.remoteParticipants.get(entry.id);
      if (!participant) {
        participant = new RemoteParticipant(entry.id, entry.metadata ?? undefined, entry.attributes ?? undefined);
        this.remoteParticipants.set(entry.id, participant);
        this.emit('participantJoined', participant);
        this.applyPendingAgentState(participant);
      } else {
        this.applyParticipantMetadata(participant, entry);
      }
      for (const track of entry.tracks ?? []) {
        this.announceTrack(entry.id, track);
      }
    }
  }

  private async handleSignalingMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case ServerMessageType.ROOM_JOINED:
        // Usually the join handshake eats this, but handle it here too.
        // The server can re-send room state on an established connection,
        // and `handleJoined` reconciles, not appends, so applying it
        // again is harmless and keeps the client's view honest.
        await this.handleJoined({
          roomId: message.roomId,
          participants: message.participants,
          rtcServer: message.rtcServer,
          region: message.region,
          e2ee: message.e2ee,
          capabilities: message.capabilities,
        });
        return;

      case ServerMessageType.SDP_OFFER:
        // Includes the SFU's ICE-restart offers (phase1-contracts §2.6),
        // sent after ICE has been `disconnected` for a few seconds. Those
        // are answered like any other offer, and that is all they need:
        // a restart changes credentials and candidates, not m-sections,
        // so no `ontrack` fires and no subscription changes.
        //
        // Queued, not awaited inline. `handleSignalingMessage` is invoked
        // per socket frame with no ordering guarantee of its own, so two
        // offers arriving together would otherwise interleave their
        // `setRemoteDescription` calls.
        await this.enqueue(() => this.applyRemoteOffer(message.sdp));
        return;

      case ServerMessageType.SDP_ANSWER:
        await this.enqueue(() => this.applyRemoteAnswer(message.sdp));
        return;

      case ServerMessageType.ICE_CANDIDATE:
        // On the chain as well, so a candidate can never be applied
        // between a remote description being set and the answer being
        // built, which is where "unknown mid" rejections come from.
        await this.enqueue(() => this.applyRemoteCandidate(message));
        return;

      case ServerMessageType.PARTICIPANT_JOINED: {
        const existing = this.remoteParticipants.get(message.participant.id);
        if (existing) {
          return;
        }
        const participant = new RemoteParticipant(
          message.participant.id,
          message.participant.metadata ?? undefined,
          message.participant.attributes ?? undefined,
        );
        this.remoteParticipants.set(participant.identity, participant);
        this.emit('participantJoined', participant);
        this.applyPendingAgentState(participant);
        return;
      }

      case ServerMessageType.PARTICIPANT_LEFT: {
        const participant = this.remoteParticipants.get(message.participant.id);
        if (!participant) {
          return;
        }
        this.removeRemoteParticipant(participant);
        return;
      }

      case ServerMessageType.PARTICIPANT_PERMISSIONS_UPDATED:
        this.applyPermissions(message.permissions);
        return;

      case ServerMessageType.PARTICIPANT_UPDATED: {
        const target: Participant | undefined =
          message.participantId === this.localParticipant.identity
            ? this.localParticipant
            : this.remoteParticipants.get(message.participantId);
        if (target) {
          this.applyParticipantMetadata(target, message);
        }
        return;
      }

      case ServerMessageType.DATA_THROTTLED: {
        const channel: DataChannelKind = message.channel === 'lossy' ? 'lossy' : 'reliable';
        this.logger.warn(`data messages throttled by the server (${channel} channel); some were dropped`);
        this.emit('dataThrottled', channel);
        return;
      }

      case ServerMessageType.TRANSCRIPTION_SEGMENT: {
        const segment = parseTranscriptionSegment(message as unknown as Record<string, unknown>);
        if (segment) {
          this.emit('transcriptionSegment', segment);
        }
        return;
      }

      case ServerMessageType.TRANSCRIPTION_STATE: {
        const state = parseTranscriptionState(message as unknown as Record<string, unknown>);
        if (state) {
          this.emit('transcriptionStateChanged', state);
        }
        return;
      }

      case ServerMessageType.AGENT_STATE:
        this.applyAgentState(message.participantId, message.state);
        return;

      case ServerMessageType.TRACK_PUBLISHED:
        this.announceTrack(message.participantId, message.track);
        return;

      case ServerMessageType.TRACK_UNPUBLISHED: {
        const key = subscriptionKey(message.participantId, message.trackId);
        this.announcedTracks.delete(key);
        this.pendingMedia.delete(key);
        this.pendingSubscriptionStates.delete(key);
        const subscription = this.subscribed.get(key);
        const participant = this.remoteParticipants.get(message.participantId);
        if (subscription && participant) {
          this.subscribed.delete(key);
          this.emit('trackUnpublished', subscription.track.kind, participant);
          this.emit('trackUnsubscribed', subscription.track, participant);
        }
        return;
      }

      case ServerMessageType.TRACK_MUTED:
      case ServerMessageType.TRACK_UNMUTED: {
        const muted = message.type === ServerMessageType.TRACK_MUTED;
        if (
          muted &&
          'byServer' in message &&
          message.byServer === true &&
          message.participantId === this.localParticipant.identity
        ) {
          await this.applyServerMute(message.trackId);
          return;
        }
        const key = subscriptionKey(message.participantId, message.trackId);
        const subscription = this.subscribed.get(key);
        const participant = this.remoteParticipants.get(message.participantId);
        if (!subscription || !participant) {
          return;
        }
        // The publisher's mute, not the browser's "nothing arriving" flag.
        // See NativeRemoteTrackDelegate.
        subscription.delegate.setPublisherMuted(muted);
        this.emit(muted ? 'trackMuted' : 'trackUnmuted', subscription.track.kind, participant);
        return;
      }

      case ServerMessageType.CONNECTION_STATE:
        this.sfuIceState = message.iceState;
        this.sfuPeerState = message.peerState;
        this.logger.debug('sfu connection state', message.iceState, message.peerState);
        return;

      case ServerMessageType.SPEAKERS_CHANGED:
        this.applySpeakers(message.speakers);
        return;

      case ServerMessageType.QUALITY_CHANGED:
        this.applyQualityUpdates(message.updates);
        return;

      case ServerMessageType.SUBSCRIPTION_STATE:
        this.applySubscriptionState(message);
        return;

      case ServerMessageType.PUBLISHER_LAYERS:
        this.applyPublisherLayers(message.trackId, message.layers);
        return;

      case ServerMessageType.ERROR:
        // The signaling client handles fatal codes by closing. Whatever
        // reaches here is retryable, glare most of all, which the publish
        // path deals with.
        if (message.code === 'NEGOTIATION_GLARE') {
          // The SFU was mid-round and refused our offer. Nothing to do here:
          // its own offer is already on the way, applying it rolls ours
          // back, and the browser re-raises negotiationneeded if anything is
          // still unresolved once that lands. The old code logged this and
          // dropped the publish instead, leaving a sender with no m-section
          // to send on.
          this.logger.debug('sfu refused our offer as glare; waiting for its offer');
          return;
        }
        this.emit('mediaError', new Error(message.message));
        return;

      default:
        return;
    }
  }

  /** Phase 7 §2: applies metadata/attributes and emits `participantMetadataChanged` when they changed. */
  private applyParticipantMetadata(
    participant: Participant,
    update: { metadata?: string | null; attributes?: Record<string, string> | null },
  ): void {
    const prev = participant._applyMetadata({ metadata: update.metadata, attributes: update.attributes });
    if (prev) {
      this.emit('participantMetadataChanged', participant, prev);
    }
  }

  // --- Phase 2: speakers, quality, subscription state ---------------------

  /** Any participant in the room by identity, this one included. */
  private participantById(id: string): Participant | undefined {
    if (id && id === this.localParticipant.identity) {
      return this.localParticipant;
    }
    return this.remoteParticipants.get(id);
  }

  /**
   * Applies the SFU's speaker set (§2). The list is the whole truth each
   * time: anyone missing from it has stopped speaking. Ids this client
   * does not know yet (a join still in flight) are skipped rather than
   * invented; the next update will include them if they are still talking.
   */
  private applySpeakers(raw: unknown): void {
    const entries = Array.isArray(raw) ? raw : [];
    const next: Participant[] = [];
    const levels = new Map<Participant, number>();
    for (const entry of entries) {
      const id = (entry as { participantId?: unknown })?.participantId;
      const level = Number((entry as { level?: unknown })?.level);
      if (typeof id !== 'string') continue;
      const participant = this.participantById(id);
      if (!participant || levels.has(participant)) continue;
      levels.set(participant, Number.isFinite(level) ? level : 0);
      next.push(participant);
    }

    const previous = this._activeSpeakers;
    for (const participant of previous) {
      if (!levels.has(participant)) participant._setSpeaking(false, 0);
    }
    for (const participant of next) {
      participant._setSpeaking(true, levels.get(participant) ?? 0);
    }

    this._activeSpeakers = next;
    const same = previous.length === next.length && previous.every((participant, i) => participant === next[i]);
    if (!same) {
      this.emit('activeSpeakersChanged', [...next]);
    }
  }

  /** Applies per-participant connection scores (§3). Unknown names and ids are ignored. */
  private applyQualityUpdates(raw: unknown): void {
    const updates = Array.isArray(raw) ? raw : [];
    for (const update of updates) {
      const id = (update as { participantId?: unknown })?.participantId;
      const quality = (update as { quality?: unknown })?.quality;
      if (typeof id !== 'string' || typeof quality !== 'string' || !SERVER_QUALITIES.has(quality)) continue;
      const participant = this.participantById(id);
      if (participant?._setConnectionQuality(quality as ConnectionQuality)) {
        this.emit('connectionQualityChanged', participant, quality as ConnectionQuality);
      }
    }
  }

  /** Applies a subscription's forwarding state (§4), or parks it until the track exists. */
  private applySubscriptionState(message: {
    publisherId: string;
    trackId: string;
    state: string;
    layer?: string;
  }): void {
    if (typeof message.publisherId !== 'string' || typeof message.trackId !== 'string') return;
    if (!SUBSCRIPTION_STATES.has(message.state)) return;
    const state = message.state as TrackSubscriptionState;
    const layer =
      typeof message.layer === 'string' && FORWARDED_LAYERS.has(message.layer)
        ? (message.layer as ForwardedLayer)
        : undefined;

    const key = subscriptionKey(message.publisherId, message.trackId);
    const subscription = this.subscribed.get(key);
    if (!subscription) {
      this.pendingSubscriptionStates.set(key, { state, layer });
      return;
    }
    const participant = this.remoteParticipants.get(subscription.participantId);
    if (subscription.track._setSubscriptionState(state, layer) && participant) {
      this.emit('trackSubscriptionStateChanged', subscription.track, participant);
    }
  }

  /** Forgets speaker and quality state that only meant something on the session that ended. */
  private resetRoomSignals(): void {
    for (const participant of this._activeSpeakers) {
      participant._setSpeaking(false, 0);
    }
    this._activeSpeakers = [];
    this.localParticipant._setConnectionQuality('unknown');
    this.pendingSubscriptionStates.clear();
  }

  // --- Phase 2: dynacast (publisher.layers) ------------------------------

  /**
   * Turns simulcast encodings on and off to match what subscribers are
   * actually receiving (§5). An encoding nobody receives is CPU and uplink
   * spent on nothing; on a laptop with the camera at three layers that is
   * the difference between a fan that spins and one that does not.
   *
   * A frame for a track this participant does not publish, or one naming
   * no RID the sender negotiated, changes nothing. A client that never
   * applies these keeps sending every layer, which is the old behaviour,
   * so every failure here is logged and swallowed rather than surfaced.
   */
  private applyPublisherLayers(trackId: string, layers: unknown): void {
    if (typeof trackId !== 'string' || !Array.isArray(layers)) return;
    const entry = [...this.published.entries()].find(
      ([, publication]) => publication.trackId === trackId || publication.track.mediaStreamTrack.id === trackId,
    );
    if (!entry) {
      this.logger.debug('publisher.layers for a track we do not publish', trackId);
      return;
    }
    const [kind] = entry;
    const activity = new Map<string, boolean>();
    for (const layer of layers) {
      const rid = (layer as { rid?: unknown })?.rid;
      const active = (layer as { active?: unknown })?.active;
      if (typeof rid === 'string' && typeof active === 'boolean') {
        activity.set(rid, active);
      }
    }
    this.layerActivity.set(kind, activity);
    this.applyLayerActivity(kind);
  }

  /** Queues the desired encoding activity for one publication onto its sender. */
  private applyLayerActivity(kind: TrackKind): void {
    const activity = this.layerActivity.get(kind);
    const sender = this.published.get(kind)?.sender;
    if (!activity || activity.size === 0 || !sender) return;

    const previous = this.senderParameterChains.get(sender) ?? Promise.resolve();
    const run = previous.then(() => this.setEncodingActivity(sender, activity, kind));
    this.senderParameterChains.set(
      sender,
      run.catch(() => undefined),
    );
  }

  /**
   * One read-modify-write of a sender's parameters.
   *
   * `getParameters()` is read inside the queued task, never ahead of it:
   * `setParameters` must be handed the transaction from the most recent
   * read, and a read taken before an earlier write finished is exactly the
   * stale transaction it rejects. Skipped entirely when nothing would
   * change, so a repeated frame costs no encoder reconfiguration.
   */
  private async setEncodingActivity(
    sender: RTCRtpSender,
    activity: Map<string, boolean>,
    kind: TrackKind,
  ): Promise<void> {
    // The publication may have moved to another sender, or gone, while
    // this waited its turn.
    if (this.published.get(kind)?.sender !== sender) return;
    let parameters: RTCRtpSendParameters;
    try {
      parameters = sender.getParameters();
    } catch (error) {
      this.logger.debug('could not read sender parameters for dynacast', (error as Error).message);
      return;
    }
    const encodings = parameters.encodings ?? [];
    let changed = false;
    for (const encoding of encodings) {
      const rid = encoding.rid;
      if (!rid) continue;
      const wanted = activity.get(rid) ?? (RID_ALIASES[rid] ? activity.get(RID_ALIASES[rid]) : undefined);
      if (wanted === undefined || (encoding.active ?? true) === wanted) continue;
      encoding.active = wanted;
      changed = true;
    }
    if (!changed) return;
    try {
      await sender.setParameters(parameters);
      this.logger.debug(
        'dynacast applied',
        kind,
        encodings.map((encoding) => `${encoding.rid}:${encoding.active === false ? 'off' : 'on'}`).join(' '),
      );
    } catch (error) {
      // A renegotiation in flight can invalidate the transaction. The
      // desired state is kept, and the end of that round re-applies it.
      this.logger.debug('dynacast setParameters failed', (error as Error).message);
    }
  }

  // --- Negotiation -------------------------------------------------------

  private ensurePeerConnection(): RTCPeerConnection {
    if (this.pc) {
      return this.pc;
    }

    // Chrome's legacy encoded insertable streams only work on a connection
    // created with this flag; `RTCRtpScriptTransform` needs nothing.
    const pcConfig: RTCConfiguration & { encodedInsertableStreams?: boolean } = { iceServers: this.iceServers };
    if (this.e2ee?.needsInsertableStreams) {
      pcConfig.encodedInsertableStreams = true;
    }
    const pc = new RTCPeerConnection(pcConfig);
    this.pc = pc;
    // A transceiver belongs to the connection that created it, so anything
    // cached from the previous one is now a handle to a dead object.
    this.simulcastTransceivers.clear();
    // The SFU has no memory of layer preferences across a reconnect either,
    // so the record of what was already sent has to go. Pins are
    // application intent and deliberately survive.
    this.sentLayers.clear();

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        // End of gathering. We don't forward it. The server reads "no more
        // candidates" the same way, and an explicit end-of-candidates
        // message is one more thing three client implementations would
        // have to agree on.
        return;
      }
      this.signaling?.send({
        type: ClientMessageType.ICE_CANDIDATE,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? undefined,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
        usernameFragment: event.candidate.usernameFragment ?? undefined,
      });
    };

    pc.onconnectionstatechange = () => {
      this.logger.debug('peer connection state', pc.connectionState);
      switch (pc.connectionState) {
        case 'connected':
          this.mediaRejoinAttempts = 0;
          // A PeerConnection kept through a signaling reconnect can come
          // back before the socket does. The room is not `connected` until
          // both are; the resumed join reports it then.
          if (this.signaling?.isJoined) {
            this.setConnectionState('connected');
          }
          break;
        case 'failed':
          // ICE gave up. When signaling is down too, its own reconnect
          // rebuilds everything. When signaling is fine, nothing else is
          // going to notice: the socket is healthy, the SFU may still think
          // the session is alive, and the room would sit silent. So this
          // rejoins — new SFU session, new PeerConnection, everything
          // republished — with its own bounded backoff.
          if (!this.autoReconnect) {
            this._lastDisconnect = {
              reason: 'CONNECTION_FAILED',
              error: new RTCError('CONNECTION_FAILED', 'The media connection failed'),
            };
            this.setConnectionState('failed');
            break;
          }
          this.setConnectionState('reconnecting');
          this.scheduleMediaRejoin();
          break;
        case 'disconnected':
          // Transient by definition in WebRTC; ICE may well sort itself
          // out. Not surfaced as a state change, because a UI flashing
          // "reconnecting" at every little blip is worse than one that
          // holds its nerve.
          break;
        default:
          break;
      }
    };

    // The browser's own negotiation-needed bit, which is the only accurate
    // account of whether a local change still needs an offer.
    //
    // An earlier version of this kept its own "something changed" flag and
    // re-offered until an answer came back. That loops: the SFU's own
    // offers routinely cover our new senders, so the flag stayed set with
    // nothing left to negotiate, and each retry collided with the next SFU
    // offer — 48 rounds of offer/rollback in one join, until the
    // connection's message rate limit tripped. `negotiationneeded` fires
    // only while the current local description really is missing
    // something, and the browser clears it — including after a rollback —
    // so the loop cannot form.
    pc.onnegotiationneeded = () => {
      this.logger.debug('browser reports negotiation needed');
      this.negotiationNeeded = true;
      this.scheduleNegotiation();
    };

    pc.ontrack = (event) => this.handleIncomingTrack(event);

    pc.ondatachannel = (event) => {
      if (event.channel.label === LOSSY_DATA_CHANNEL_LABEL) {
        this.attachLossyChannel(event.channel);
        return;
      }
      if (event.channel.label !== DATA_CHANNEL_LABEL) {
        return;
      }
      this.attachDataChannel(event.channel);
    };

    return pc;
  }

  /**
   * Runs `task` after everything already queued, and before anything
   * queued later.
   *
   * The only way to touch this PeerConnection's signaling state. A failing
   * task must not wedge the chain, so the next one runs either way — the
   * caller still sees the rejection through the promise it holds.
   *
   * Nothing on this chain ever waits for the *peer*: each task does its
   * local half (apply a description, build an answer, send an offer) and
   * returns. Waiting for a reply while holding the chain would deadlock,
   * since the reply itself has to come through here.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.negotiationChain.then(task, task);
    this.negotiationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Nudges the chain to look for work.
   *
   * Does not decide that an offer is needed — `negotiationneeded` does
   * that. Used where a round has just ended, or where a local change has
   * been made and the browser's event may already have fired.
   */
  private scheduleNegotiationIfNeeded(): void {
    if (this.negotiationNeeded || this.publishedTracksMissingFromSdp()) {
      this.scheduleNegotiation();
    }
  }

  private scheduleNegotiation(): void {
    if (this.negotiationScheduled) {
      // One queued task already covers every request made so far. This is
      // the coalescing: mic + camera + screen share in quick succession
      // produce one offer between them.
      return;
    }
    this.negotiationScheduled = true;
    void this.enqueue(async () => {
      this.negotiationScheduled = false;
      await this.runNegotiation();
    });
  }

  /**
   * Offers, if there is anything to offer and the connection can take one.
   *
   * Runs on the chain, so `signalingState` cannot change under it between
   * the check and `setLocalDescription`.
   */
  private async runNegotiation(): Promise<void> {
    const pc = this.pc;
    const signaling = this.signaling;
    if (!pc || !signaling) {
      return;
    }
    if (!this.negotiationNeeded && !this.publishedTracksMissingFromSdp()) {
      return;
    }

    if (pc.signalingState !== 'stable') {
      // A round is in flight. Not an error and not something to retry on
      // a timer: whoever finishes that round calls back in here.
      this.logger.debug('negotiation deferred until the current round ends', pc.signalingState);
      return;
    }

    // Cleared before the attempt, and restored on failure, so a successful
    // offer can't be re-sent by a later settle point.
    this.negotiationNeeded = false;
    const iceRestart = this.iceRestartRequested;
    this.iceRestartRequested = false;
    try {
      // `iceRestart` as an offer option rather than `pc.restartIce()`,
      // because the option exists on every engine this SDK runs on, React
      // Native's WebRTC included.
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await pc.setLocalDescription(offer);
      // This offer is every published track's one chance to have its id
      // written into the description. See `msidRefreshAttempted`.
      for (const entry of this.published.values()) {
        if (entry.sender) {
          this.msidRefreshAttempted.add(entry.trackId);
        }
      }
      this.reconcilePublicationIds(pc);
      this.confirmSimulcastStatus();
      this.e2ee?.updatePayloadTypes(pc.localDescription?.sdp, pc.remoteDescription?.sdp);
      // Send `pc.localDescription`: by now it may carry candidates the
      // pre-set copy doesn't.
      signaling.send({
        type: ClientMessageType.SDP_OFFER,
        sdp: pc.localDescription?.sdp ?? offer.sdp ?? '',
      });
    } catch (error) {
      this.negotiationNeeded = true;
      this.iceRestartRequested = this.iceRestartRequested || iceRestart;
      this.logger.error('could not offer', (error as Error).message);
      this.emit('mediaError', new RTCError('MEDIA_ERROR', 'Could not negotiate the published track', error));
    }
  }

  /**
   * Answers the SFU.
   *
   * Rolls our own offer back first if one is outstanding. RFC-wise either
   * peer may offer, and something has to break the tie; the SFU is the one
   * with the room-wide view, so it wins and our change is re-queued rather
   * than dropped.
   */
  private async applyRemoteOffer(sdp: string): Promise<void> {
    const pc = this.ensurePeerConnection();
    try {
      if (pc.signalingState === 'have-local-offer') {
        this.logger.debug('glare: rolling our offer back and answering the sfu');
        // No flag set here on purpose. Rolling back makes the browser
        // re-evaluate whether anything is still unnegotiated, and it
        // fires `negotiationneeded` again only if something is. Assuming
        // it is — which this code used to do — re-offers into an SFU
        // round that already carried the change, forever.
        try {
          await pc.setLocalDescription({ type: 'rollback' });
        } catch (error) {
          // Every engine Swalvo supports implements explicit rollback, and
          // `setRemoteDescription(offer)` rolls back implicitly anyway.
          // Log and carry on rather than abandoning the answer.
          this.logger.debug('explicit rollback unavailable', (error as Error).message);
        }
      }

      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Before the answer goes out, so the SFU knows which publication is
      // which by the time this description lets media flow.
      this.reconcilePublicationIds(pc);
      this.confirmSimulcastStatus();
      this.e2ee?.updatePayloadTypes(pc.localDescription?.sdp, pc.remoteDescription?.sdp);

      this.signaling?.send({
        type: ClientMessageType.SDP_ANSWER,
        sdp: pc.localDescription?.sdp ?? answer.sdp ?? '',
      });
    } catch (error) {
      this.logger.error('failed to answer offer', (error as Error).message);
      // Carry the browser's own reason. Without it this surfaces as a bare
      // "Could not answer the server's offer", which says that
      // renegotiation broke but not why — and renegotiation is exactly
      // where an m-line or direction mismatch shows up.
      // Not `Error.cause`: this package's TS target predates it, and the
      // message is what actually reaches a developer's console anyway.
      const reason = error instanceof Error ? error.message : String(error);
      this.emit('mediaError', new Error(`Could not answer the server's offer: ${reason}`));
      return;
    }

    // Back to stable, so anything of ours that was waiting can go now.
    this.afterRoundTrip();
  }

  private async applyRemoteAnswer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      return;
    }
    if (pc.signalingState !== 'have-local-offer') {
      // An answer to an offer we rolled back for glare. Applying it would
      // throw "Called in wrong state: stable"; the round it belonged to no
      // longer exists, and our change is already re-queued.
      this.logger.debug('discarding an answer for a superseded offer', pc.signalingState);
      this.afterRoundTrip();
      return;
    }
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (error) {
      this.logger.error('failed to apply answer', (error as Error).message);
    }
    this.afterRoundTrip();
  }

  private async applyRemoteCandidate(message: {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
    usernameFragment?: string;
  }): Promise<void> {
    if (!this.pc) {
      return;
    }
    try {
      await this.pc.addIceCandidate({
        candidate: message.candidate,
        sdpMid: message.sdpMid,
        sdpMLineIndex: message.sdpMLineIndex,
        usernameFragment: message.usernameFragment,
      });
    } catch (error) {
      // Candidates turn up just before a remote description gets set, or
      // for a transceiver that's already gone, all the time. Neither is
      // worth surfacing; the connection comes up on the candidates that do
      // apply.
      this.logger.debug('ignoring ICE candidate', (error as Error).message);
    }
  }

  /**
   * A round ended: offer again if anything still needs one.
   *
   * Two things can: the browser's own negotiation-needed bit, and Swalvo's
   * requirement that our published tracks appear in the local description
   * by their real ids. See `publishedTracksMissingFromSdp()`.
   */
  private afterRoundTrip(): void {
    if (this.publishedTracksMissingFromSdp()) {
      this.negotiationNeeded = true;
    }
    // Dynacast state is re-asserted once descriptions settle: a
    // `setParameters` refused mid-round is retried here, and an engine that
    // resets encodings on a description change gets them put back.
    for (const kind of this.layerActivity.keys()) {
      this.applyLayerActivity(kind);
    }
    this.scheduleNegotiationIfNeeded();
  }

  /**
   * Whether some published track's id is absent from the local
   * description's `a=msid:` lines.
   *
   * Swalvo's SFU identifies a published track by the id in the SDP `msid`
   * and matches it against the `track.publish` declaration that says
   * whether it is a camera or a screen share. So it is not enough for the
   * track to be *sending*: our id has to be the one on the wire.
   *
   * It is possible for it not to be. The SFU pre-creates a receive slot
   * for a declared track, and `addTrack` reuses that transceiver; if the
   * SFU's own next offer then covers the m-line, the browser's
   * negotiation-needed bit clears with the SFU's msid still in place. RTP
   * flows — the SFU just has no idea which of our tracks it belongs to,
   * and falls back to guessing from the codec kind. A camera guessed as a
   * camera hides it; a screen share guessed as a camera puts somebody's
   * shared window in the face tile.
   *
   * Checking the SDP rather than trusting a flag is what makes this
   * terminate: one offer of ours puts every id in place, and the answer to
   * the next check is no.
   */
  private publishedTracksMissingFromSdp(): boolean {
    const pc = this.pc;
    if (!pc || this.published.size === 0) {
      return false;
    }
    const sdp = pc.localDescription?.sdp;
    if (!sdp) {
      // Nothing negotiated yet; the offer that is coming will carry them.
      return false;
    }

    const announced = new Set<string>();
    for (const line of sdp.split(/\r?\n/)) {
      if (!line.startsWith('a=msid:')) {
        continue;
      }
      // `a=msid:<stream-id> <track-id>`; the stream-only form names no track.
      const trackId = line.slice('a=msid:'.length).trim().split(/\s+/)[1];
      if (trackId) {
        announced.add(trackId);
      }
    }

    for (const entry of this.published.values()) {
      if (!entry.sender || announced.has(entry.trackId)) {
        continue;
      }
      if (this.msidRefreshAttempted.has(entry.trackId)) {
        // Asked once already. The SFU will fall back to guessing this
        // track's source from its codec kind, which is right for a camera
        // and a microphone and wrong for a screen share — worth a warning,
        // not worth another offer.
        this.logger.warn(
          'published track is not announced by its own id; the sfu will guess its source',
          entry.trackId,
        );
        continue;
      }
      this.logger.debug('published track missing from the local sdp', entry.trackId);
      return true;
    }
    return false;
  }

  /**
   * Resolves when the data channel is open.
   *
   * What `sendData()` actually needs to wait for. Waiting on "negotiation
   * has gone quiet" instead resolves a beat too early — the browser raises
   * `negotiationneeded` on a task, so a connection looks quiet for one
   * turn after the channel was created — and the caller would be told its
   * payload had gone out while it was still queued.
   */
  private dataChannelOpened(): Promise<void> {
    if (this.dataChannel?.readyState === 'open') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.dataChannelWaiters.push({ resolve, reject });
    });
  }

  private settleDataChannel(): void {
    const waiters = this.dataChannelWaiters;
    if (waiters.length === 0) {
      return;
    }
    this.dataChannelWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  /**
   * Fails everyone waiting on the data channel, because it is never going
   * to open.
   *
   * Only for a connection that is finished — a terminal failure or a
   * deliberate leave. A reconnect deliberately does *not* come through
   * here: rejoining re-creates the channel and settles the wait, so a
   * `sendData()` made mid-blip still goes out afterwards rather than
   * throwing at the caller.
   */
  private abortDataChannelWaiters(reason: string): void {
    const waiters = this.dataChannelWaiters;
    if (waiters.length === 0) {
      return;
    }
    this.dataChannelWaiters = [];
    const error = new RTCError('CONNECTION_FAILED', reason);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  // --- Incoming media ----------------------------------------------------

  /**
   * Matches an arriving track up with whatever signaling said about it.
   *
   * The SFU forwards every subscription carrying the *publisher's* track id
   * as the SDP `msid` track id, and that's what makes attribution possible
   * without a side channel. `ontrack` and `track.published` race, so this
   * only completes a subscription when both halves are in, parking
   * whichever showed up first.
   *
   * # Why the id comes from the SDP, not the track
   *
   * `RTCTrackEvent.track.id` is **not** the remote track id. Chrome mints
   * a brand-new local id for a received track and pays no attention to the
   * `msid`; the id in `a=msid:<stream> <track>` is the remote one. So
   * matching on `event.track.id` never matched anything, ever. And because
   * the unmatched track got parked as "media arrived early", it failed in
   * total silence: a subscription that simply never completed, not an
   * error anybody could see. Reading the `msid` is the standards-defined
   * way to get the id the remote peer actually picked.
   */
  private handleIncomingTrack(event: RTCTrackEvent): void {
    // As early as possible: Chrome's legacy API wants the encoded streams
    // claimed straight away. Whose frames they are follows from
    // `completeSubscription`.
    this.e2ee?.setupReceiver(event.receiver, event.track.kind === 'audio' ? 'audio' : 'video');
    const [stream] = event.streams;
    // In order of preference: the msid track id, which is what the SFU
    // actually labelled this with, then the local track id, for any stack
    // that does adopt the msid.
    const trackId = this.remoteTrackIdFor(event) ?? event.track.id;

    // Whichever announcement mentions this track id names the publisher.
    // The SFU guarantees track ids are unique inside a room, since they
    // come from separate publishers' own tracks.
    const announcement = this.findAnnouncementForTrack(trackId);

    if (!announcement) {
      // Log what *was* announced. Nine times out of ten a subscription
      // that never completes is an id mismatch, not a real ordering race,
      // and without this line the two look identical.
      this.logger.debug(
        'media arrived before its announcement',
        `resolved=${trackId}`,
        `local=${event.track.id}`,
        `stream=${stream?.id ?? 'none'}`,
        `mid=${event.transceiver?.mid ?? 'none'}`,
        `announced=[${Array.from(this.announcedTracks.values())
          .map((entry) => `${entry.participantId}:${entry.track.trackId}`)
          .join(', ')}]`,
      );
      this.pendingMedia.set(pendingKey(trackId), {
        stream: stream ?? new MediaStream([event.track]),
        track: event.track,
        receiver: event.receiver,
      });
      return;
    }

    this.completeSubscription(announcement.participantId, announcement.track, event.track, event.receiver);
  }

  /**
   * The remote track id for an arriving track, read out of the remote SDP.
   *
   * Found via the transceiver's `mid` rather than by scanning every
   * `a=msid:` line. Someone publishing both a camera and a screen share
   * has two video m-sections, and picking the wrong one labels a screen
   * share as somebody's face.
   *
   * Returns undefined when the SDP doesn't say, either an `msid`-less
   * offer or a transceiver with no mid yet, so the caller can fall back
   * instead of guessing.
   */
  private remoteTrackIdFor(event: RTCTrackEvent): string | undefined {
    const mid = event.transceiver?.mid;
    const sdp = this.pc?.remoteDescription?.sdp;
    if (!mid || !sdp) {
      return undefined;
    }
    return msidTrackIdForMid(sdp, mid);
  }

  private findAnnouncementForTrack(trackId: string): { participantId: string; track: ServerTrack } | undefined {
    for (const announcement of this.announcedTracks.values()) {
      if (announcement.track.trackId === trackId) {
        return announcement;
      }
    }
    return undefined;
  }

  private announceTrack(participantId: string, track: ServerTrack): void {
    const key = subscriptionKey(participantId, track.trackId);
    this.announcedTracks.set(key, { participantId, track });
    this.logger.debug('track announced', `${participantId}:${track.trackId}`, track.kind, track.source);

    const participant = this.remoteParticipants.get(participantId);
    if (participant) {
      this.emit('trackPublished', trackKindFromSource(track.source, track.kind), participant);
    }

    // Media might already have beaten us here.
    const pending = this.pendingMedia.get(pendingKey(track.trackId));
    if (pending) {
      this.pendingMedia.delete(pendingKey(track.trackId));
      this.completeSubscription(participantId, track, pending.track, pending.receiver);
    }
  }

  private completeSubscription(
    participantId: string,
    serverTrack: ServerTrack,
    mediaStreamTrack: MediaStreamTrack,
    receiver: RTCRtpReceiver,
  ): void {
    const participant = this.remoteParticipants.get(participantId);
    if (!participant) {
      this.logger.debug('track for an unknown participant', participantId);
      return;
    }

    const key = subscriptionKey(participantId, serverTrack.trackId);
    if (this.subscribed.has(key)) {
      return;
    }

    this.e2ee?.setupReceiver(receiver, serverTrack.kind, participantId);
    const delegate = new NativeRemoteTrackDelegate(mediaStreamTrack, receiver);
    delegate.setPublisherMuted(serverTrack.muted);
    const kind = trackKindFromSource(serverTrack.source, serverTrack.kind);
    const track = new RemoteTrack(delegate, kind);

    // Where the subscription starts (§4). With `autoSubscribe: false` the
    // SFU holds every video at `paused_client` until a layer is asked for,
    // so that is what the track says from the start; a report that beat
    // the track here overrides it either way.
    const isVideo = serverTrack.kind === 'video';
    const parked = this.pendingSubscriptionStates.get(key);
    this.pendingSubscriptionStates.delete(key);
    if (parked) {
      track._setSubscriptionState(parked.state, parked.layer);
    } else if (isVideo && !this.autoSubscribe) {
      track._setSubscriptionState('paused_client', 'off');
    }

    const subscription: SubscribedTrack = {
      track,
      delegate,
      participantId,
      trackId: serverTrack.trackId,
      hidden: false,
    };
    this.subscribed.set(key, subscription);
    this.attachLayerControl(track, key);
    participant.tracks.push(track);
    this.emit('trackSubscribed', track, participant);

    // Intent that outlived the previous track object — a pin or a
    // `setEnabled(false)` from before a reconnect — goes to the new SFU
    // session at once, which has never heard of it.
    if (isVideo && (this.pinnedLayers.has(key) || this.disabledTracks.has(key))) {
      if (this.disabledTracks.has(key)) track['_enabled'] = false;
      this.sendEffectiveLayer(subscription);
    }

    mediaStreamTrack.onended = () => {
      const subscription = this.subscribed.get(key);
      if (!subscription) {
        return;
      }
      this.subscribed.delete(key);
      this.adaptiveControllers.get(key)?.dispose();
      this.adaptiveControllers.delete(key);
      this.pinnedLayers.delete(key);
      this.disabledTracks.delete(key);
      this.sentLayers.delete(key);
      const index = participant.tracks.indexOf(subscription.track);
      if (index !== -1) {
        participant.tracks.splice(index, 1);
      }
      this.emit('trackUnsubscribed', subscription.track, participant);
    };
  }

  // --- Publishing --------------------------------------------------------

  async enableCamera(enabled: boolean): Promise<LocalTrack | undefined> {
    return enabled ? this.publishKind('camera', () => createCameraTrack()) : this.unpublishKind('camera');
  }

  async enableMicrophone(enabled: boolean): Promise<LocalTrack | undefined> {
    return enabled ? this.publishKind('microphone', () => createMicrophoneTrack()) : this.unpublishKind('microphone');
  }

  /**
   * With `audio: true`, also publishes whatever audio the browser hands back
   * (Chrome: a tab, or the whole system on Windows/ChromeOS) as a second
   * track with source `screenShareAudio` (phase7-contracts §3). No audio
   * track simply means video only. Unpublishing the screen share, by any
   * route, unpublishes both — see `unpublish()`.
   */
  async enableScreenShare(enabled: boolean, options: ScreenShareOptions = {}): Promise<LocalTrack | undefined> {
    if (!enabled) {
      return this.unpublishKind('screenShare');
    }
    let audio: LocalTrack | undefined;
    const video = await this.publishKind('screenShare', async () => {
      const captured = await createScreenShareTracks({ audio: options.audio === true });
      audio = captured.audio;
      return captured.video;
    });
    const audioTrack = audio as LocalTrack | undefined;
    if (audioTrack) {
      try {
        await this.withKindLock('screenShareAudio', async () => {
          const existing = this.published.get('screenShareAudio');
          if (existing) {
            await this.unpublish(existing.track);
          }
          if (this.published.get('screenShare')?.track !== video) {
            // The share ended while we waited; publishing its audio now would orphan it.
            audioTrack.mediaStreamTrack.stop();
            return;
          }
          await this.publish(audioTrack);
        });
      } catch (error) {
        audioTrack.mediaStreamTrack.stop();
        this.logger.warn('could not publish the screen-share audio; sharing video only', (error as Error).message);
        this.emit('mediaError', error instanceof Error ? error : new Error(String(error)));
      }
    }
    return video;
  }

  /**
   * Serializes enable/disable per kind.
   *
   * Two `enableCamera()` calls in flight at once used to mean two
   * `getUserMedia` prompts, two senders and one of them orphaned in the
   * `published` map. Callers that overlap now share the first call's
   * result. Per kind rather than global, so a microphone does not queue
   * behind a camera's device prompt.
   */
  private async withKindLock<T>(kind: TrackKind, operation: () => Promise<T>): Promise<T> {
    const previous = this.kindOperations.get(kind) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    this.kindOperations.set(
      kind,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async publishKind(kind: TrackKind, capture: () => Promise<LocalTrack>): Promise<LocalTrack | undefined> {
    return this.withKindLock(kind, () => this.publishKindLocked(kind, capture));
  }

  private async publishKindLocked(
    kind: TrackKind,
    capture: () => Promise<LocalTrack>,
  ): Promise<LocalTrack | undefined> {
    const existing = this.published.get(kind);
    if (existing) {
      // Already publishing, so unmute instead of capturing again. A
      // second getUserMedia on the same device is slower and on some
      // platforms just fails.
      await existing.track.unmute();
      this.signaling?.send({
        type: ClientMessageType.TRACK_MUTE,
        trackId: existing.trackId,
        muted: false,
      });
      return existing.track;
    }

    // Refused before capture, so an E2EE room never even lights the camera
    // of a client that could only send it in the clear.
    this.assertMayPublishMedia();
    const track = await capture();
    await this.publish(track);
    return track;
  }

  private async unpublishKind(kind: TrackKind): Promise<undefined> {
    return this.withKindLock(kind, async () => {
      const existing = this.published.get(kind);
      if (!existing) {
        return undefined;
      }
      await this.unpublish(existing.track);
      return undefined;
    });
  }

  async publish(track: LocalTrack): Promise<void> {
    const delegate = track['delegate'] as unknown;
    if (!(delegate instanceof NativeLocalTrackDelegate)) {
      // Publishing needs a delegate that can hold an `RTCRtpSender`, and
      // a hand-built one has nowhere to put it. Name the way through
      // rather than just the refusal: an application-provided track goes
      // through `createCustomTrack()`.
      throw new RTCError(
        'MEDIA_ERROR',
        'This track was not created by the Swalvo SDK. Wrap your own MediaStreamTrack with createCustomTrack() (or client.createCustomTrack()) before publishing it',
      );
    }
    this.assertMayPublishMedia();

    this.published.set(track.kind, {
      track,
      delegate,
      trackId: track.mediaStreamTrack.id,
      // Nothing is claimed until negotiation has been read back.
      simulcast: kindUsesSimulcast(track.kind) ? 'pending' : 'notApplicable',
    });
    if (!this.localParticipant.tracks.includes(track)) {
      this.localParticipant.tracks.push(track);
    }

    try {
      await this.attachToPeerConnection(track.kind);
    } catch (error) {
      // Desired state only survives if the intent is still valid. A track
      // that cannot be added at all is not published, and saying it is
      // would have a reconnect keep retrying it forever.
      this.published.delete(track.kind);
      const index = this.localParticipant.tracks.indexOf(track);
      if (index !== -1) {
        this.localParticipant.tracks.splice(index, 1);
      }
      throw error;
    }

    // `attachToPeerConnection` has already declared the source, hooked
    // the track's own `onended`, and asked for the offer that carries it.
    this.emit('localTrackPublished', track);
  }

  /**
   * Puts one desired publication onto the current PeerConnection.
   *
   * Everything the SFU needs to know about a track lives here, so the
   * first publish and a post-reconnect restore go through exactly the same
   * code and cannot drift apart. Idempotent: a track already carried by a
   * sender on this connection is left alone, which is what stops a re-sent
   * room state from adding a second sender for the same camera.
   */
  private async attachToPeerConnection(kind: TrackKind): Promise<void> {
    const entry = this.published.get(kind);
    if (!entry) {
      return;
    }
    const pc = this.ensurePeerConnection();
    const mediaStreamTrack = entry.track.mediaStreamTrack;

    const alreadyAttached = pc
      .getSenders()
      .find((sender) => sender.track !== null && sender.track === mediaStreamTrack);
    if (alreadyAttached) {
      // Same connection as before (a re-sent room state). Keep the
      // publication pointing at the sender it already has: the restore
      // path cleared it, and leaving it cleared made mute and stats lose
      // their sender until the next reconnect.
      entry.sender = alreadyAttached;
      entry.delegate.setSender(alreadyAttached);
      this.e2ee?.setupSender(alreadyAttached, mediaStreamTrack.kind === 'audio' ? 'audio' : 'video');
      return;
    }

    const stream = typeof MediaStream !== 'undefined' ? new MediaStream([mediaStreamTrack]) : undefined;

    const attached = this.attachSender(pc, kind, mediaStreamTrack, stream);
    const sender = attached.sender;
    if (attached.transceiver) {
      this.simulcastTransceivers.set(kind, attached.transceiver);
    }
    entry.simulcast = attached.simulcast;

    // Declared over signaling, never inferred from the SDP. A page can't
    // pick the stream or track id the SDP carries, since both are
    // read-only, which leaves codec kind as all the SFU would have to go
    // on. And that can't tell a screen share from a camera (spec §16).
    // Sent before negotiating, so the source is known by the time the
    // track lands on the node. Re-sent on a restore too: the SFU session
    // is new and has never heard of this track.
    const source = declaredSourceFor(kind);
    if (source) {
      this.signaling?.send({
        type: ClientMessageType.TRACK_PUBLISH,
        trackId: mediaStreamTrack.id,
        source,
      });
    }

    entry.sender = sender;
    entry.trackId = mediaStreamTrack.id;
    entry.delegate.setSender(sender);
    // Before any frame is encoded: with E2EE on, a sender never emits a
    // frame that has not been through the worker.
    this.e2ee?.setupSender(sender, mediaStreamTrack.kind === 'audio' ? 'audio' : 'video');
    // A new sender starts with every encoding on, and the SFU session it
    // belongs to will say what it wants of it (§5). Carrying the old
    // demand over could leave a layer off that someone now needs.
    this.layerActivity.delete(kind);

    // A screen share the user stops from the browser's own bar ends the
    // track without telling us. Unpublishing here keeps the room's view
    // correct without the application having to watch for it.
    mediaStreamTrack.onended = () => {
      void this.unpublish(entry.track).catch(() => undefined);
    };

    // `addTrack` sets the browser's negotiation-needed bit and
    // `onnegotiationneeded` carries it from there. This nudge is for the
    // case the bit does not cover: a reused transceiver whose m-section
    // still announces somebody else's msid.
    this.scheduleNegotiationIfNeeded();
  }

  /**
   * Makes the publication ids we told the SFU match the ids on the wire.
   *
   * A publication's identity in this protocol is the track id in the SDP
   * `a=msid:` line. The SFU keys everything on it — the published-track
   * map, the `track.publish` source declaration, mute lookups, and the id
   * it announces to subscribers — and it reads that id off the RTP stream
   * as `TrackRemote.ID()`. Nothing else in the exchange identifies a
   * publication, which is why the id has to be right rather than merely
   * plausible.
   *
   * It was not always right. The SFU pre-creates one recvonly audio and
   * one recvonly video transceiver for every subscribing participant, so
   * that a first publish costs no extra renegotiation. `addTrack` reuses
   * those, and the m-section can keep the msid it already had —
   * Chrome will not rewrite an id it did not author. So the SFU received a
   * stream announcing one id while the declaration named another, found no
   * match, and fell back to inferring the source from the codec kind:
   * right for a camera, right for a microphone, and wrong for a screen
   * share, which then arrives labelled `camera` and lands in the face tile
   * of every layout keyed on source.
   *
   * The fix is to read what the browser actually wrote and declare that.
   * Called immediately after our own `setLocalDescription` and before the
   * description goes out, so the corrected declaration reaches the SFU
   * ahead of the media it describes — same socket, so ordering holds
   * without waiting for anything.
   *
   * No SDP is rewritten and no identifier is invented: this is the
   * protocol's existing publication id, finally taken from the one place
   * that knows it.
   */
  private reconcilePublicationIds(pc: RTCPeerConnection): void {
    const sdp = pc.localDescription?.sdp;
    if (!sdp || this.published.size === 0) {
      return;
    }

    for (const [kind, entry] of this.published) {
      if (!entry.sender) {
        continue;
      }
      const mid = pc.getTransceivers().find((t) => t.sender === entry.sender)?.mid;
      if (!mid) {
        // No mid until a description has been applied to this m-section.
        continue;
      }
      const onTheWire = msidTrackIdForMid(sdp, mid);
      if (!onTheWire || onTheWire === entry.trackId) {
        continue;
      }

      this.logger.debug(
        'publication id corrected from the sdp',
        `${kind}: ${entry.trackId} -> ${onTheWire} (mid ${mid})`,
      );
      entry.trackId = onTheWire;

      // Re-declared under the id the SFU will actually see. Everything
      // else keyed on `trackId` — mute, unpublish — now agrees with it too.
      const source = declaredSourceFor(kind);
      if (source) {
        this.signaling?.send({
          type: ClientMessageType.TRACK_PUBLISH,
          trackId: onTheWire,
          source,
        });
      }
    }
  }

  /**
   * Re-publishes everything this participant wants published onto a
   * replacement PeerConnection.
   *
   * Runs on every join, so a reconnect restores the microphone, camera and
   * screen share that were live before the outage — in one renegotiation,
   * because every `addTrack` here lands before the browser's queued
   * `negotiationneeded` task runs.
   *
   * A screen share is the one case where desired state can have expired
   * while we were away: ending the share is the user's own doing, through
   * browser UI Swalvo never sees, and its track is dead for good. Restoring
   * a dead track would publish an m-section that never carries a frame, so
   * it is dropped and the room is told, exactly as if the user had stopped
   * sharing while connected.
   */
  private restoreLocalPublications(): void {
    // The data channel is per-connection too, and a page that has used it
    // once expects it to keep working across a blip. Ahead of the tracks
    // deliberately: a room that only ever sent data has nothing in
    // `published`, and this used to sit behind an early return for that
    // case — so the channel came back only for participants who also had
    // a camera on.
    if (this.mayOpenDataChannels()) {
      if (this.dataChannelWanted && !this.dataChannel) {
        this.openDataChannel();
      }
      if (this.supportsDataV2 && (this.lossyChannelWanted || this.dataChannelWanted) && !this.lossyChannel) {
        this.openLossyChannel();
      }
    }

    // A new PeerConnection negotiates from scratch, so every track gets
    // its corrective offer again if it needs one.
    this.msidRefreshAttempted.clear();

    for (const [kind, entry] of [...this.published]) {
      if (entry.track.mediaStreamTrack.readyState === 'ended') {
        this.logger.debug('dropping a publication whose source has ended', kind);
        this.published.delete(kind);
        const index = this.localParticipant.tracks.indexOf(entry.track);
        if (index !== -1) {
          this.localParticipant.tracks.splice(index, 1);
        }
        entry.sender = undefined;
        entry.delegate.setSender(undefined);
        this.emit('localTrackUnpublished', entry.track);
        continue;
      }

      // The old sender belonged to a connection that is gone.
      entry.sender = undefined;
      entry.delegate.setSender(undefined);
      void this.attachToPeerConnection(kind).catch((error) => {
        this.logger.error('could not restore a publication', kind, (error as Error).message);
        this.emit('mediaError', error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  async unpublish(track: LocalTrack): Promise<void> {
    const entry = this.published.get(track.kind);
    if (!entry || entry.track !== track) {
      return;
    }

    this.published.delete(track.kind);
    this.layerActivity.delete(track.kind);
    const index = this.localParticipant.tracks.indexOf(track);
    if (index !== -1) {
      this.localParticipant.tracks.splice(index, 1);
    }

    entry.delegate.setSender(undefined);
    if (entry.sender) {
      const simulcast = this.simulcastTransceivers.get(track.kind);
      if (simulcast?.sender === entry.sender && typeof simulcast.stop === 'function') {
        // Stopped, not parked. A parked transceiver revived later with
        // `replaceTrack` keeps its SSRCs and its `msid`, so the SFU never
        // sees a new incoming track: it already tore down the forwarding
        // for this one on the unpublish, and nothing re-creates it. Every
        // subscriber then silently lost the camera after a disable/enable
        // cycle. A stopped transceiver's m-section is recycled by the next
        // `addTransceiver`, so the SDP does not grow per toggle either.
        // Pinned end to end by apps/api/test/rtc-two-browser.e2e-spec.ts.
        this.simulcastTransceivers.delete(track.kind);
        try {
          simulcast.stop();
        } catch (error) {
          this.logger.debug('stopping the simulcast transceiver failed', (error as Error).message);
        }
      } else {
        try {
          this.pc?.removeTrack(entry.sender);
        } catch (error) {
          this.logger.debug('removeTrack failed', (error as Error).message);
        }
      }
      entry.sender = undefined;
    }
    this.msidRefreshAttempted.delete(entry.trackId);
    track.mediaStreamTrack.onended = null;
    track.mediaStreamTrack.stop();

    // `removeTrack` sets the browser's negotiation-needed bit; the offer
    // that drops the m-section comes from `onnegotiationneeded`.
    this.emit('localTrackUnpublished', track);

    // Screen-share audio lives and dies with the share (phase7-contracts
    // §3): the disable call, the browser's own "Stop sharing" bar and a
    // withdrawn permission all come through here.
    if (track.kind === 'screenShare') {
      const companion = this.published.get('screenShareAudio');
      if (companion) {
        await this.unpublish(companion.track);
      }
    }
  }

  /**
   * Puts a local track on the connection, with a simulcast ladder when the
   * kind calls for one.
   *
   * # Why this is not `addTrack`
   *
   * `addTrack` returns a sender with exactly one encoding, and the number
   * of encodings on a sender is fixed for its lifetime — `setParameters` is
   * specified to reject any change to it. RIDs also only reach the SDP when
   * they were present before the offer was generated. So the ladder has to
   * be declared at the moment the transceiver is created and can never be
   * added afterwards, which is precisely what the previous `addTrack` +
   * `setParameters` pair attempted, failed at, and logged at debug level.
   *
   * # The comment this replaces
   *
   * The old code explained that `addTransceiver` was not shipped "because
   * this SFU does not answer a client offer that adds m-sections". That was
   * not true, or is no longer: `Participant.AcceptOffer`
   * (`services/sfu/internal/room/participant.go`) does a plain
   * `SetRemoteDescription` + `CreateAnswer` and rejects only on glare,
   * which is retryable. The Flutter SDK has relied on that path for its
   * first publish of every kind. It is verified end to end by
   * `services/sfu/internal/room/simulcast_integration_test.go`, where a
   * client-offered simulcast m-section is answered with
   * `a=simulcast:recv low;medium;high`.
   *
   * # What it reuses
   *
   * Not the SFU's pre-created recvonly transceivers — those exist with one
   * encoding and can never carry a ladder. A transceiver of its own that is
   * still live on this connection is reused; one that was unpublished has
   * been stopped (see `unpublish`), so a re-enabled camera gets a fresh
   * transceiver and the SFU sees a genuinely new track. Its m-section is
   * recycled from the stopped one, so toggling does not grow the SDP.
   */
  private attachSender(
    pc: RTCPeerConnection,
    kind: TrackKind,
    mediaStreamTrack: MediaStreamTrack,
    stream: MediaStream | undefined,
  ): { sender: RTCRtpSender; transceiver?: RTCRtpTransceiver; simulcast: SimulcastStatus } {
    if (!kindUsesSimulcast(kind)) {
      return { sender: this.addPlainTrack(pc, mediaStreamTrack, stream), simulcast: 'notApplicable' };
    }

    const existing = this.simulcastTransceivers.get(kind);
    if (existing && existing.sender && pc.getTransceivers().includes(existing)) {
      try {
        void existing.sender.replaceTrack(mediaStreamTrack);
        existing.direction = 'sendonly';
        // Already negotiated, so the ladder is knowable right now. Leaving
        // it `pending` would strand the status: `replaceTrack` deliberately
        // costs no renegotiation, so there is no offer coming to confirm it
        // on.
        return {
          sender: existing.sender,
          transceiver: existing,
          simulcast: confirmSimulcast(existing.sender).status,
        };
      } catch (error) {
        // The transceiver is unusable — stopped, or belonging to a
        // connection a reconnect replaced. Build a new one rather than
        // failing a publish over a cache.
        this.logger.debug('reusing the simulcast transceiver failed', (error as Error).message);
        this.simulcastTransceivers.delete(kind);
      }
    }

    const codec = this.effectiveVideoCodec();
    if (codec === 'vp9' || codec === 'av1') {
      // SVC (§2.2): one encoding carrying L3T3_KEY, which the SFU thins
      // per subscriber by dropping layers instead of switching streams.
      try {
        const transceiver = pc.addTransceiver(mediaStreamTrack, {
          direction: 'sendonly',
          streams: stream ? [stream] : [],
          sendEncodings: svcSendEncodings(),
        });
        this.applyCodecPreference(transceiver, codec);
        return { sender: transceiver.sender, transceiver, simulcast: 'pending' };
      } catch (error) {
        this.svcRefused = true;
        this.logger.warn(
          `this browser refused ${codec} SVC; publishing VP8 simulcast instead`,
          (error as Error).message,
        );
      }
    }

    try {
      const transceiver = pc.addTransceiver(mediaStreamTrack, {
        direction: 'sendonly',
        streams: stream ? [stream] : [],
        sendEncodings: simulcastSendEncodings(),
      });
      this.applyCodecPreference(transceiver, this.effectiveVideoCodec());
      return { sender: transceiver.sender, transceiver, simulcast: 'pending' };
    } catch (error) {
      // A browser that will not take the ladder still has to be able to
      // publish. Falling back to one layer is the controlled outcome;
      // doing it silently is what let this ship broken for months, so it
      // is a warning and it is recorded on the publication.
      this.logger.warn(
        'simulcast is unavailable in this browser: the camera will publish a single ' +
          'full-quality layer, so subscribers cannot drop to a cheaper one and a large ' +
          'call will cost every participant the full bitrate.',
        (error as Error).message,
      );
      return { sender: this.addPlainTrack(pc, mediaStreamTrack, stream), simulcast: 'unsupported' };
    }
  }

  /**
   * Puts the video codec (and its RTX) first in the offer. Best effort: a
   * browser without `setCodecPreferences`, or without the codec, publishes
   * with its own order, which only costs the live stream its
   * zero-transcode path.
   */
  private applyCodecPreference(transceiver: RTCRtpTransceiver, codec: VideoCodecName | undefined): void {
    if (!codec || typeof transceiver.setCodecPreferences !== 'function') return;
    const ordered = videoCodecsPreferring(codec);
    if (!ordered) {
      this.logger.warn(`this browser cannot send ${codec}; publishing with its default codec order`);
      return;
    }
    try {
      transceiver.setCodecPreferences(ordered);
    } catch (error) {
      this.logger.debug('setCodecPreferences failed', (error as Error).message);
    }
  }

  /** Set once a browser refuses an SVC encoding, so later publishes go straight to simulcast. */
  private svcRefused = false;

  /**
   * `videoCodec` as this browser can honour it: VP9/AV1 need L3T3_KEY SVC
   * (§2.2), and without it the camera falls back to VP8 simulcast rather
   * than a single-layer VP9 nobody can thin.
   */
  private effectiveVideoCodec(): VideoCodecName | undefined {
    const codec = this.preferredVideoCodec;
    if ((codec === 'vp9' || codec === 'av1') && (this.svcRefused || !svcSupported(codec))) {
      return 'vp8';
    }
    return codec;
  }

  /**
   * Opus with RED first (§2.1), unless E2EE is configured: Chrome hands the
   * frame transform the RED-wrapped payload, which no other platform's
   * frame cryptor would parse.
   */
  private applyAudioRed(transceiver: RTCRtpTransceiver): void {
    if (!this.audioRed || this.e2eeOptions || typeof transceiver.setCodecPreferences !== 'function') return;
    const ordered = redFirstAudioCodecs();
    if (!ordered) return;
    try {
      transceiver.setCodecPreferences(ordered);
    } catch (error) {
      this.logger.debug('setCodecPreferences (red) failed', (error as Error).message);
    }
  }

  private addPlainTrack(
    pc: RTCPeerConnection,
    mediaStreamTrack: MediaStreamTrack,
    stream: MediaStream | undefined,
  ): RTCRtpSender {
    try {
      const sender = stream ? pc.addTrack(mediaStreamTrack, stream) : pc.addTrack(mediaStreamTrack);
      const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
      if (transceiver && mediaStreamTrack.kind === 'video') {
        this.applyCodecPreference(transceiver, this.effectiveVideoCodec());
      } else if (transceiver && mediaStreamTrack.kind === 'audio') {
        this.applyAudioRed(transceiver);
      }
      return sender;
    } catch (error) {
      throw new RTCError('MEDIA_ERROR', 'Could not add the track to the connection', error);
    }
  }

  /**
   * Confirms the ladder after negotiation and reports what actually
   * happened.
   *
   * Called from the negotiation paths, once a local description exists:
   * before that the browser has not committed to a set of encodings.
   * Asking earlier is how the previous implementation convinced itself
   * simulcast was on — it read back an empty list, took an early return,
   * and never looked again.
   */
  private confirmSimulcastStatus(): void {
    for (const [kind, entry] of this.published) {
      if (entry.simulcast !== 'pending' || !entry.sender) continue;

      const { status, rids } = confirmSimulcast(entry.sender);
      entry.simulcast = status;

      if (status === 'enabled') {
        this.logger.debug('simulcast active', `${kind}: ${rids.join(', ')}`);
        continue;
      }
      if (status === 'svc') {
        this.logger.debug('svc active', kind);
        continue;
      }

      this.logger.warn(
        `simulcast did not survive negotiation for the ${kind} track: the sender reports ` +
          `[${rids.join(', ')}], expected [${SIMULCAST_LAYERS.map((l) => l.rid).join(', ')}]. ` +
          'Every subscriber will receive the one layer being sent.',
      );
    }
  }

  /**
   * Gives a newly subscribed track its layer control.
   *
   * The controller is created for video only. An audio track has no spatial
   * layers, and observing the `<audio>` element it is attached to would
   * produce a stream of size changes that mean nothing.
   */
  private attachLayerControl(track: RemoteTrack, key: string): void {
    if (trackKindToMediaKind(track.kind) === 'audio') return;

    const controller = new AdaptiveStreamController({
      request: (layer) => this.requestLayer(track, layer, { automatic: true }),
      visibility: (visible) => this.setTrackHidden(track, !visible),
    });
    this.adaptiveControllers.set(key, controller);

    track.setLayerController({
      request: (layer, options) => this.requestLayer(track, layer, options ?? {}),
      observe: (element) => controller.observe(element),
      unobserve: (element) => controller.unobserve(element),
      setEnabled: (enabled) => this.setTrackEnabled(track, enabled),
      setVisible: (visible) => controller.setVisible(visible),
    });
  }

  /**
   * Asks the SFU for a particular layer of a subscribed track.
   *
   * Precedence, highest first:
   *
   * 1. **An explicit application request** (`automatic: false`). It pins
   *    the subscription: adaptive streaming will not move it afterwards.
   *    Requesting `auto` releases the pin.
   * 2. **Adaptive streaming** (`automatic: true`), when it is enabled and
   *    the track is not pinned. Driven by rendered element size.
   * 3. **The SFU's own choice** when neither has spoken: `auto`, which
   *    resolves to the best layer available.
   *
   * Whatever wins, it stays a preference. The SFU will not hand over a
   * layer the publisher is not sending, and congestion control may hold a
   * subscriber below what it asked for.
   *
   * `adaptiveStream` gates only rule 2. An explicit request works with
   * adaptive streaming off — that combination is exactly "I will manage
   * quality myself".
   *
   * Two pauses sit around those rules (§4, layer `off`).
   * `track.setEnabled(false)` beats all three. Adaptive streaming seeing
   * the track off screen beats only its own size choice — a pinned layer
   * is the application saying it wants this video, and is not second-
   * guessed. See {@link effectiveLayer}.
   */
  requestLayer(track: RemoteTrack, layer: VideoLayer, options: { automatic?: boolean } = {}): void {
    const subscription = this.findSubscription(track);
    if (!subscription) return;

    const key = subscriptionKey(subscription.participantId, subscription.trackId);

    if (options.automatic) {
      if (!this.adaptiveStream) return;
      // Remembered even while pinned, so releasing the pin lands on the
      // size the element actually is rather than on `auto`.
      if (layer !== 'auto') subscription.adaptiveLayer = layer;
    } else if (layer === 'auto') {
      this.pinnedLayers.delete(key);
    } else {
      this.pinnedLayers.set(key, layer);
    }

    this.sendEffectiveLayer(subscription);
  }

  /**
   * The one layer a subscription should be on, from everything that has a
   * say. Highest precedence first:
   *
   * 1. `setEnabled(false)` → `off`.
   * 2. A pinned layer.
   * 3. Adaptive streaming: `off` while hidden, else the size-chosen layer.
   * 4. `auto`.
   */
  private effectiveLayer(subscription: SubscribedTrack): SubscriptionLayer {
    const key = subscriptionKey(subscription.participantId, subscription.trackId);
    if (this.disabledTracks.has(key)) return 'off';
    const pinned = this.pinnedLayers.get(key);
    if (pinned) return pinned;
    if (this.adaptiveStream) {
      if (subscription.hidden) return 'off';
      if (subscription.adaptiveLayer) return subscription.adaptiveLayer;
    }
    return 'auto';
  }

  /**
   * Sends the effective layer if the SFU does not already have it.
   *
   * A tile laid out repeatedly at the same size is the normal case, not
   * the exception. Every redundant message is a step towards the
   * connection's signaling rate limit and buys nothing. "Nothing sent yet"
   * means whatever the SFU starts a subscription on: `auto`, or `off` for
   * video under `autoSubscribe: false`.
   */
  private sendEffectiveLayer(subscription: SubscribedTrack): void {
    if (trackKindToMediaKind(subscription.track.kind) === 'audio') return;
    const key = subscriptionKey(subscription.participantId, subscription.trackId);
    const layer = this.effectiveLayer(subscription);
    const current = this.sentLayers.get(key) ?? (this.autoSubscribe ? 'auto' : 'off');
    if (current === layer) return;
    this.sentLayers.set(key, layer);

    this.signaling?.send({
      type: ClientMessageType.SUBSCRIPTION_UPDATE,
      publisherId: subscription.participantId,
      trackId: subscription.trackId,
      layer,
    });
  }

  /** `RemoteTrack.setEnabled()`: an application pause that nothing automatic undoes. */
  private setTrackEnabled(track: RemoteTrack, enabled: boolean): void {
    const subscription = this.findSubscription(track);
    if (!subscription) return;
    const key = subscriptionKey(subscription.participantId, subscription.trackId);
    if (enabled) {
      this.disabledTracks.delete(key);
    } else {
      this.disabledTracks.add(key);
    }
    this.sendEffectiveLayer(subscription);
  }

  /** Adaptive streaming's visibility verdict, after its debounce. */
  private setTrackHidden(track: RemoteTrack, hidden: boolean): void {
    const subscription = this.findSubscription(track);
    if (!subscription || subscription.hidden === hidden) return;
    subscription.hidden = hidden;
    if (!this.adaptiveStream) return;
    this.sendEffectiveLayer(subscription);
  }

  /** The layer an application pinned for a subscribed track, if any. */
  pinnedLayer(track: RemoteTrack): VideoLayer | undefined {
    const subscription = this.findSubscription(track);
    if (!subscription) return undefined;
    return this.pinnedLayers.get(subscriptionKey(subscription.participantId, subscription.trackId));
  }

  private findSubscription(track: RemoteTrack): SubscribedTrack | undefined {
    for (const subscription of this.subscribed.values()) {
      if (subscription.track === track) return subscription;
    }
    return undefined;
  }

  /** The simulcast state of a kind this participant publishes. */
  simulcastStatus(kind: TrackKind): SimulcastStatus {
    return this.published.get(kind)?.simulcast ?? 'notApplicable';
  }

  // --- Data channel ------------------------------------------------------

  private attachDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      this.logger.debug('data channel open');
      this.settleDataChannel();
      this.flushDataQueue();
    };
    channel.onmessage = (event: MessageEvent) => this.handleIncomingData(event.data);
    channel.onclose = () => {
      if (this.dataChannel === channel) {
        this.dataChannel = undefined;
      }
    };

    // A channel that arrives already open (the SFU's own, or one restored
    // on a live connection) never fires `onopen` for us.
    if (channel.readyState === 'open') {
      this.settleDataChannel();
      this.flushDataQueue();
    }
  }

  /**
   * Sends a payload, waiting for the channel if it is still coming up.
   *
   * A data channel needs its own `m=application` section, which means a
   * round trip before the first byte can go anywhere. That used to be the
   * caller's problem: `sendData()` created the channel, negotiated
   * nothing, and threw "The data channel is not open yet" — so the only
   * way to make data work was to publish a camera first and let its
   * renegotiation carry the channel along. Now the bootstrap happens here.
   */
  async sendData(payload: Uint8Array<ArrayBuffer>, options: DataSendOptions = {}): Promise<void> {
    const topic = options.topic ?? '';
    const destinations = options.destinationIdentities ?? [];
    const askedLossy = options.reliable === false;
    let lossy = askedLossy;
    if (lossy && !this.supportsDataV2) {
      // An older SFU closes a channel it does not know, so the lossy one
      // would swallow everything. Reliable delivery is the safe superset.
      lossy = false;
      if (!this.lossyFallbackWarned) {
        this.lossyFallbackWarned = true;
        this.logger.warn('this server does not support lossy data (no data.v2); sending reliably instead');
      }
    }
    const limit = lossy ? MAX_LOSSY_PAYLOAD_BYTES : MAX_DATA_PAYLOAD_BYTES;
    if (payload.byteLength > limit) {
      throw new RTCError(
        'INVALID_ARGUMENT',
        `Data payload is ${payload.byteLength} bytes, over the ${limit}-byte ${lossy ? 'lossy ' : ''}limit`,
      );
    }
    // phase7-contracts §1.6: v2 envelopes whenever the room supports them
    // or any option asks for one. Neither means today's bytes, unchanged.
    let bytes: Uint8Array<ArrayBuffer> = payload;
    if (this.supportsDataV2 || topic.length > 0 || destinations.length > 0 || askedLossy) {
      try {
        bytes = encodeDataEnvelope(payload, { topic, destinationIdentities: destinations });
      } catch (error) {
        if (error instanceof DataEnvelopeError) {
          throw new RTCError('INVALID_ARGUMENT', error.message, error);
        }
        throw error;
      }
    }
    if (!this.pc && !this.signaling) {
      throw new RTCError('CONNECTION_FAILED', 'sendData() requires an active connection');
    }
    if (!this.mayOpenDataChannels()) {
      throw new RTCError('PERMISSION_DENIED', 'sendData() requires a token that grants publishData');
    }
    if (lossy) {
      this.sendLossy(bytes);
      return;
    }
    payload = bytes;

    const channel = this.dataChannel ?? this.openDataChannel();
    if (!channel) {
      throw new RTCError('CONNECTION_FAILED', 'sendData() requires an active connection');
    }

    if (channel.readyState === 'open') {
      this.sendOnChannel(channel, payload);
      return;
    }

    // Queued rather than rejected: the caller asked to send, and the only
    // thing missing is a round trip they should not have to know about.
    // Order is preserved, so two sends before the channel opens arrive in
    // the order they were made.
    this.dataQueue.push(payload);

    // Waits for the round trip the channel needs, not for a timer.
    await this.dataChannelOpened();
    this.flushDataQueue();
  }

  /**
   * Opens the data channel for a participant that only wants to receive.
   *
   * The SFU fans data out over each recipient's own channel, so somebody
   * who never sends has nothing to receive on. `Room` calls this the
   * moment an application listens for `dataReceived`, which is the only
   * honest signal that a channel is wanted — opening one for every
   * participant at join would cost an SCTP association on every call that
   * never sends a byte.
   */
  ensureDataChannel(): void {
    this.dataChannelWanted = true;
    if (!this.mayOpenDataChannels()) {
      // Remembered, not opened: without publishData the offer would be
      // refused and take the connection down with it. applyPermissions
      // opens it if the grant arrives later.
      this.logger.debug('data channel wanted, but the token does not grant publishData');
      return;
    }
    if (!this.dataChannel) {
      this.openDataChannel();
    }
    // Recipients get lossy messages on the lossy channel only if they have
    // one (otherwise the SFU falls back to `raven-data`), so a listener
    // opens both against a v2 server.
    if (this.supportsDataV2 && !this.lossyChannel) {
      this.openLossyChannel();
    }
  }

  /**
   * Decodes one incoming message (phase7-contracts §1.3). Legacy bytes and
   * a malformed v2 frame alike come through untouched with no sender. The
   * sender identity is the SFU's, never the sender's own claim; `''` is
   * the server, reported as no participant.
   */
  private handleIncomingData(data: unknown): void {
    const bytes = toUint8Array(data);
    if (!bytes) {
      return;
    }
    const decoded = decodeDataMessage(bytes);
    if (decoded.legacy) {
      this.emit('dataReceived', bytes, undefined, undefined);
      return;
    }
    const participant = decoded.senderIdentity ? this.remoteParticipants.get(decoded.senderIdentity) : undefined;
    this.emit('dataReceived', decoded.payload.slice(), participant, decoded.topic || undefined);
  }

  /** Fire-and-forget: lossy data is latest-wins, so nothing waits on it. */
  private sendLossy(bytes: Uint8Array): void {
    this.lossyChannelWanted = true;
    const channel = this.lossyChannel ?? this.openLossyChannel();
    if (!channel) {
      throw new RTCError('CONNECTION_FAILED', 'sendData() requires an active connection');
    }
    if (channel.readyState === 'open') {
      this.sendOnChannel(channel, bytes);
      return;
    }
    this.lossyQueue.push(bytes);
    if (this.lossyQueue.length > MAX_LOSSY_QUEUE) {
      this.lossyQueue.shift();
    }
  }

  private openLossyChannel(): RTCDataChannel | undefined {
    if (this.lossyChannel) {
      return this.lossyChannel;
    }
    const pc = this.pc ?? (this.signaling ? this.ensurePeerConnection() : undefined);
    if (!pc) {
      return undefined;
    }
    const channel = pc.createDataChannel(LOSSY_DATA_CHANNEL_LABEL, {
      ordered: false,
      maxRetransmits: 0,
      protocol: DATA_V2_PROTOCOL,
    });
    this.attachLossyChannel(channel);
    return channel;
  }

  private attachLossyChannel(channel: RTCDataChannel): void {
    this.lossyChannel = channel;
    channel.binaryType = 'arraybuffer';
    const flush = () => {
      const queued = this.lossyQueue;
      this.lossyQueue = [];
      for (const bytes of queued) {
        try {
          this.sendOnChannel(channel, bytes);
        } catch (error) {
          this.logger.debug('dropping a lossy data message', (error as Error).message);
        }
      }
    };
    channel.onopen = () => {
      this.logger.debug('lossy data channel open');
      flush();
    };
    channel.onmessage = (event: MessageEvent) => this.handleIncomingData(event.data);
    channel.onclose = () => {
      if (this.lossyChannel === channel) {
        this.lossyChannel = undefined;
      }
    };
    if (channel.readyState === 'open') {
      flush();
    }
  }

  /**
   * Creates the channel and asks for the renegotiation that carries it.
   *
   * Exactly once per connection: `dataChannel` is set synchronously here,
   * so two concurrent `sendData()` calls cannot both create one. A second
   * channel would be a second SCTP stream the SFU closes as unrecognised.
   *
   * The client creates it, not the server, because the client is the side
   * that knows it needs one. Ordered and reliable — the default, and what
   * anyone sending structured messages expects.
   */
  private openDataChannel(): RTCDataChannel | undefined {
    this.dataChannelWanted = true;
    const pc = this.pc ?? (this.signaling ? this.ensurePeerConnection() : undefined);
    if (!pc) {
      return undefined;
    }
    if (this.dataChannel) {
      return this.dataChannel;
    }

    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true, protocol: DATA_V2_PROTOCOL });
    this.attachDataChannel(channel);
    // Creating a channel needs an `m=application` section, which is a
    // local change like adding a track: the browser raises
    // `negotiationneeded` and the chain offers.
    return channel;
  }

  private flushDataQueue(): void {
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== 'open' || this.dataQueue.length === 0) {
      return;
    }
    const queued = this.dataQueue;
    this.dataQueue = [];
    for (const payload of queued) {
      this.sendOnChannel(channel, payload);
    }
  }

  private sendOnChannel(channel: RTCDataChannel, payload: Uint8Array): void {
    try {
      channel.send(payload as Uint8Array<ArrayBuffer>);
    } catch (error) {
      throw new RTCError('PERMISSION_DENIED', 'Could not send data; check the token grants publishData', error);
    }
  }

  // --- Devices -----------------------------------------------------------

  async getDevices(kind?: DeviceKind): Promise<DeviceInfo[]> {
    return listDevices(kind);
  }

  async setDevice(kind: DeviceKind, deviceId: string): Promise<void> {
    switch (kind) {
      case 'videoinput':
        return this.replaceDevice('camera', () => createCameraTrack({ deviceId }));
      case 'audioinput':
        return this.replaceDevice('microphone', () => createMicrophoneTrack({ deviceId }));
      case 'audiooutput':
        return this.setAudioOutput(deviceId);
      default:
        throw new RTCError('DEVICE_NOT_FOUND', `Unknown device kind "${String(kind)}"`);
    }
  }

  /**
   * Swaps the device behind a published track without renegotiating.
   *
   * `replaceTrack` is what makes it seamless. Transceiver, SSRC, and every
   * subscriber's view of the track all stay put, so nobody else in the
   * room notices a thing.
   */
  private async replaceDevice(kind: TrackKind, capture: () => Promise<LocalTrack>): Promise<void> {
    const entry = this.published.get(kind);
    if (!entry) {
      // Nothing published, so nothing to switch. Capturing and publishing
      // here would turn a device preference into a publish nobody asked
      // for.
      return;
    }

    const replacement = await capture();
    const previous = entry.track.mediaStreamTrack;
    await entry.delegate.replaceTrack(replacement.mediaStreamTrack);
    previous.stop();
  }

  /**
   * Points this room's remote audio at a different output device.
   *
   * `setSinkId` works per element, so this walks whatever elements each
   * remote audio track is attached to. Safari doesn't have `setSinkId` at
   * all. `Room.setSpeakerDevice()` checks and throws before we get here,
   * so an unsupported browser gets a real error instead of a silent no-op.
   */
  private async setAudioOutput(deviceId: string): Promise<void> {
    const failures: unknown[] = [];

    for (const subscription of this.subscribed.values()) {
      if (trackKindToMediaKind(subscription.track.kind) === 'video') {
        continue;
      }
      for (const element of subscription.track.detach()) {
        const withSink = element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
        try {
          await withSink.setSinkId?.(deviceId);
        } catch (error) {
          failures.push(error);
        }
        subscription.track.attach(element);
      }
    }

    if (failures.length > 0) {
      throw new RTCError('DEVICE_NOT_FOUND', 'Could not switch the audio output device', failures[0]);
    }
  }

  // --- End-to-end encryption (phase5-contracts §3) -----------------------

  /** Builds this connection's E2EE controller from the configured key provider. */
  private setupE2EE(): void {
    this.disposeE2EE();
    const options = this.e2eeOptions;
    if (!options) return;
    if (!isE2EESupported()) {
      this.logger.warn('this browser cannot encrypt media frames; end-to-end encryption is unavailable');
      return;
    }
    const factory = options.keyProvider as unknown as Partial<E2EEControllerFactory>;
    if (typeof factory.createController !== 'function') {
      throw new RTCError(
        'E2EE_REQUIRED',
        'config.e2ee.keyProvider must come from createSharedKeyProvider() or createKeyProvider()',
      );
    }
    const controller = factory.createController({
      worker: options.worker,
      log: (message) => this.logger.warn(message),
    });
    controller.setStateListener((participantId, direction, state) =>
      this.handleE2EEState(participantId, direction, state),
    );
    this.e2ee = controller;
  }

  private disposeE2EE(): void {
    this.e2ee?.dispose();
    this.e2ee = undefined;
    this.e2eeStates.clear();
  }

  /** On every join: whether the room requires E2EE, and the room id the passphrase is salted with. */
  private applyRoomE2EE(roomId: string, joinedE2EE: boolean): void {
    this.roomE2EE = this.roomE2EE || joinedE2EE;
    if (this.e2ee) {
      if (!this.roomE2EE) {
        this.logger.info('e2ee is configured but this room is not end-to-end encrypted; media is sent as usual');
      }
      void this.e2ee
        .start(this.e2eeRoomId || roomId, this.localParticipant.identity, this.roomE2EE)
        .catch((error: Error) => this.logger.error('could not load the e2ee keys', error.message));
    } else if (this.roomE2EE) {
      this.logger.warn(
        this.e2eeOptions
          ? 'this room is end-to-end encrypted but this browser cannot encrypt; publishing is disabled'
          : 'this room is end-to-end encrypted and no e2ee.keyProvider is configured; publishing is disabled',
      );
    }
  }

  /** The room requires E2EE. */
  get e2eeRequired(): boolean {
    return this.roomE2EE;
  }

  /** Whether this client is encrypting the media it sends (room requires it, and a controller exists). */
  get isE2EEActive(): boolean {
    return this.roomE2EE && this.e2ee !== undefined;
  }

  /**
   * An E2EE room never receives plaintext from this SDK: no key provider
   * means no publishing (§3.1).
   */
  private assertMayPublishMedia(): void {
    if (!this.roomE2EE || this.e2ee) return;
    if (this.e2eeOptions) {
      throw new RTCError(
        'E2EE_NOT_SUPPORTED',
        'This room is end-to-end encrypted and this browser cannot encrypt media frames (no RTCRtpScriptTransform or encoded insertable streams)',
      );
    }
    throw new RTCError(
      'E2EE_REQUIRED',
      'This room is end-to-end encrypted: configure e2ee: { keyProvider } in createRTCClient() to publish into it',
    );
  }

  private handleE2EEState(participantId: string, direction: 'encrypt' | 'decrypt', state: E2EEState): void {
    const participant: Participant | undefined =
      direction === 'encrypt' ? this.localParticipant : this.remoteParticipants.get(participantId);
    if (!participant) return;
    const key = `${direction}:${participantId}`;
    if (this.e2eeStates.get(key) === state) return;
    this.e2eeStates.set(key, state);
    this.emit('e2eeStateChanged', participant, state);
  }

  // --- Teardown ----------------------------------------------------------

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this._lastDisconnect = { reason: 'CLIENT_INITIATED' };
    this.cancelMediaRejoin();

    for (const entry of this.published.values()) {
      entry.track.mediaStreamTrack.onended = null;
      entry.track.mediaStreamTrack.stop();
    }
    this.published.clear();
    this.localParticipant.tracks.length = 0;

    // Leaving is not a blip: the intent to publish and to hold a data
    // channel both end here, so a later `connect()` starts clean rather
    // than resurrecting a previous call's tracks.
    this.dataChannelWanted = false;
    this.dataQueue = [];
    this.lossyChannelWanted = false;
    this.lossyQueue = [];
    this.negotiationNeeded = false;
    this.abortDataChannelWaiters('The room was left before the data channel could open');

    this.signaling?.close();
    this.teardownPeerConnection();
    this.disposeE2EE();

    this.remoteParticipants.clear();
    this.pendingAgentStates.clear();
    this.subscribed.clear();
    this.announcedTracks.clear();
    this.pendingMedia.clear();
    this.layerActivity.clear();
    this.disabledTracks.clear();
    this.resetRoomSignals();

    this.setConnectionState('disconnected');
  }

  /**
   * Ends a session the server closed on purpose. Like `disconnect()`, minus
   * the leave message: the server already knows, and the socket is gone.
   */
  private endSession(dataChannelReason: string): void {
    this.intentionalDisconnect = true;
    this.cancelMediaRejoin();
    for (const entry of this.published.values()) {
      entry.track.mediaStreamTrack.onended = null;
      entry.track.mediaStreamTrack.stop();
    }
    this.published.clear();
    this.localParticipant.tracks.length = 0;
    this.dataChannelWanted = false;
    this.dataQueue = [];
    this.lossyChannelWanted = false;
    this.lossyQueue = [];
    this.negotiationNeeded = false;
    this.abortDataChannelWaiters(dataChannelReason);
    this.teardownPeerConnection();
    this.disposeE2EE();
    this.layerActivity.clear();
    this.resetRoomSignals();
    this.setConnectionState('disconnected');
  }

  /**
   * Throws the PeerConnection away along with everything that only meant
   * something on it: every subscription (its receiver and track are dead)
   * and every announcement (the rejoin's room state re-announces whatever
   * is still published). Local publications are desired state and survive;
   * `restoreLocalPublications()` puts them on the replacement.
   *
   * Subscribers get `trackUnsubscribed` now and `trackSubscribed` again
   * when the media comes back. Without this, a rebuilt connection's
   * arriving tracks matched a subscription that still existed for the dead
   * one and were silently dropped, so remote video froze on the last frame
   * for the rest of the call.
   */
  private discardMediaConnection(): void {
    this.teardownPeerConnection();
    for (const [key, subscription] of this.subscribed) {
      this.subscribed.delete(key);
      this.adaptiveControllers.get(key)?.dispose();
      this.adaptiveControllers.delete(key);
      const participant = this.remoteParticipants.get(subscription.participantId);
      if (participant) {
        const index = participant.tracks.indexOf(subscription.track);
        if (index !== -1) {
          participant.tracks.splice(index, 1);
        }
        this.emit('trackUnsubscribed', subscription.track, participant);
      }
    }
    this.announcedTracks.clear();
    this.pendingMedia.clear();
    this.pendingSubscriptionStates.clear();
    // The chain may hold tasks for the old connection; they find no `pc`
    // or a new one and do nothing harmful, but a stale "offer scheduled"
    // flag would swallow the first negotiation on the new connection.
    this.negotiationScheduled = false;
    this.negotiationNeeded = false;
    this.iceRestartRequested = false;
  }

  /** Phase 6 §4.2. Unknown states and malformed frames are ignored, per the protocol rule. */
  private applyAgentState(participantId: unknown, raw: unknown): void {
    const state = parseAgentState(raw);
    if (typeof participantId !== 'string' || !state) {
      return;
    }
    const target: Participant | undefined =
      participantId === this.localParticipant.identity
        ? this.localParticipant
        : this.remoteParticipants.get(participantId);
    if (!target) {
      // Not in the roster yet. `ended` for someone we never saw is moot.
      if (state === 'ended') {
        this.pendingAgentStates.delete(participantId);
      } else {
        this.pendingAgentStates.set(participantId, state);
      }
      return;
    }
    if (target._setAgentState(state)) {
      this.emit('agentStateChanged', target, state);
    }
  }

  private applyPendingAgentState(participant: RemoteParticipant): void {
    const state = this.pendingAgentStates.get(participant.identity);
    if (state === undefined) {
      return;
    }
    this.pendingAgentStates.delete(participant.identity);
    if (participant._setAgentState(state)) {
      this.emit('agentStateChanged', participant, state);
    }
  }

  /** Drops a remote participant and their subscriptions, and says so. */
  private removeRemoteParticipant(participant: RemoteParticipant): void {
    this.remoteParticipants.delete(participant.identity);
    this.e2ee?.participantLeft(participant.identity);
    this.e2eeStates.delete(`decrypt:${participant.identity}`);
    // Their tracks leave with them. The PeerConnection fires
    // `onremovetrack` as well, but lean on that alone and the UI keeps
    // showing a departed participant's frozen last frame until the
    // browser gets round to it.
    for (const [key, subscription] of this.subscribed) {
      if (subscription.participantId === participant.identity) {
        this.subscribed.delete(key);
        this.adaptiveControllers.get(key)?.dispose();
        this.adaptiveControllers.delete(key);
        this.emit('trackUnsubscribed', subscription.track, participant);
      }
    }
    for (const [key, announcement] of this.announcedTracks) {
      if (announcement.participantId === participant.identity) {
        this.announcedTracks.delete(key);
      }
    }
    // Someone who left mid-sentence is not speaking any more, whether or
    // not the SFU's next speaker update has gone out yet.
    if (this._activeSpeakers.includes(participant)) {
      participant._setSpeaking(false, 0);
      this._activeSpeakers = this._activeSpeakers.filter((speaker) => speaker !== participant);
      this.emit('activeSpeakersChanged', [...this._activeSpeakers]);
    }
    this.emit('participantLeft', participant);
  }

  /**
   * Rebuilds the media connection after ICE failed while signaling stayed
   * up. The first attempt goes at once — ICE has already spent its own
   * timeout deciding — and later ones back off, jittered.
   */
  private scheduleMediaRejoin(): void {
    if (this.mediaRejoinTimer || this.intentionalDisconnect || !this.signaling) {
      return;
    }
    if (this.mediaRejoinAttempts >= MEDIA_REJOIN_MAX_ATTEMPTS) {
      this.logger.error(`media connection failed ${MEDIA_REJOIN_MAX_ATTEMPTS} times in a row; giving up`);
      this._lastDisconnect = {
        reason: 'CONNECTION_FAILED',
        error: new RTCError(
          'CONNECTION_FAILED',
          `The media connection could not be re-established after ${MEDIA_REJOIN_MAX_ATTEMPTS} attempts`,
        ),
      };
      this.abortDataChannelWaiters('The connection failed before the data channel could open');
      this.signaling.close();
      this.teardownPeerConnection();
      this.setConnectionState('failed');
      return;
    }

    this.mediaRejoinAttempts++;
    const delay =
      this.mediaRejoinAttempts === 1
        ? 0
        : Math.random() * Math.min(MEDIA_REJOIN_BASE_MS * 2 ** (this.mediaRejoinAttempts - 2), MEDIA_REJOIN_MAX_MS);
    this.logger.warn(
      `media connection failed; rejoining (attempt ${this.mediaRejoinAttempts}) in ${Math.round(delay)}ms`,
    );
    this.mediaRejoinTimer = setTimeout(() => {
      this.mediaRejoinTimer = undefined;
      if (this.intentionalDisconnect) {
        return;
      }
      // Clears the resume token as well, so a reconnect already under way
      // joins fresh instead of re-binding the dead session.
      this.awaitingResume = false;
      this.discardMediaConnection();
      this.signaling?.rejoin();
    }, delay);
  }

  private cancelMediaRejoin(): void {
    if (this.mediaRejoinTimer) {
      clearTimeout(this.mediaRejoinTimer);
      this.mediaRejoinTimer = undefined;
    }
  }

  /**
   * The device's network changed (see `SFUAdapter.handleNetworkChange`).
   *
   * A reconnect waiting out its backoff runs now. Otherwise, with a live
   * media connection, ICE is restarted: the candidate pair it was using
   * belonged to the old network, and waiting for ICE to notice costs the
   * call several seconds of silence. Harmless on a connection that turns
   * out to have been fine — one extra offer/answer.
   */
  handleNetworkChange(): void {
    if (this.intentionalDisconnect || !this.signaling) {
      return;
    }
    if (this.signaling.isReconnecting) {
      this.logger.info('network changed; reconnecting now');
      this.signaling.reconnectNow();
      return;
    }
    const pc = this.pc;
    if (!pc || pc.connectionState === 'closed') {
      return;
    }
    this.logger.info('network changed; restarting ICE');
    this.iceRestartRequested = true;
    this.negotiationNeeded = true;
    this.scheduleNegotiation();
  }

  /**
   * Applies a live permission change from the server (§1.4).
   *
   * Losing a publish right is not an error: the SFU has already
   * unpublished those tracks, so this stops the matching local
   * publications (releasing the device) and says so through
   * `localTrackUnpublished`, exactly as if the application had turned them
   * off. Gaining one needs nothing here: the next publish just works, on
   * the same connection.
   */
  /** Data channels need publishData: the API refuses the offer otherwise, and the SFU closes the channel. */
  private mayOpenDataChannels(): boolean {
    return this._permissions?.publishData === true;
  }

  private applyPermissions(raw: ServerPermissions): void {
    const permissions: ParticipantPermissions = {
      subscribe: raw.subscribe !== false,
      publish: raw.publish === true,
      publishAudio: raw.publishAudio === true,
      publishVideo: raw.publishVideo === true,
      publishScreen: raw.publishScreen === true,
      publishData: raw.publishData === true,
    };
    // Phase 7: an older server never sends it, and then the token's grant stands.
    const updateOwnMetadata =
      typeof raw.updateOwnMetadata === 'boolean' ? raw.updateOwnMetadata : this._permissions?.updateOwnMetadata;
    if (updateOwnMetadata !== undefined) {
      permissions.updateOwnMetadata = updateOwnMetadata;
    }
    this._permissions = permissions;
    this.logger.info('permissions updated by the server', JSON.stringify(permissions));

    // publishData granted mid-session: open what connect (or a listener)
    // would have opened had the token carried it from the start.
    if (permissions.publishData && this.pc) {
      if ((this.supportsDataV2 || this.dataChannelWanted) && !this.dataChannel) {
        this.openDataChannel();
      }
      if (this.supportsDataV2 && !this.lossyChannel) {
        this.openLossyChannel();
      }
    }

    // Screen-share gates on publishScreen, not publishVideo (agora-parity
    // audit, phase 2) — mirrors the SFU's own per-source check. Keyed off
    // the published map's own TrackKind, not the native MediaStreamTrack
    // kind, because camera and screen share are both natively "video" and
    // only the map key tells them apart on this side.
    const mayPublish = (kind: TrackKind, mediaKind: string) => {
      if (!permissions.publish) return false;
      switch (kind) {
        case 'microphone':
          return permissions.publishAudio;
        case 'camera':
          return permissions.publishVideo;
        case 'screenShare':
          return permissions.publishScreen;
        case 'screenShareAudio':
          // Screen share's own audio is still just audio (phase-7 §3).
          return permissions.publishAudio;
        default:
          return mediaKind === 'audio' ? permissions.publishAudio : permissions.publishVideo;
      }
    };

    for (const [kind, entry] of [...this.published]) {
      if (mayPublish(kind, entry.track.mediaStreamTrack.kind)) {
        continue;
      }
      this.logger.info('publish right withdrawn; stopping the local publication', kind);
      void this.withKindLock(kind, async () => {
        // Re-read under the lock: an unpublish already in flight wins.
        const current = this.published.get(kind);
        if (current) {
          await this.unpublish(current.track);
        }
      }).catch((error) => this.logger.debug('stopping a withdrawn publication failed', (error as Error).message));
    }

    this.emit('permissionsChanged', { ...permissions });
  }

  /**
   * The server muted one of our own tracks (§1.6). The SFU has stopped
   * forwarding it already; muting locally stops us spending bandwidth on
   * it and makes `track.isMuted` tell the truth.
   *
   * Unmuting stays the user's call. `enableMicrophone()` / `unmute()` work
   * as usual afterwards, and the server is told through the ordinary
   * `track.mute` message. A server *unmute* is not acted on: turning
   * somebody's microphone back on remotely is not something an SDK should
   * do behind its user's back.
   */
  private async applyServerMute(trackId: string): Promise<void> {
    for (const entry of this.published.values()) {
      if (entry.trackId !== trackId && entry.track.mediaStreamTrack.id !== trackId) {
        continue;
      }
      if (!entry.track.isMuted) {
        await entry.track.mute();
      }
      this.logger.info('a local track was muted by the server', entry.track.kind);
      this.emit('localTrackMutedByServer', entry.track);
      return;
    }
    this.logger.debug('server muted a track we do not publish', trackId);
  }

  private teardownPeerConnection(): void {
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {
        // Went with the connection already.
      }
      this.dataChannel = undefined;
    }
    if (this.lossyChannel) {
      try {
        this.lossyChannel.close();
      } catch {
        // Went with the connection already.
      }
      this.lossyChannel = undefined;
    }
    if (!this.pc) {
      return;
    }
    // Clear the handlers before closing, so a state change fired during
    // teardown doesn't get mistaken for a connection failure.
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ontrack = null;
    this.pc.ondatachannel = null;
    try {
      this.pc.close();
    } catch {
      // Already closed.
    }
    this.pc = undefined;
  }

  private setConnectionState(state: SdkConnectionState): void {
    if (this._connectionState === state) {
      return;
    }
    this._connectionState = state;
    this.emit('connectionStateChanged', state);
  }
}

/**
 * The track id in the `a=msid:` line of the m-section with this mid.
 *
 * `a=msid:<stream-id> <track-id>`; the stream-only form is legal and names
 * no track, and a section can carry no msid at all, so this returns
 * undefined rather than guessing. Read by mid rather than by scanning for
 * the first msid, because a participant publishing a camera and a screen
 * share has two video m-sections and picking the wrong one mislabels both.
 */
function msidTrackIdForMid(sdp: string, mid: string): string | undefined {
  // First chunk is the session section and has no m= line. Everything
  // after it is one media description.
  const sections = sdp.split(/\r?\nm=/).slice(1);
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    if (!lines.some((line) => line.trim() === `a=mid:${mid}`)) {
      continue;
    }
    const msid = lines.find((line) => line.startsWith('a=msid:'));
    const trackId = msid?.slice('a=msid:'.length).trim().split(/\s+/)[1];
    return trackId && trackId.length > 0 ? trackId : undefined;
  }
  return undefined;
}

function subscriptionKey(participantId: string, trackId: string): string {
  return `${participantId}/${trackId}`;
}

function pendingKey(trackId: string): string {
  return `media:${trackId}`;
}

/** SDK track kinds → the source names the wire protocol uses. */
function declaredSourceFor(kind: TrackKind): 'camera' | 'microphone' | 'screenShare' | 'screenShareAudio' | undefined {
  switch (kind) {
    case 'camera':
    case 'microphone':
    case 'screenShare':
    case 'screenShareAudio':
      return kind;
    default:
      return undefined;
  }
}

/**
 * Turns whatever a data channel handed us into bytes.
 *
 * Uses `Object.prototype.toString` instead of `instanceof`, because
 * `instanceof ArrayBuffer` comes back false for a buffer that crossed a
 * realm boundary. That's not a test-environment curiosity either: Web
 * Workers, iframes and a few bundler shims each bring their own
 * `ArrayBuffer`. An `instanceof` check in that situation silently drops
 * every single message.
 */
function toUint8Array(data: unknown): Uint8Array | undefined {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (ArrayBuffer.isView(data)) {
    // Respect the view's offset and length. A Uint8Array covering part of
    // a bigger buffer must not be read as the whole thing.
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (isArrayBufferLike(data)) {
    return new Uint8Array(data);
  }
  return undefined;
}

function isArrayBufferLike(value: unknown): value is ArrayBuffer {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/**
 * Reads which room this token was minted for.
 *
 * The token is a Swalvo JWT and its payload is readable, not secret. Same
 * information the server is going to act on. We decode it; we never trust
 * it. The server re-verifies the signature, and anything a client fiddles
 * with here only changes which room it *asks* for.
 */
function roomIdFromToken(token: string): string {
  const claims = decodeClaims(token);
  const roomId = claims?.rid;
  if (typeof roomId !== 'string' || roomId.length === 0) {
    throw new RTCError('INVALID_TOKEN', 'RTC token does not name a room');
  }
  return roomId;
}

/** The `perms` claim, when the token carries one. The server re-checks every action regardless. */
function permissionsFromToken(token: string): ParticipantPermissions | undefined {
  const perms = decodeClaims(token)?.perms as Record<string, unknown> | undefined;
  if (!perms || typeof perms !== 'object') {
    return undefined;
  }
  return {
    subscribe: perms.subscribe !== false,
    publish: perms.publish === true,
    publishAudio: perms.publishAudio === true,
    publishVideo: perms.publishVideo === true,
    // Agora-parity audit phase 2. A token minted before the grant existed
    // has no such claim: absent reads as false, same as every other
    // sub-flag here reads false on a missing/non-true value.
    publishScreen: perms.publishScreen === true,
    publishData: perms.publishData === true,
    // Phase 7 §2. Only reported when the token says, so a token minted
    // before the grant existed reads exactly as it always did.
    ...(typeof perms.updateOwnMetadata === 'boolean' ? { updateOwnMetadata: perms.updateOwnMetadata } : {}),
  };
}

function participantIdFromToken(token: string): string {
  const claims = decodeClaims(token);
  return typeof claims?.sub === 'string' ? claims.sub : '';
}

function decodeClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** @deprecated Renamed to {@link SwalvoAdapter}. */
export { SwalvoAdapter as RavenAdapter };
