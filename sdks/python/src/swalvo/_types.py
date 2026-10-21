"""Typed models mirroring the real Control API 1:1 (see apps/api's controllers/DTOs).

Response shapes are ``TypedDict`` (``total=False`` — every field optional for IDE
hinting; the API is the source of truth for what's actually present). Request
parameters are ``dataclasses`` with real defaults, since those are constructed
by the developer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, TypedDict

ProjectStatus = Literal["ACTIVE", "ARCHIVED"]
RoomStatus = Literal["ACTIVE", "CLOSED"]
ConnectionState = Literal["CONNECTING", "CONNECTED", "RECONNECTING", "DISCONNECTED", "FAILED"]
ErrorCategory = Literal[
    "AUTHENTICATION_ERROR",
    "AUTHORIZATION_ERROR",
    "TOKEN_ERROR",
    "SIGNALING_ERROR",
    "ICE_ERROR",
    "TURN_ERROR",
    "SFU_ERROR",
    "NETWORK_ERROR",
    "CLIENT_ERROR",
    "UNKNOWN_ERROR",
]
DependencyStatus = Literal["up", "down"]
MetricsRange = Literal["15m", "1h", "24h", "7d"]

# Chat (Phase 12). Scopes are the same four the web and TypeScript SDKs
# use — a team running a Python backend and a browser frontend should be
# reading one vocabulary, not two.
ChatScope = Literal["chat:read", "chat:send", "chat:moderate", "chat:manage"]
ChatMemberRole = Literal["MEMBER", "MODERATOR", "ADMIN"]
ChatMemberStatus = Literal["ACTIVE", "LEFT"]
ChatConversationType = Literal["ROOM", "CHANNEL", "DIRECT"]
ChatConversationStatus = Literal["ACTIVE", "ARCHIVED"]
ChatMessageType = Literal["text", "system", "event", "attachment"]


class Project(TypedDict, total=False):
    id: str
    name: str
    description: str | None
    status: ProjectStatus
    ownerId: str
    createdAt: str
    updatedAt: str


class Room(TypedDict, total=False):
    id: str
    projectId: str
    name: str
    status: RoomStatus
    e2ee: bool
    createdAt: str
    updatedAt: str


class LiveTrackInfo(TypedDict, total=False):
    sid: str
    kind: str
    name: str
    muted: bool


class LiveParticipantInfo(TypedDict, total=False):
    identity: str
    joinedAt: str
    tracks: list[LiveTrackInfo]


class IceServer(TypedDict, total=False):
    urls: str
    username: str
    credential: str


class IssuedToken(TypedDict, total=False):
    id: str
    token: str
    endpoint: str
    roomId: str
    roomName: str
    participantIdentity: str
    permissions: dict[str, bool]
    iceServers: list[IceServer]
    telemetryUrl: str
    expiresAt: str
    createdAt: str


class ConnectionSummary(TypedDict, total=False):
    id: str
    publicId: str
    projectId: str
    roomId: str | None
    roomName: str
    participantId: str | None
    participantIdentity: str
    state: ConnectionState
    disconnectReason: str | None
    region: str | None
    sdkVersion: str | None
    platform: str | None
    browser: str | None
    networkType: str | None
    iceConnectionState: str | None
    signalingState: str | None
    reconnectCount: int
    startedAt: str
    connectedAt: str | None
    disconnectedAt: str | None
    durationMs: int | None
    createdAt: str
    updatedAt: str


class ConnectionEventEntry(TypedDict, total=False):
    id: str
    type: str
    data: dict[str, Any] | None
    timestamp: str


class ErrorSummary(TypedDict, total=False):
    id: str
    publicId: str
    projectId: str
    connectionId: str | None
    roomId: str | None
    participantId: str | None
    category: ErrorCategory
    message: str
    likelyCause: str | None
    suggestedAction: str | None
    sdkVersion: str | None
    platform: str | None
    timestamp: str


class ConnectionDetail(ConnectionSummary, total=False):
    events: list[ConnectionEventEntry]
    errors: list[ErrorSummary]


class ErrorDetail(ErrorSummary, total=False):
    connection: ConnectionSummary | None


class MetricsOverview(TypedDict, total=False):
    range: str
    activeRooms: int
    activeParticipants: int
    connections: int
    connectionSuccessRate: float | None
    reconnectionRate: float | None
    averageConnectionDurationMs: int | None
    errors: int


class ProjectDiagnosticsDependencies(TypedDict, total=False):
    signaling: DependencyStatus
    sfu: DependencyStatus
    turn: DependencyStatus


class ProjectDiagnostics(TypedDict, total=False):
    project: dict[str, str]
    api: Literal["up"]
    authentication: Literal["ok"]
    dependencies: ProjectDiagnosticsDependencies
    connections: dict[str, int]


class IssuedChatToken(TypedDict, total=False):
    """What ``chat.create_token()`` returns.

    ``token`` is the only field that should reach a browser or a mobile
    app. It is scoped to one user, expires, and can be revoked — unlike
    the API key this SDK holds.
    """

    token: str
    tokenId: str
    userId: str
    projectId: str
    scopes: list[ChatScope]
    conversations: list[str]
    chatUrl: str
    apiUrl: str
    expiresAt: str


class ChatConversation(TypedDict, total=False):
    id: str
    publicId: str
    projectId: str
    roomId: str | None
    name: str
    type: ChatConversationType
    status: ChatConversationStatus
    retentionDays: int | None
    metadata: dict[str, Any] | None
    createdAt: str
    updatedAt: str


class ChatMember(TypedDict, total=False):
    id: str
    conversationId: str
    projectId: str
    userId: str
    role: ChatMemberRole
    status: ChatMemberStatus
    joinedAt: str
    leftAt: str | None


class ChatReaction(TypedDict, total=False):
    emoji: str
    count: int
    userIds: list[str]


class ChatMessage(TypedDict, total=False):
    id: str
    roomId: str
    conversationId: str
    senderId: str
    type: ChatMessageType
    text: str | None
    replyTo: str | None
    threadRootId: str | None
    clientMessageId: str | None
    metadata: dict[str, Any] | None
    reactions: list[ChatReaction]
    edited: bool
    deleted: bool
    createdAt: str
    updatedAt: str
    editedAt: str | None
    deletedAt: str | None


class ChatMessagePage(TypedDict, total=False):
    data: list[ChatMessage]
    nextCursor: str | None
    previousCursor: str | None
    hasMore: bool


@dataclass
class TokenPermissions:
    join: bool | None = None
    subscribe: bool | None = None
    publish: bool | None = None
    publish_audio: bool | None = None
    publish_video: bool | None = None
    publish_screen: bool | None = None
    """Screen-share, independent of publish_video (agora-parity audit, phase 2)."""
    publish_data: bool | None = None
    update_own_metadata: bool | None = None
    """May change its own metadata and attributes from the client. Default false."""

    def to_json(self) -> dict[str, bool]:
        mapping = {
            "join": self.join,
            "subscribe": self.subscribe,
            "publish": self.publish,
            "publishAudio": self.publish_audio,
            "publishVideo": self.publish_video,
            "publishScreen": self.publish_screen,
            "publishData": self.publish_data,
            "updateOwnMetadata": self.update_own_metadata,
        }
        return {key: value for key, value in mapping.items() if value is not None}


@dataclass
class CreateTokenParams:
    room: str
    """The room's ID (from ``rooms.create()``/``rooms.list()``) — not its display name."""
    identity: str
    """Unique within the room. Letters, numbers, "-", "_", "." only."""
    permissions: TokenPermissions | None = None
    expires_in: int | None = None
    """Token lifetime in seconds (30-21600). Defaults to the API's own default — always short-lived, never permanent."""
    metadata: str | None = None
    """The participant's initial metadata, visible to the whole room. An opaque string, at most 4 KiB."""
    attributes: dict[str, str] | None = None
    """The participant's initial attributes: at most 32 keys, keys up to 64 characters, values up to 1 KiB.
    Signed into the token, which rides in the signaling URL, so keep them small."""


