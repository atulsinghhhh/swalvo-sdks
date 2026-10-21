import type { LocalTrack, TrackKind } from '../../track';
import type { RemoteParticipant, LocalParticipant, Participant, ParticipantMetadataSnapshot } from '../../participant';
import type { RemoteTrack } from '../../track';
import type { SimulcastStatus } from './simulcast';
import type { RTCError } from '../../errors';
import type { E2EEState } from '../../e2ee/types';
import type { AgentState, TranscriptionSegment, TranscriptionState } from '../../transcription';

export type SdkConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

/**
 * A coarse quality signal, reported by the SFU. The client doesn't derive
 * it from raw stats; it's whatever the SFU itself computed. The SFU has by
 * far the better view: it sees loss and jitter on every leg of the room,
 * not just this one client's.
 *
 * `'unknown'` covers both "not connected yet" and "the SFU has nothing to
 * say", which is the honest answer either way — and the only answer from a
 * server that predates quality scoring
 * (docs/architecture/phase2-media-contracts.md §3).
 */
export type ConnectionQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

export type DeviceKind = 'videoinput' | 'audioinput' | 'audiooutput';

/**
 * Why a room ended up `disconnected` (or `failed`), passed to the Room's
 * `disconnected` event.
 *
 * - `CLIENT_INITIATED`: `room.leave()` was called.
 * - `REMOVED`: the server removed this participant (moderation API). The
 *   SDK does not reconnect.
 * - `ROOM_CLOSED`: the room was closed server-side. No reconnect.
 * - `TOKEN_EXPIRED`: the token expired and could not be refreshed, either
 *   because no `refreshToken` was configured or because it failed.
 * - `CONNECTION_FAILED`: the network, the server or a fatal signaling
 *   error ended the session and reconnecting did not (or could not) help.
 */
export type DisconnectReason = 'CLIENT_INITIATED' | 'REMOVED' | 'ROOM_CLOSED' | 'TOKEN_EXPIRED' | 'CONNECTION_FAILED';

/**
 * Something worth knowing that did not stop the call.
 *
 * - `TOKEN_EXPIRING`: the server says the token expires soon and no
 *   `refreshToken` is configured. If the server enforces expiry the session
 *   will end at `expiresAt`.
 * - `TOKEN_REFRESH_FAILED`: `refreshToken` threw, or the server refused the
 *   new token (`TOKEN_INVALID`). The session carries on under the old one.
 */
export type RTCWarningCode = 'TOKEN_EXPIRING' | 'TOKEN_REFRESH_FAILED';

export interface RTCWarning {
  code: RTCWarningCode;
  message: string;
  /** ISO timestamp the current token expires at, when the server said. */
  expiresAt?: string;
  cause?: unknown;
}

/**
 * What this participant may currently do, as the server last said.
 *
 * Starts from the token's own grants and changes live when the server
 * updates them (moderation, or a live-stream viewer promoted to the
 * stage). See `Room.permissions` and the `permissionsChanged` event.
 */
export interface ParticipantPermissions {
  subscribe: boolean;
  publish: boolean;
  publishAudio: boolean;
  publishVideo: boolean;
  /** Screen-share, independent of publishVideo (agora-parity audit, phase 2). */
  publishScreen: boolean;
  publishData: boolean;
  /**
   * Phase 7 §2: may call `localParticipant.setMetadata()` / `setAttributes()`.
   * Present only when the token or the server said; absent reads as false.
   */
  updateOwnMetadata?: boolean;
}

/** Which data channel a message used, or was throttled on (phase7-contracts §1). */
export type DataChannelKind = 'reliable' | 'lossy';

/** Options for `room.sendData()` (phase7-contracts §1.6). */
export interface DataSendOptions {
  /** Up to 255 UTF-8 bytes. Recipients get it as the `topic` argument of `dataReceived`. */
  topic?: string;
  /** Only these identities receive it (at most 64). Omit or leave empty to broadcast. Unknown identities are skipped. */
  destinationIdentities?: string[];
  /**
   * `false` sends on the unordered, no-retransmit channel: lower latency,
   * may drop, at most 1,200 bytes. For cursors and state where the latest
   * value wins. Defaults to true. Against a server without `data.v2` it
   * falls back to reliable, with a one-time warning.
   */
  reliable?: boolean;
}

