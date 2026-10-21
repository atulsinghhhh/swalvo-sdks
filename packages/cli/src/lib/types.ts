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

export type ApiKeyStatus = 'ACTIVE' | 'REVOKED';

/** Environments isolate credentials and data within one project. */
export type Environment = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

export interface ApiKeySummary {
  id: string;
  projectId: string;
  publicId: string;
  name: string | null;
  /** Optional because a CLI may be newer than the API it is talking to. */
  environment?: Environment;
  status: ApiKeyStatus;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedApiKey {
  id: string;
  name: string | null;
  publicId: string;
  /** Optional because a CLI may be newer than the API it is talking to. */
  environment?: Environment;
  /** The only time the raw secret is visible. Not persisted, not logged, never shown again. */
  key: string;
  createdAt: string;
  warning: string;
}

export type RoomStatus = 'ACTIVE' | 'CLOSED';

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

export interface RoomWithLiveState {
  id: string;
  projectId: string;
  name: string;
  status: RoomStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * `null` means we couldn't ask the RTC server. Not the same thing as a
   * genuinely idle room, which reports `0`.
   */
  liveParticipantCount: number | null;
}

export interface RoomDetailWithLiveState extends RoomWithLiveState {
  liveParticipants: LiveParticipantInfo[] | null;
}

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export interface RtcTokenPermissions {
  join: boolean;
  subscribe: boolean;
  publish: boolean;
  publishAudio: boolean;
  publishVideo: boolean;
  publishScreen: boolean;
  publishData: boolean;
}

export interface IssuedRtcToken {
  id: string;
  token: string;
  endpoint: string;
  roomId: string;
  roomName: string;
  participantIdentity: string;
  permissions: RtcTokenPermissions;
  iceServers: IceServer[];
  telemetryUrl: string;
  expiresAt: string;
  createdAt: string;
}

export type DependencyStatus = 'up' | 'down';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  dependencies: {
    database: DependencyStatus;
    redis: DependencyStatus;
    sfu: DependencyStatus;
    turn: DependencyStatus;
  };
  signaling: {
    activeConnections: number;
    activeRooms: number;
    activeParticipants: number;
  };
}

export type ConnectionLifecycleState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'FAILED';

export interface ConnectionSummary {
  id: string;
  publicId: string;
  projectId: string;
  roomId: string | null;
  roomName: string;
  participantId: string | null;
  participantIdentity: string;
  state: ConnectionLifecycleState;
  disconnectReason: string | null;
  region: string | null;
  sdkVersion: string | null;
  platform: string | null;
  browser: string | null;
  networkType: string | null;
  iceConnectionState: string | null;
  signalingState: string | null;
  /** The SFU's own quality read: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'. */
  connectionQuality: string | null;
  rttMs: number | null;
  jitterMs: number | null;
  /** 0-100. An approximation, not an RFC 3550 figure. */
  packetLossPercent: number | null;
  bitrateBps: number | null;
  codec: string | null;
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

export interface ObservabilityOverview {
  range: string;
  activeRooms: number;
  activeParticipants: number;
  connections: number;
  connectionSuccessRate: number | null;
  reconnectionRate: number | null;
  averageConnectionDurationMs: number | null;
  errors: number;
}

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

// ---------------------------------------------------------------------------
// Chat (Phase 12)
//
// Worth noticing what these carry and what they don't: activity metadata,
// never message text. The CLI reads the same dashboard-facing endpoints the
// web dashboard does, and those pointedly don't return message contents
// (docs/security/chat.md#privacy). A `swalvo chat` command that dumped
// customers' messages into a terminal would be the wrong tool entirely.
// ---------------------------------------------------------------------------

export interface ChatOverview {
  range: string;
  conversations: number;
  messagesStored: number;
  activeConnections: number;
  messagesSent: number;
  messagesFailed: number;
  messagesFannedOut: number;
  connectionsOpened: number;
  connectionsFailed: number;
  rateLimited: number;
  messagesPerSecond: number;
  latency: {
    /** null means nothing was measured in this window. Not "zero milliseconds". */
    persistMs: number | null;
    fanoutMs: number | null;
    endToEndMs: number | null;
  };
  gateway: {
    gatewayId: string;
    activeConnections: number;
    subscribedRooms: number;
    subscribedChannels: number;
  };
}

export interface ChatConversationSummary {
  id: string;
  name: string;
  type: 'ROOM' | 'CHANNEL' | 'DIRECT';
  status: 'ACTIVE' | 'ARCHIVED';
  roomId: string | null;
  retentionDays: number | null;
  messageCount: number;
  memberCount: number;
  lastMessageAt: string | null;
  lastMessageSenderId: string | null;
  createdAt: string;
}

export interface ChatConnectionSummary {
  id: string;
  publicId: string;
  projectId: string;
  conversationId: string | null;
  userId: string;
  gatewayId: string;
  state: ConnectionLifecycleState;
  disconnectReason: string | null;
  sdkVersion: string | null;
  platform: string | null;
  messagesSent: number;
  connectedAt: string | null;
  disconnectedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatPresenceEntry {
  userId: string;
  status: 'online' | 'away' | 'offline';
}

// ---------------------------------------------------------------------------
// Live Streaming (Phase 14)
//
// Inspection and non-privileged lifecycle only, same rule as chat above.
// Minting host and viewer credentials is on purpose missing from the CLI;
// see commands/streams/index.ts.
// ---------------------------------------------------------------------------

export type LiveStreamStatus = 'CREATED' | 'STARTING' | 'LIVE' | 'ENDING' | 'ENDED';
export type LiveStreamVisibility = 'PUBLIC' | 'PRIVATE' | 'AUTHENTICATED';
export type LiveStreamHostRole = 'HOST' | 'CO_HOST';

export interface LiveStreamHostView {
  identity: string;
  role: LiveStreamHostRole;
  invitedAt: string;
}

export interface LiveStreamSummary {
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
  /** null means the SFU was unreachable. Not the same as a genuinely empty stream. */
  viewerCount: number | null;
  peakViewerCount: number;
  conversationId: string | null;
  chatRootMessageId: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RtcServerStatus = 'HEALTHY' | 'DRAINING' | 'UNHEALTHY';

/**
 * One RTC server in the fleet.
 *
 * The load figures are a snapshot from the node's last heartbeat, not live
 * truth, so read them next to `lastHeartbeatAt`. The resource gauges are
 * nullable because a node that's registered but not yet heartbeated has no
 * measurement to report, and zero would read as "idle" instead of
 * "unknown".
 */
export interface RtcServer {
  id: string;
  name: string;
  region: string;
  status: RtcServerStatus;
  publicHost: string;
  internalUrl: string;
  capacity: number;
  activeRooms: number;
  activeParticipants: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  networkInBps: number | null;
  networkOutBps: number | null;
  version: string | null;
  lastHeartbeatAt: string | null;
  registeredAt: string;
  updatedAt: string;
}

export interface RtcFleetMetrics {
  servers: number;
  healthyServers: number;
  drainingServers: number;
  unhealthyServers: number;
  activeRooms: number;
  activeParticipants: number;
  capacity: number;
}