class LiveParticipantPermissions(TypedDict, total=False):
    """A connected participant's permissions, as ``rooms.update_participant_permissions()`` returns them."""

    subscribe: bool
    publish: bool
    publishAudio: bool
    publishVideo: bool
    publishScreen: bool
    publishData: bool
    updateOwnMetadata: bool


class ParticipantMetadataResult(TypedDict, total=False):
    """What ``rooms.update_participant()`` returns: the resulting values."""

    identity: str
    metadata: str
    attributes: dict[str, str]


class SendDataResult(TypedDict, total=False):
    messageId: str


@dataclass
class ListConnectionsParams:
    room_id: str | None = None
    state: ConnectionState | None = None
    limit: int | None = None


@dataclass
class ListErrorsParams:
    category: ErrorCategory | None = None
    connection_id: str | None = None
    limit: int | None = None


@dataclass
class CreateChatTokenParams:
    """Parameters for minting a browser-safe chat token."""

    user_id: str
    """Your own user identity. Everything sent with this token is attributed to it.

    Take it from your *own* authenticated session — never from a value the
    client sent, or anyone can ask for a token as anyone.
    """
    conversations: list[str] | None = None
    """Conversation references this token may touch. Omit for every conversation the user belongs to."""
    scopes: list[ChatScope] | None = None
    """Narrows the token below the user's role. Can only remove permissions, never grant them."""
    expires_in: int | None = None
    """Lifetime in seconds (60-21600). There is no non-expiring chat token."""