/** Options for `room.enableScreenShare()`. */
export interface ScreenShareOptions {
  /**
   * Also capture and publish the shared tab's or system's audio, as a
   * `screenShareAudio` track (phase7-contracts §3). Only some browsers and
   * share types return audio (Chrome: a tab, or the screen on Windows and
   * ChromeOS); otherwise the share is video only.
   */
  audio?: boolean;
}

export interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: DeviceKind;
}

export interface SFUAdapterEventMap {
  connectionStateChanged: (state: SdkConnectionState) => void;
  participantJoined: (participant: RemoteParticipant) => void;
  participantLeft: (participant: RemoteParticipant) => void;
  trackPublished: (kind: TrackKind, participant: RemoteParticipant) => void;
  trackUnpublished: (kind: TrackKind, participant: RemoteParticipant) => void;
  trackSubscribed: (track: RemoteTrack, participant: RemoteParticipant) => void;
  trackUnsubscribed: (track: RemoteTrack, participant: RemoteParticipant) => void;
  /** Phase 11 addition. Lets a UI show a muted indicator without polling `track.isMuted`. */
  trackMuted: (kind: TrackKind, participant: RemoteParticipant) => void;
  trackUnmuted: (kind: TrackKind, participant: RemoteParticipant) => void;
  localTrackPublished: (track: LocalTrack) => void;
  localTrackUnpublished: (track: LocalTrack) => void;
  dataReceived: (payload: Uint8Array, participant?: RemoteParticipant, topic?: string) => void;
  /** Phase 7 §1.4: the SFU dropped some of our data messages over the rate limit. */
  dataThrottled: (channel: DataChannelKind) => void;
  /** Phase 7 §2: someone's metadata or attributes changed (the local participant included). */
  participantMetadataChanged: (participant: Participant, prev: ParticipantMetadataSnapshot) => void;
  mediaError: (error: Error) => void;
  /** The server changed this participant's permissions mid-session. */
  permissionsChanged: (permissions: ParticipantPermissions) => void;
  /** The server muted one of this participant's own published tracks. */
  localTrackMutedByServer: (track: LocalTrack) => void;
  /** Non-fatal conditions, such as a refused token refresh. */
  warning: (warning: RTCWarning) => void;
  /** The SFU's ordered active-speaker set changed (§2). Loudest first; empty when nobody is speaking. */
  activeSpeakersChanged: (speakers: Participant[]) => void;
  /** The SFU re-scored a participant's connection (§3). The local participant included. */
  connectionQualityChanged: (participant: Participant, quality: ConnectionQuality) => void;
  /** A subscribed track's forwarding state or layer changed (§4). */
  trackSubscriptionStateChanged: (track: RemoteTrack, participant: RemoteParticipant) => void;
  /** E2EE state for a participant changed (phase5-contracts §3.2): local = encrypting, remote = decrypting. */
  e2eeStateChanged: (participant: Participant, state: E2EEState) => void;
  /** Phase 6 §4.1: a live caption segment, interim or final. */
  transcriptionSegment: (segment: TranscriptionSegment) => void;
  /** Phase 6 §4.3: the room's transcription changed status. */
  transcriptionStateChanged: (state: TranscriptionState) => void;
  /** Phase 6 §4.2: an AI agent's state changed. */
  agentStateChanged: (participant: Participant, state: AgentState) => void;
}

/**
 * The boundary between the public Room API and whatever actually
 * implements the connection.
 *
 * This interface is the reason swapping LiveKit out for Swalvo's own SFU
 * didn't touch the public API. `Room` and `RTCClient` are written against
 * it, never against a particular implementation, so trading
 * `internal/sfu/livekit-adapter.ts` for `internal/sfu/swalvo-adapter.ts`
 * came down to one line in the default factory. It also lets tests drive
 * Room/Client logic through a fake adapter instead of a real browser and
 * WebRTC stack.
 */
export interface SFUAdapter {
  readonly connectionState: SdkConnectionState;
  readonly localParticipant: LocalParticipant;
  readonly remoteParticipants: Map<string, RemoteParticipant>;

