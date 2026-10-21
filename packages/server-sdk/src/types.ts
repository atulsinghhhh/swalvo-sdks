// Every shape here mirrors a real Control API response 1:1; see apps/api's
// controllers and DTOs. Nothing in this file is speculative.

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED';

export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export type RoomStatus = 'ACTIVE' | 'CLOSED';

export interface Room {
  id: string;
  projectId: string;
  name: string;
  status: RoomStatus;
  /** End-to-end encrypted media. Fixed at create; see `rooms.create({ e2ee })`. */
  e2ee?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LiveTrackInfo {
  sid: string;
  kind: 'audio' | 'video' | 'unknown';
  name: string;
  muted: boolean;
}

export interface LiveParticipantInfo {
  identity: string;
  joinedAt: string;
  tracks: LiveTrackInfo[];
}

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

/** Swalvo's own permission vocabulary. See docs/control-plane.md#rtc-tokens. */
export interface TokenPermissions {
  join?: boolean;
  subscribe?: boolean;
  publish?: boolean;
  publishAudio?: boolean;
  publishVideo?: boolean;
  /** Screen-share, independent of publishVideo (agora-parity audit, phase 2). */
  publishScreen?: boolean;
  publishData?: boolean;
  /**
   * May change its own metadata and attributes from the client
   * (`localParticipant.setMetadata()` / `setAttributes()`). Default false.
   * The server can always change them with `rooms.updateParticipant()`.
   */
  updateOwnMetadata?: boolean;
}

export interface CreateTokenParams {
  /** The room's ID, from `rooms.create()` or `rooms.list()`. Not its display name. */
  room: string;
  /** Unique within the room. Letters, numbers, "-", "_", "." only. */
  identity: string;
  permissions?: TokenPermissions;
  /** Token lifetime in seconds, 30 to 21600. Defaults to the API's own default. Always short-lived, never permanent. */
  expiresIn?: number;
  /** The participant's initial metadata, visible to everyone in the room. An opaque string, at most 4 KiB. */
  metadata?: string;
  /**
   * The participant's initial attributes, visible to everyone in the room:
   * at most 32 keys, keys up to 64 characters, values up to 1 KiB. They are
   * signed into the token, which rides in the signaling URL, so keep them small.
   */
  attributes?: Record<string, string>;
}

export interface IssuedToken {
  id: string;
  token: string;
  /** Where the client SDK connects to run the call. Forward it to `createRTCClient({ endpoint })` untouched. */
  endpoint: string;
  roomId: string;
  roomName: string;
  participantIdentity: string;
  permissions: TokenPermissions;
  iceServers: IceServer[];
  telemetryUrl: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * The Control API's own connection-record lifecycle (a stored `ConnectionSummary`
 * row, polled via `connections.list()`/`diagnostics()`), not a live
 * `RTCPeerConnection` state — hence the distinct name and the uppercase
 * values, which mirror the database enum 1:1. For the live, in-call state
 * on a joined room, see `ConnectionState` in `@swalvo/rtc` (lowercase;
 * driven by the browser's own `RTCPeerConnection.connectionState`). The two
 * are unrelated concepts that happen to share a name in casual conversation.
 */
export type ConnectionSummaryState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'FAILED';

export interface ConnectionSummary {
  id: string;
  publicId: string;
  projectId: string;
  roomId: string | null;
  roomName: string;
  participantId: string | null;
  participantIdentity: string;
  state: ConnectionSummaryState;
  disconnectReason: string | null;
  region: string | null;
  sdkVersion: string | null;
  platform: string | null;
  browser: string | null;
  networkType: string | null;
  iceConnectionState: string | null;
  signalingState: string | null;
  reconnectCount: number;
  startedAt: string;
  connectedAt: string | null;
  disconnectedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionEventEntry {
  id: string;
  type: string;
  data: Record<string, unknown> | null;
  timestamp: string;
}

export interface ConnectionDetail extends ConnectionSummary {
  events: ConnectionEventEntry[];
  errors: ErrorSummary[];
}

export type ErrorCategory =
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'TOKEN_ERROR'
  | 'SIGNALING_ERROR'
  | 'ICE_ERROR'
  | 'TURN_ERROR'
  | 'SFU_ERROR'
  | 'NETWORK_ERROR'
  | 'CLIENT_ERROR'
  | 'UNKNOWN_ERROR';

export interface ErrorSummary {
  id: string;
  publicId: string;
  projectId: string;
  connectionId: string | null;
  roomId: string | null;
  participantId: string | null;
  category: ErrorCategory;
  message: string;
  likelyCause: string | null;
  suggestedAction: string | null;
  sdkVersion: string | null;
  platform: string | null;
  timestamp: string;
}

export interface ErrorDetail extends ErrorSummary {
  connection: ConnectionSummary | null;
}

export type MetricsRange = '15m' | '1h' | '24h' | '7d';

export interface MetricsOverview {
  range: string;
  activeRooms: number;
  activeParticipants: number;
  connections: number;
  connectionSuccessRate: number | null;
  reconnectionRate: number | null;
  averageConnectionDurationMs: number | null;
  errors: number;
}

export type DependencyStatus = 'up' | 'down';

export interface ProjectDiagnostics {
  project: { id: string; name: string };
  api: 'up';
  authentication: 'ok';
  dependencies: {
    signaling: DependencyStatus;
    sfu: DependencyStatus;
    turn: DependencyStatus;
  };
  connections: { active: number };
}

export interface ListConnectionsParams {
  roomId?: string;
  state?: ConnectionSummaryState;
  limit?: number;
}

export interface ListErrorsParams {
  category?: ErrorCategory;
  connectionId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Chat (Phase 12)
// ---------------------------------------------------------------------------

export type ChatScope = 'chat:read' | 'chat:send' | 'chat:moderate' | 'chat:manage';
export type ChatMemberRole = 'MEMBER' | 'MODERATOR' | 'ADMIN';
export type ChatConversationType = 'ROOM' | 'CHANNEL' | 'DIRECT';
export type ChatMessageType = 'text' | 'system' | 'event' | 'attachment';

export interface CreateChatTokenParams {
  /** Your own user identity. Everything this token sends is attributed to it. */
  userId: string;
  /** Conversations the token may touch. Leave it out for every conversation the user belongs to. */
  conversations?: string[];
  /** Narrows the token below the user's role. Cannot grant anything the role lacks. */
  scopes?: ChatScope[];
  /** Lifetime in seconds. There's no such thing as a non-expiring chat token. */
  expiresIn?: number;
}

export interface IssuedChatToken {
  /** Hand this to the browser. Never send the project API key instead. */
  token: string;
  tokenId: string;
  userId: string;
  projectId: string;
  scopes: ChatScope[];
  conversations: string[];
  /** Pass it to `createChatClient({ chatUrl })`. The SDK never hardcodes a host. */
  chatUrl: string;
  apiUrl: string;
  expiresAt: string;
}

export interface CreateConversationParams {
  name: string;
  type?: ChatConversationType;
  /** Attach to an existing RTC room, giving that call a chat panel. */
  roomId?: string;
  retentionDays?: number;
  /**
   * IMPORTANT: a conversation created with no members is unreadable and
   * unwritable by every chat token, including one minted for whoever
   * "created" it — your project API key isn't itself a chat user, so
   * there's no creator identity to add automatically. List every userId
   * that should be able to connect (or call `addMember()` for each one
   * before minting their token).
   */
  members?: Array<{ userId: string; role?: ChatMemberRole }>;
  metadata?: Record<string, unknown>;
  /**
   * When true, a name collision returns the existing conversation instead
   * of throwing — including when two callers race to create the same
   * named conversation concurrently, which the normal "everyone joins by
   * conversation name" flow does on the very first try. `members` is
   * ignored on the fetched-existing path.
   */
  getOrCreate?: boolean;
}

export interface ChatConversation {
  id: string;
  publicId: string;
  projectId: string;
  roomId: string | null;
  name: string;
  type: ChatConversationType;
  status: 'ACTIVE' | 'ARCHIVED';
  retentionDays: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMember {
  id: string;
  conversationId: string;
  projectId: string;
  userId: string;
  role: ChatMemberRole;
  status: 'ACTIVE' | 'LEFT';
  joinedAt: string;
  leftAt: string | null;
}

export interface SendChatMessageParams {
  text?: string;
  /** Required. A server-side send has to name the user it's acting for. */
  senderId: string;
  type?: ChatMessageType;
  replyTo?: string;
  /** Idempotency key. Retrying with the same key returns the original message. */
  clientMessageId?: string;
  attachmentId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  conversationId: string;
  senderId: string;
  type: ChatMessageType;
  text: string | null;
  replyTo: string | null;
  threadRootId: string | null;
  clientMessageId: string | null;
  metadata: Record<string, unknown> | null;
  reactions: Array<{ emoji: string; count: number; userIds: string[] }>;
  edited: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface ListChatMessagesParams {
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. Cursor-based; never an offset. */
  before?: string;
  after?: string;
  senderId?: string;
  includeDeleted?: boolean;
}

export interface ChatMessagePage {
  data: ChatMessage[];
  nextCursor: string | null;
  previousCursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Live Streaming (Phase 14). Reuses Rooms, RTC Tokens and Chat underneath.
// A stream is never a third real-time system sitting alongside them.
// ---------------------------------------------------------------------------

export type LiveStreamStatus = 'CREATED' | 'STARTING' | 'LIVE' | 'ENDING' | 'ENDED';
export type LiveStreamVisibility = 'PUBLIC' | 'PRIVATE' | 'AUTHENTICATED';
export type LiveStreamHostRole = 'HOST' | 'CO_HOST';

export interface LiveStreamHostView {
  identity: string;
  role: LiveStreamHostRole;
  invitedAt: string;
}

export interface LiveStream {
  id: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  category: string | null;
  tags: string[];
  language: string | null;
  visibility: LiveStreamVisibility;
  metadata: Record<string, unknown> | null;
  status: LiveStreamStatus;
  hosts: LiveStreamHostView[];
  /** Live participants who aren't registered hosts. `null` means the SFU couldn't be reached, which is not the same as a genuine 0. */
  viewerCount: number | null;
  peakViewerCount: number;
  conversationId: string | null;
  /** The chat message viewer reactions attach to. */
  chatRootMessageId: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLiveStreamParams {
  title: string;
  /** Registered as this stream's HOST, the only identity a stream is created with. */
  hostIdentity: string;
  description?: string;
  /** A URL you host. Swalvo neither accepts nor stores thumbnail uploads. */
  thumbnailUrl?: string;
  category?: string;
  tags?: string[];
  language?: string;
  visibility?: LiveStreamVisibility;
  metadata?: Record<string, unknown>;
  /** ISO 8601. Swalvo won't auto-transition status at this time; call `start()` yourself. */
  scheduledAt?: string;
  /**
   * `RTC_ONLY` (default): viewers join over WebRTC. `BROADCAST`: viewers
   * watch the HLS playback URL instead and never join the room.
   */
  deliveryMode?: 'RTC_ONLY' | 'BROADCAST';
  /**
   * Cascade the real-time audience across edge rooms on other media nodes
   * once the origin room has its share, so one stream isn't capped by one
   * node. Cascaded viewers' credentials name a different `rtcRoom`, which
   * `LiveStream.join()` from `@swalvo/live` follows.
   */
  edgeScaling?: boolean;
}

/** Everything about a stream you might change before or during it. Never its status; `start()` and `end()` handle that. */
export interface UpdateLiveStreamParams {
  title?: string;
  description?: string;
  thumbnailUrl?: string;
  category?: string;
  tags?: string[];
  language?: string;
  visibility?: LiveStreamVisibility;
  metadata?: Record<string, unknown>;
}

export interface ListLiveStreamsParams {
  status?: LiveStreamStatus;
}

export interface AddHostParams {
  identity: string;
  /** HOST and CO_HOST get identical RTC and chat grants. The difference is bookkeeping, not permissions. Defaults to CO_HOST. */
  role?: LiveStreamHostRole;
}

export interface IssuedStreamCredential {
  /** The stream's id (`stream_...`). Forward this straight through to `LiveStream.join()` — no reassembly needed. */
  streamId: string;
  identity: string;
  role: LiveStreamHostRole | 'VIEWER';
  /** Absent on a BROADCAST viewer's playback credential (see `playback`). */
  rtc?: IssuedToken;
  chat?: IssuedChatToken;
  chatRootMessageId: string | null;
  /**
   * The RTC room to join: the stream id, or for a cascaded viewer of an
   * `edgeScaling` stream an edge room on another media node. Forwarded
   * as-is; `LiveStream.join()` reads it. Absent on a playback credential.
   */
  rtcRoom?: string;
  /** A BROADCAST viewer's HLS playback, when minted with `acceptPlayback`. `url` may 404 briefly while the stream starts. */
  playback?: {
    url: string | null;
    llhlsUrl?: string | null;
    status: string;
    /** Watch-time heartbeat for viewer-minute billing: pass it to the player untouched. */
    beacon?: { url: string; token: string; intervalSec: number };
  };
}

// ---------------------------------------------------------------------------
// Restream (RTMP out) and ingest (WHIP / RTMP in). Wire shapes are defined in
// docs/architecture/rtmp-contracts.md §6.
// ---------------------------------------------------------------------------

export type RestreamStatus = 'IDLE' | 'CONNECTING' | 'ACTIVE' | 'RETRYING' | 'FAILED' | 'STOPPED';

/**
 * One RTMP/RTMPS destination a stream is pushed to (YouTube, Twitch, ...).
 * The destination's stream key is stored encrypted and is never returned;
 * `keyLast4` is all you get back, for display.
 */
export interface RestreamView {
  /** `rst_...` */
  id: string;
  label: string | null;
  /** The ingest URL without the key, e.g. `rtmps://a.rtmp.youtube.com/live2`. */
  url: string;
  keyLast4: string;
  enabled: boolean;
  status: RestreamStatus;
  lastError: string | null;
  /** Consecutive failed connection attempts. Resets to 0 after 30 s of stable output. */
  attempts: number;
  connectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRestreamParams {
  /** `rtmp://` or `rtmps://` only, without the key. Private/loopback hosts are rejected. */
  url: string;
  /** The destination's stream key. Write-only: encrypted at rest, never returned. */
  streamKey: string;
  label?: string;
}

export interface UpdateRestreamParams {
  /** `false` pauses this destination mid-stream without deleting it. */
  enabled?: boolean;
  label?: string;
}

export type IngressProtocol = 'WHIP' | 'RTMP';
export type IngressStatus = 'IDLE' | 'CONNECTING' | 'PUBLISHING' | 'RECONNECTING' | 'DISCONNECTED' | 'FAILED';

export interface IngressInputVideo {
  codec: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  keyframeIntervalSec?: number;
}

export interface IngressInputAudio {
  codec: string;
  sampleRate?: number;
  channels?: number;
  bitrateKbps?: number;
}

/** A stream's single ingest endpoint (OBS, vMix, ffmpeg, a hardware encoder). */
export interface IngressView {
  /** `ing_...` */
  id: string;
  protocol: IngressProtocol;
  /** The host identity the encoder publishes as. Defaults to the stream's HOST, so OBS "takes over" a browser host. */
  identity: string;
  /** The first characters of the stream key, for display. The full key is only ever in `create()`/`reset()` responses. */
  keyPrefix: string;
  autoStart: boolean;
  status: IngressStatus;
  reconnectWindowSec: number;
  lastError: string | null;
  inputVideo: IngressInputVideo | null;
  inputAudio: IngressInputAudio | null;
  whipUrl: string;
  rtmpUrl: string;
  rtmpsUrl: string;
  connectedAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `IngressView` plus the full stream key (`sk_...`). Returned only by `create()` and `reset()` — store it then. */
export interface IngressWithKey extends IngressView {
  streamKey: string;
}

export interface CreateIngressParams {
  /** Defaults to `RTMP`. The key is the RTMP stream key or the WHIP bearer token. */
  protocol?: IngressProtocol;
  /** Must be a registered host of the stream. Defaults to the stream's HOST identity. */
  identity?: string;
  /** Start a CREATED stream automatically when the encoder connects. Defaults to `true`. */
  autoStart?: boolean;
  /** Seconds the room stays joined after the encoder drops, so a reconnect resumes seamlessly. Defaults to 60. */
  reconnectWindowSec?: number;
}

// --- AI: live transcription and voice agents (phase6-contracts.md) ----------

export type TranscriptionStatus = 'STARTING' | 'ACTIVE' | 'STOPPING' | 'ENDED' | 'FAILED';
export type AgentStatus = 'STARTING' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'ENDED' | 'FAILED';
/** Bring-your-own provider keys for one job. Never stored or logged by Swalvo. */
export type AiProviderKeys = Partial<Record<'deepgram' | 'openai' | 'anthropic' | 'cartesia' | 'elevenlabs', string>>;

export interface StartTranscriptionParams {
  /** Defaults to `en`. */
  language?: string;
  /** `deepgram` (default) or `openai`. */
  provider?: 'deepgram' | 'openai';
  model?: string | null;
  /** Only these identities. Default: every audio publisher. */
  participants?: string[];
  interimResults?: boolean;
  profanityFilter?: boolean;
  /** Store final segments as a transcript. Default `true`. */
  persist?: boolean;
  providerKeys?: AiProviderKeys;
}

export interface Transcription {
  id: string;
  roomId: string;
  status: TranscriptionStatus;
  language: string;
  provider: string;
  model: string | null;
  persist: boolean;
  participants: string[] | null;
  interimResults: boolean;
  profanityFilter: boolean;
  segmentCount: number;
  usageSeconds: number;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  error: string | null;
}

export interface TranscriptSegment {
  segmentId: string;
  participantId: string;
  text: string;
  language: string;
  /** Relative to the transcription's start. */
  startMs: number;
  endMs: number;
}

export interface TranscriptPage extends Transcription {
  segments: TranscriptSegment[];
  nextCursor: string | null;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  webhookUrl: string;
}

export interface CreateAgentParams {
  name: string;
  instructions: string;
  greeting?: string;
  llm?: { provider?: 'anthropic' | 'openai'; model?: string; temperature?: number; maxTokens?: number };
  stt?: { provider?: 'deepgram' | 'openai'; language?: string };
  tts?: { provider?: 'cartesia' | 'elevenlabs' | 'openai'; voice?: string };
  listenTo?: string[];
  turnDetection?: { silenceMs?: number };
  interruptible?: boolean;
  maxDurationSeconds?: number;
  tools?: AgentTool[];
  providerKeys?: AiProviderKeys;
}

export interface UpdateAgentParams {
  instructions?: string;
  listenTo?: string[];
  interruptible?: boolean;
}

export interface Agent {
  id: string;
  roomId: string;
  identity: string;
  name: string;
  status: AgentStatus;
  state: 'listening' | 'thinking' | 'speaking' | 'ended';
  instructions: string;
  listenTo: string[] | null;
  interruptible: boolean;
  llm: { provider: string; model: string; temperature: number; maxTokens: number };
  stt: { provider: string; language: string };
  tts: { provider: string; voice: string | null };
  tools: { name: string; description: string; webhookUrl: string }[];
  maxDurationSeconds: number;
  usage: { seconds: number; minutes: number };
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  error: string | null;
}

// --- Server moderation and participant metadata --------------------------

/** One of `trackId` (one track) or `kind` (every track of that kind) is required. */
export type MuteParticipantParams =
  | { trackId: string; kind?: 'audio' | 'video'; muted: boolean }
  | { trackId?: string; kind: 'audio' | 'video'; muted: boolean };

/** Any subset. A field left out is left as it is. */
export interface UpdateParticipantPermissionsParams {
  subscribe?: boolean;
  publish?: boolean;
  publishAudio?: boolean;
  publishVideo?: boolean;
  publishScreen?: boolean;
  publishData?: boolean;
  updateOwnMetadata?: boolean;
}

/** A connected participant's permissions, as `updateParticipantPermissions()` returns them. */
export interface LiveParticipantPermissions {
  subscribe: boolean;
  publish: boolean;
  publishAudio: boolean;
  publishVideo: boolean;
  publishScreen: boolean;
  publishData: boolean;
  updateOwnMetadata: boolean;
}

export interface UpdateParticipantParams {
  /** Replaces the metadata. At most 4 KiB. */
  metadata?: string;
  /** Merged into the attributes: a string sets a key, `null` deletes it, keys not named are kept. */
  attributes?: Record<string, string | null>;
}

export interface ParticipantMetadataResult {
  identity: string;
  metadata: string;
  attributes: Record<string, string>;
}

export interface SendDataOptions {
  /** Up to 255 bytes. Recipients see it as the message's topic. */
  topic?: string;
  /** Only these identities receive it (at most 64). Omit to send to everyone. */
  destinationIdentities?: string[];
  /** Default `true`, the reliable ordered channel. `false`: the lossy channel. */
  reliable?: boolean;
}