@dataclass
class ConversationMember:
    user_id: str
    role: ChatMemberRole | None = None


@dataclass
class CreateConversationParams:
    name: str
    """Unique within the project. Doubles as a handle for ``connect({ room })``."""
    type: ChatConversationType | None = None
    room_id: str | None = None
    """Attach to an existing RTC room, giving that call a chat panel."""
    retention_days: int | None = None
    members: list[ConversationMember] | None = None
    metadata: dict[str, Any] | None = None
    get_or_create: bool | None = None
    """Return the existing conversation on a name collision instead of raising. ``members`` is ignored on that path."""


@dataclass
class SendChatMessageParams:
    sender_id: str
    """Required server-side — a backend send names the user it acts for."""
    text: str | None = None
    type: ChatMessageType | None = None
    reply_to: str | None = None
    client_message_id: str | None = None
    """Idempotency key. Retrying with the same key returns the original message."""
    attachment_id: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass
class ListChatMessagesParams:
    limit: int | None = None
    before: str | None = None
    """Opaque cursor from a previous page's ``nextCursor``. Cursor-based, never offset."""
    after: str | None = None
    """Walks forward toward newer messages — how a client catches up after a gap."""
    sender_id: str | None = None
    thread_root_id: str | None = None
    include_deleted: bool | None = None


# Live Streaming (Phase 14). A stream composes an RTC room and a chat
# conversation — these types mirror LiveStreamView/IssuedStreamCredential
# on the API side 1:1, the same reuse discipline as the resource itself.

LiveStreamStatus = Literal["CREATED", "STARTING", "LIVE", "ENDING", "ENDED"]
LiveStreamVisibility = Literal["PUBLIC", "PRIVATE", "AUTHENTICATED"]
LiveStreamHostRole = Literal["HOST", "CO_HOST"]


class LiveStreamHostView(TypedDict, total=False):
    identity: str
    role: LiveStreamHostRole
    invitedAt: str


class LiveStream(TypedDict, total=False):
    id: str
    title: str
    description: str | None
    thumbnailUrl: str | None
    category: str | None
    tags: list[str]
    language: str | None
    visibility: LiveStreamVisibility
    metadata: dict[str, Any] | None
    status: LiveStreamStatus
    hosts: list[LiveStreamHostView]
    viewerCount: int | None
    """``None`` means the SFU could not be reached — distinct from a genuinely empty stream (``0``)."""
    peakViewerCount: int
    conversationId: str | None
    chatRootMessageId: str | None
    scheduledAt: str | None
    startedAt: str | None
    endedAt: str | None
    createdAt: str
    updatedAt: str


class IssuedStreamCredential(TypedDict, total=False):
    """What ``add_host()``/``create_viewer_token()`` return.

    ``role`` reflects whichever method minted this credential — it is never
    a value the caller supplied.
    """

    identity: str
    role: str
    rtc: IssuedToken
    chat: IssuedChatToken


@dataclass
class CreateLiveStreamParams:
    title: str
    host_identity: str
    """Registered as this stream's HOST — the only identity a stream is created with."""
    description: str | None = None
    thumbnail_url: str | None = None
    """A URL you host — Swalvo does not accept or store thumbnail uploads."""
    category: str | None = None
    tags: list[str] | None = None
    language: str | None = None
    visibility: LiveStreamVisibility | None = None
    metadata: dict[str, Any] | None = None
    scheduled_at: str | None = None
    """ISO 8601. Swalvo does not auto-transition status at this time — call ``start()`` yourself."""
    delivery_mode: Literal["RTC_ONLY", "BROADCAST"] | None = None
    """``RTC_ONLY`` (default): viewers join over WebRTC. ``BROADCAST``: viewers watch HLS."""
    edge_scaling: bool | None = None
    """Cascade the real-time audience across edge rooms on other media nodes, so one stream isn't capped by one node."""


@dataclass
class UpdateLiveStreamParams:
    """Everything about a stream you might change before or during it — never its status; use ``start()``/``end()`` for that."""

    title: str | None = None
    description: str | None = None
    thumbnail_url: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    language: str | None = None
    visibility: LiveStreamVisibility | None = None
    metadata: dict[str, Any] | None = None


@dataclass
class AddHostParams:
    identity: str
    role: LiveStreamHostRole | None = None
    """HOST and CO_HOST get identical RTC/chat grants — the difference is bookkeeping, not permissions. Defaults to CO_HOST."""


# Restream (RTMP out) and ingest (WHIP / RTMP in). Wire shapes are defined in
# docs/architecture/rtmp-contracts.md section 6.