  /** The SFU's own read on this connection's health right now. */
  getConnectionQuality(): ConnectionQuality;

  /**
   * The current active speakers, loudest first. Optional so an adapter
   * (or test double) that predates active-speaker detection still
   * satisfies this interface; `Room` then reports nobody speaking.
   */
  readonly activeSpeakers?: Participant[];

  /**
   * Live ICE and signaling state, where the implementation can see it.
   *
   * Optional, because not every adapter owns an `RTCPeerConnection` to read
   * it from. The LiveKit adapter didn't, which is why
   * `Room.getDiagnostics()` reported these as `undefined` for so long. The
   * native adapter does, so a bug report now carries the states that
   * actually explain a failed connection.
   */
  getIceConnectionState?(): string | undefined;
  getSignalingState?(): string | undefined;
  /**
   * The SFU's own view of the connection. It can disagree with the local
   * one, and that disagreement is frequently the entire diagnosis.
   */
  getRemoteConnectionState?(): { iceState?: string; peerState?: string };

  /**
   * Why the connection last went `disconnected` or `failed`, and the error
   * behind it if there was one. Read by `Room` when the state changes.
   *
   * Optional, so an adapter (or test double) that predates it still
   * satisfies this interface; `Room` then falls back to a generic reason.
   */
  readonly lastDisconnect?: { reason: DisconnectReason; error?: RTCError };

  /** The participant's current permissions, when known. */
  readonly permissions?: ParticipantPermissions;

  /**
   * Tells the adapter the device's network changed (a Wi-Fi → cellular
   * handover, say), so it can start recovering now instead of waiting for
   * a timeout. Optional; platform SDKs call it when they can observe
   * connectivity.
   */
  handleNetworkChange?(): void;

  connect(endpoint: string, token: string, iceServers?: RTCIceServer[]): Promise<void>;
  disconnect(): Promise<void>;

  on<E extends keyof SFUAdapterEventMap>(event: E, handler: SFUAdapterEventMap[E]): void;
  off<E extends keyof SFUAdapterEventMap>(event: E, handler: SFUAdapterEventMap[E]): void;

  /**
   * Whether a published kind is genuinely sending a simulcast ladder.
   *
   * Optional so an adapter that predates simulcast reporting, or a test
   * double that does not care, still satisfies this interface untouched.
   */
  simulcastStatus?(kind: TrackKind): SimulcastStatus;

  /** The room requires end-to-end encryption (token claim or `room.joined.e2ee`). Optional for older adapters. */
  readonly e2eeRequired?: boolean;
  /** This client is encrypting what it sends. Optional for older adapters. */
  readonly isE2EEActive?: boolean;

  enableCamera(enabled: boolean): Promise<LocalTrack | undefined>;
  enableMicrophone(enabled: boolean): Promise<LocalTrack | undefined>;
  enableScreenShare(enabled: boolean, options?: ScreenShareOptions): Promise<LocalTrack | undefined>;
  publish(track: LocalTrack): Promise<void>;
  unpublish(track: LocalTrack): Promise<void>;

  sendData(payload: Uint8Array<ArrayBuffer>, options?: DataSendOptions): Promise<void>;
  /**
   * Makes sure a data channel exists, for a participant that wants to
   * *receive* data.
   *
   * The SFU fans data out over each recipient's own channel, so a
   * participant with no channel cannot receive — and one is only created
   * on demand, because most calls never send a byte. Listening for
   * `dataReceived` is that demand.
   *
   * Optional so an adapter with no channel concept (or a test double)
   * satisfies this interface untouched.
   */
  ensureDataChannel?(): void;

  getDevices(kind?: DeviceKind): Promise<DeviceInfo[]>;
  /**
   * Phase 11 widened this from `'videoinput' | 'audioinput'` to the full
   * `DeviceKind`. Purely additive: every existing caller passing one of the
   * original two values carries on unaffected. What it buys is
   * `'audiooutput'`, i.e. speaker selection, on browsers that support
   * `setSinkId`.
   */
  setDevice(kind: DeviceKind, deviceId: string): Promise<void>;
}