RestreamStatus = Literal["IDLE", "CONNECTING", "ACTIVE", "RETRYING", "FAILED", "STOPPED"]
IngressProtocol = Literal["WHIP", "RTMP"]
IngressStatus = Literal["IDLE", "CONNECTING", "PUBLISHING", "RECONNECTING", "DISCONNECTED", "FAILED"]


class RestreamView(TypedDict, total=False):
    """One RTMP/RTMPS destination. The destination's stream key is encrypted at rest and never returned — only ``keyLast4``."""

    id: str
    label: str | None
    url: str
    """The ingest URL without the key, e.g. ``rtmps://a.rtmp.youtube.com/live2``."""
    keyLast4: str
    enabled: bool
    status: RestreamStatus
    lastError: str | None
    attempts: int
    connectedAt: str | None
    createdAt: str
    updatedAt: str


class IngressInputVideo(TypedDict, total=False):
    codec: str
    width: int
    height: int
    fps: float
    bitrateKbps: int
    keyframeIntervalSec: float


class IngressInputAudio(TypedDict, total=False):
    codec: str
    sampleRate: int
    channels: int
    bitrateKbps: int


class IngressView(TypedDict, total=False):
    """A stream's single ingest endpoint. ``streamKey`` is present only in ``create()``/``reset()`` responses."""

    id: str
    protocol: IngressProtocol
    identity: str
    keyPrefix: str
    autoStart: bool
    status: IngressStatus
    reconnectWindowSec: int
    lastError: str | None
    inputVideo: IngressInputVideo | None
    inputAudio: IngressInputAudio | None
    whipUrl: str
    rtmpUrl: str
    rtmpsUrl: str
    connectedAt: str | None
    disconnectedAt: str | None
    createdAt: str
    updatedAt: str


class IngressWithKey(IngressView, total=False):
    streamKey: str
    """The full ``sk_...`` key — the RTMP stream key and the WHIP bearer token. Shown once; store it now."""


@dataclass
class CreateRestreamParams:
    url: str
    """``rtmp://`` or ``rtmps://`` only, without the key. Private/loopback hosts are rejected."""
    stream_key: str
    """Write-only: encrypted at rest, never returned."""
    label: str | None = None


@dataclass
class UpdateRestreamParams:
    enabled: bool | None = None
    """``False`` pauses this destination mid-stream without deleting it."""
    label: str | None = None


@dataclass
class CreateIngressParams:
    protocol: IngressProtocol | None = None
    """Defaults to ``RTMP``."""
    identity: str | None = None
    """Must be a registered host. Defaults to the stream's HOST identity, so the encoder "takes over" a browser host."""
    auto_start: bool | None = None
    """Start a CREATED stream automatically when the encoder connects. Defaults to ``True``."""
    reconnect_window_sec: int | None = None
    """Seconds the room stays joined after the encoder drops. Defaults to 60."""


__all__ = [
    "AddHostParams",
    "ChatConversation",
    "ChatConversationStatus",
    "ChatConversationType",
    "ChatMember",
    "ChatMemberRole",
    "ChatMemberStatus",
    "ChatMessage",
    "ChatMessagePage",
    "ChatMessageType",
    "ChatReaction",
    "ChatScope",
    "ConnectionDetail",
    "ConnectionEventEntry",
    "ConnectionState",
    "ConnectionSummary",
    "ConversationMember",
    "CreateChatTokenParams",
    "CreateConversationParams",
    "CreateIngressParams",
    "CreateLiveStreamParams",
    "CreateRestreamParams",
    "CreateTokenParams",
    "DependencyStatus",
    "ErrorCategory",
    "ErrorDetail",
    "ErrorSummary",
    "IceServer",
    "IngressInputAudio",
    "IngressInputVideo",
    "IngressProtocol",
    "IngressStatus",
    "IngressView",
    "IngressWithKey",
    "IssuedChatToken",
    "IssuedStreamCredential",
    "IssuedToken",
    "ListChatMessagesParams",
    "ListConnectionsParams",
    "ListErrorsParams",
    "LiveParticipantInfo",
    "LiveParticipantPermissions",
    "LiveStream",
    "LiveStreamHostRole",
    "LiveStreamHostView",
    "LiveStreamStatus",
    "LiveStreamVisibility",
    "LiveTrackInfo",
    "MetricsOverview",
    "MetricsRange",
    "ParticipantMetadataResult",
    "Project",
    "ProjectDiagnostics",
    "ProjectStatus",
    "RestreamStatus",
    "RestreamView",
    "Room",
    "RoomStatus",
    "SendChatMessageParams",
    "SendDataResult",
    "TokenPermissions",
    "UpdateLiveStreamParams",
    "UpdateRestreamParams",
]
