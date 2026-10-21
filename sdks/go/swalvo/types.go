package swalvo

import (
	"encoding/json"
	"errors"
)

// Every shape here mirrors packages/server-sdk/src/types.ts, which mirrors a
// real Control API response 1:1. Conventions:
//
//   - A TypeScript `T | null` response field is a pointer (*T), nil for null.
//   - An optional request field is a pointer or carries `omitempty`, so it is
//     left out of the JSON body exactly as the TS SDK leaves out `undefined`.
//   - `Record<string, unknown>` is map[string]any.
//
// String, Bool, Int and Float64 return pointers for optional fields.

// String returns a pointer to v.
func String(v string) *string { return &v }

// Bool returns a pointer to v.
func Bool(v bool) *bool { return &v }

// Int returns a pointer to v.
func Int(v int) *int { return &v }

// Float64 returns a pointer to v.
func Float64(v float64) *float64 { return &v }

// ---------------------------------------------------------------------------
// Projects and rooms
// ---------------------------------------------------------------------------

// ProjectStatus is ACTIVE or ARCHIVED.
type ProjectStatus string

const (
	ProjectStatusActive   ProjectStatus = "ACTIVE"
	ProjectStatusArchived ProjectStatus = "ARCHIVED"
)

// Project is the one project an API key belongs to.
type Project struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Description *string       `json:"description"`
	Status      ProjectStatus `json:"status"`
	OwnerID     string        `json:"ownerId"`
	CreatedAt   string        `json:"createdAt"`
	UpdatedAt   string        `json:"updatedAt"`
}

// RoomStatus is ACTIVE or CLOSED.
type RoomStatus string

const (
	RoomStatusActive RoomStatus = "ACTIVE"
	RoomStatusClosed RoomStatus = "CLOSED"
)

// Room is a control-plane room record.
type Room struct {
	ID        string     `json:"id"`
	ProjectID string     `json:"projectId"`
	Name      string     `json:"name"`
	Status    RoomStatus `json:"status"`
	// E2EE reports end-to-end encrypted media. Fixed at create.
	E2EE      *bool  `json:"e2ee,omitempty"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// CreateRoomParams is the body of rooms.create.
type CreateRoomParams struct {
	Name string `json:"name"`
	// GetOrCreate returns the existing room on a name collision instead of a
	// 409, which is what two participants racing to create the same room want.
	GetOrCreate bool `json:"getOrCreate,omitempty"`
	// E2EE makes the room end-to-end encrypted. Fixed for the room's life;
	// with GetOrCreate, a mismatch against an existing room is a 409.
	E2EE *bool `json:"e2ee,omitempty"`
}

// LiveTrackInfo is one published track on the SFU.
type LiveTrackInfo struct {
	SID   string `json:"sid"`
	Kind  string `json:"kind"` // "audio" | "video" | "unknown"
	Name  string `json:"name"`
	Muted bool   `json:"muted"`
}

// LiveParticipantInfo is one participant currently connected to the SFU.
type LiveParticipantInfo struct {
	Identity string          `json:"identity"`
	JoinedAt string          `json:"joinedAt"`
	Tracks   []LiveTrackInfo `json:"tracks"`
}

// TrackKind is the media kind a moderation mute targets.
type TrackKind string

const (
	TrackKindAudio TrackKind = "audio"
	TrackKindVideo TrackKind = "video"
)

// MuteParticipantParams is the input to Rooms.Participants.Mute. Set exactly
// one of TrackID and Kind; the SDK rejects both or neither before sending.
type MuteParticipantParams struct {
	// TrackID mutes exactly this track (a LiveTrackInfo.SID).
	TrackID string `json:"trackId,omitempty"`
	// Kind mutes every track of this kind the participant is publishing.
	Kind TrackKind `json:"kind,omitempty"`
	// Muted is true to mute, false to unmute. Always sent.
	Muted bool `json:"muted"`
}

// UpdateParticipantPermissionsParams is the input to
// Rooms.Participants.UpdatePermissions. Only the fields you set are sent
// (a set false is sent as false); a nil field is left as it is. At least one
// must be set.
type UpdateParticipantPermissionsParams struct {
	// Subscribe: losing it drops every track the participant is receiving.
	Subscribe *bool `json:"subscribe,omitempty"`
	// Publish: turning it on with neither PublishAudio nor PublishVideo named,
	// for a participant who has neither, allows both.
	Publish *bool `json:"publish,omitempty"`
	// PublishAudio has no effect without Publish.
	PublishAudio *bool `json:"publishAudio,omitempty"`
	// PublishVideo has no effect without Publish.
	PublishVideo *bool `json:"publishVideo,omitempty"`
	// PublishScreen (screen-share) has no effect without Publish, and is
	// independent of PublishVideo.
	PublishScreen *bool `json:"publishScreen,omitempty"`
	// PublishData covers data-channel messages.
	PublishData *bool `json:"publishData,omitempty"`
}

// ParticipantPermissions is a connected participant's merged live
// permissions, as returned by Rooms.Participants.UpdatePermissions.
type ParticipantPermissions struct {
	Subscribe     bool `json:"subscribe"`
	Publish       bool `json:"publish"`
	PublishAudio  bool `json:"publishAudio"`
	PublishVideo  bool `json:"publishVideo"`
	PublishScreen bool `json:"publishScreen"`
	PublishData   bool `json:"publishData"`
}

// ---------------------------------------------------------------------------
// RTC tokens
// ---------------------------------------------------------------------------

// ICEURLs holds an ICE server's urls. The TS type declares a string; the API
// may send a string or an array, and this accepts both. It encodes back as a
// plain string when it holds exactly one URL.
type ICEURLs []string

// UnmarshalJSON accepts a string or an array of strings.
func (u *ICEURLs) UnmarshalJSON(b []byte) error {
	var one string
	if err := json.Unmarshal(b, &one); err == nil {
		*u = ICEURLs{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return errors.New("swalvo: iceServers[].urls must be a string or an array of strings")
	}
	*u = many
	return nil
}

// MarshalJSON writes a single URL as a string, several as an array.
func (u ICEURLs) MarshalJSON() ([]byte, error) {
	if len(u) == 1 {
		return json.Marshal(u[0])
	}
	return json.Marshal([]string(u))
}

// IceServer is a STUN/TURN server for the browser's RTCPeerConnection.
type IceServer struct {
	URLs       ICEURLs `json:"urls"`
	Username   *string `json:"username,omitempty"`
	Credential *string `json:"credential,omitempty"`
}

// TokenPermissions is Swalvo's own permission vocabulary.
type TokenPermissions struct {
	Join          *bool `json:"join,omitempty"`
	Subscribe     *bool `json:"subscribe,omitempty"`
	Publish       *bool `json:"publish,omitempty"`
	PublishAudio  *bool `json:"publishAudio,omitempty"`
	PublishVideo  *bool `json:"publishVideo,omitempty"`
	PublishScreen *bool `json:"publishScreen,omitempty"`
	PublishData   *bool `json:"publishData,omitempty"`
}

// CreateTokenParams is the input to tokens.create.
type CreateTokenParams struct {
	// Room is the room's ID, from Rooms.Create or Rooms.List. Not its display name.
	Room string
	// Identity is unique within the room. Letters, numbers, "-", "_", "." only.
	Identity    string
	Permissions *TokenPermissions
	// ExpiresIn is the token lifetime in seconds, 30 to 21600. Zero uses the API default.
	ExpiresIn int
	Metadata  *string
}

// IssuedToken is a minted RTC token. Forward it to your frontend untouched.
type IssuedToken struct {
	ID    string `json:"id"`
	Token string `json:"token"`
	// Endpoint is where the client SDK connects. Forward it untouched.
	Endpoint            string           `json:"endpoint"`
	RoomID              string           `json:"roomId"`
	RoomName            string           `json:"roomName"`
	ParticipantIdentity string           `json:"participantIdentity"`
	Permissions         TokenPermissions `json:"permissions"`
	IceServers          []IceServer      `json:"iceServers"`
	TelemetryURL        string           `json:"telemetryUrl"`
	ExpiresAt           string           `json:"expiresAt"`
	CreatedAt           string           `json:"createdAt"`
}

// ---------------------------------------------------------------------------
// Connections, errors, metrics, diagnostics
// ---------------------------------------------------------------------------

// ConnectionSummaryState is the stored connection-record lifecycle, not a
// live RTCPeerConnection state.
type ConnectionSummaryState string

const (
	ConnectionConnecting   ConnectionSummaryState = "CONNECTING"
	ConnectionConnected    ConnectionSummaryState = "CONNECTED"
	ConnectionReconnecting ConnectionSummaryState = "RECONNECTING"
	ConnectionDisconnected ConnectionSummaryState = "DISCONNECTED"
	ConnectionFailed       ConnectionSummaryState = "FAILED"
)

// ConnectionSummary is one stored RTC connection record.
type ConnectionSummary struct {
	ID                  string                 `json:"id"`
	PublicID            string                 `json:"publicId"`
	ProjectID           string                 `json:"projectId"`
	RoomID              *string                `json:"roomId"`
	RoomName            string                 `json:"roomName"`
	ParticipantID       *string                `json:"participantId"`
	ParticipantIdentity string                 `json:"participantIdentity"`
	State               ConnectionSummaryState `json:"state"`
	DisconnectReason    *string                `json:"disconnectReason"`
	Region              *string                `json:"region"`
	SDKVersion          *string                `json:"sdkVersion"`
	Platform            *string                `json:"platform"`
	Browser             *string                `json:"browser"`
	NetworkType         *string                `json:"networkType"`
	IceConnectionState  *string                `json:"iceConnectionState"`
	SignalingState      *string                `json:"signalingState"`
	ReconnectCount      int                    `json:"reconnectCount"`
	StartedAt           string                 `json:"startedAt"`
	ConnectedAt         *string                `json:"connectedAt"`
	DisconnectedAt      *string                `json:"disconnectedAt"`
	DurationMs          *float64               `json:"durationMs"`
	CreatedAt           string                 `json:"createdAt"`
	UpdatedAt           string                 `json:"updatedAt"`
}

// ConnectionEventEntry is one event in a connection's history.
type ConnectionEventEntry struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	Data      map[string]any `json:"data"`
	Timestamp string         `json:"timestamp"`
}

// ConnectionDetail is a connection with its events and errors.
type ConnectionDetail struct {
	ConnectionSummary
	Events []ConnectionEventEntry `json:"events"`
	Errors []ErrorSummary         `json:"errors"`
}

// ErrorCategory classifies an RTC error.
type ErrorCategory string

const (
	ErrorCategoryAuthentication ErrorCategory = "AUTHENTICATION_ERROR"
	ErrorCategoryAuthorization  ErrorCategory = "AUTHORIZATION_ERROR"
	ErrorCategoryToken          ErrorCategory = "TOKEN_ERROR"
	ErrorCategorySignaling      ErrorCategory = "SIGNALING_ERROR"
	ErrorCategoryICE            ErrorCategory = "ICE_ERROR"
	ErrorCategoryTURN           ErrorCategory = "TURN_ERROR"
	ErrorCategorySFU            ErrorCategory = "SFU_ERROR"
	ErrorCategoryNetwork        ErrorCategory = "NETWORK_ERROR"
	ErrorCategoryClient         ErrorCategory = "CLIENT_ERROR"
	ErrorCategoryUnknown        ErrorCategory = "UNKNOWN_ERROR"
)

// ErrorSummary is one classified RTC error.
type ErrorSummary struct {
	ID              string        `json:"id"`
	PublicID        string        `json:"publicId"`
	ProjectID       string        `json:"projectId"`
	ConnectionID    *string       `json:"connectionId"`
	RoomID          *string       `json:"roomId"`
	ParticipantID   *string       `json:"participantId"`
	Category        ErrorCategory `json:"category"`
	Message         string        `json:"message"`
	LikelyCause     *string       `json:"likelyCause"`
	SuggestedAction *string       `json:"suggestedAction"`
	SDKVersion      *string       `json:"sdkVersion"`
	Platform        *string       `json:"platform"`
	Timestamp       string        `json:"timestamp"`
}

// ErrorDetail is an error with its connection.
type ErrorDetail struct {
	ErrorSummary
	Connection *ConnectionSummary `json:"connection"`
}

// MetricsRange is the window for Metrics.Get.
type MetricsRange string

const (
	MetricsRange15m MetricsRange = "15m"
	MetricsRange1h  MetricsRange = "1h"
	MetricsRange24h MetricsRange = "24h"
	MetricsRange7d  MetricsRange = "7d"
)

// MetricsOverview is the project's aggregate metrics.
type MetricsOverview struct {
	Range                       string   `json:"range"`
	ActiveRooms                 int      `json:"activeRooms"`
	ActiveParticipants          int      `json:"activeParticipants"`
	Connections                 int      `json:"connections"`
	ConnectionSuccessRate       *float64 `json:"connectionSuccessRate"`
	ReconnectionRate            *float64 `json:"reconnectionRate"`
	AverageConnectionDurationMs *float64 `json:"averageConnectionDurationMs"`
	Errors                      int      `json:"errors"`
}

// DependencyStatus is "up" or "down".
type DependencyStatus string

const (
	DependencyUp   DependencyStatus = "up"
	DependencyDown DependencyStatus = "down"
)

// ProjectDiagnostics is the project-scoped health report.
type ProjectDiagnostics struct {
	Project struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"project"`
	API            string `json:"api"`            // always "up"
	Authentication string `json:"authentication"` // always "ok"
	Dependencies   struct {
		Signaling DependencyStatus `json:"signaling"`
		SFU       DependencyStatus `json:"sfu"`
		TURN      DependencyStatus `json:"turn"`
	} `json:"dependencies"`
	Connections struct {
		Active int `json:"active"`
	} `json:"connections"`
}

// ListConnectionsParams filters Connections.List. Zero values are omitted.
type ListConnectionsParams struct {
	RoomID string
	State  ConnectionSummaryState
	Limit  int
}

// ListErrorsParams filters Errors.List. Zero values are omitted.
type ListErrorsParams struct {
	Category     ErrorCategory
	ConnectionID string
	Limit        int
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

// ChatScope is a chat token permission.
type ChatScope string

const (
	ChatScopeRead     ChatScope = "chat:read"
	ChatScopeSend     ChatScope = "chat:send"
	ChatScopeModerate ChatScope = "chat:moderate"
	ChatScopeManage   ChatScope = "chat:manage"
)

// ChatMemberRole is a member's role in a conversation.
type ChatMemberRole string

const (
	ChatRoleMember    ChatMemberRole = "MEMBER"
	ChatRoleModerator ChatMemberRole = "MODERATOR"
	ChatRoleAdmin     ChatMemberRole = "ADMIN"
)

// ChatConversationType is ROOM, CHANNEL or DIRECT.
type ChatConversationType string

const (
	ConversationRoom    ChatConversationType = "ROOM"
	ConversationChannel ChatConversationType = "CHANNEL"
	ConversationDirect  ChatConversationType = "DIRECT"
)

// ChatMessageType is text, system, event or attachment.
type ChatMessageType string

const (
	MessageText       ChatMessageType = "text"
	MessageSystem     ChatMessageType = "system"
	MessageEvent      ChatMessageType = "event"
	MessageAttachment ChatMessageType = "attachment"
)

// CreateChatTokenParams is the input to Chat.CreateToken.
type CreateChatTokenParams struct {
	// UserID is your own user identity. Everything the token sends is attributed to it.
	UserID string
	// Conversations the token may touch. Nil for every conversation the user belongs to.
	Conversations []string
	// Scopes narrows the token below the user's role. It cannot grant anything the role lacks.
	Scopes []ChatScope
	// ExpiresIn is the lifetime in seconds. Zero uses the API default.
	ExpiresIn int
}

// IssuedChatToken is a browser-safe chat token.
type IssuedChatToken struct {
	// Token goes to the browser. Never send the project API key instead.
	Token         string      `json:"token"`
	TokenID       string      `json:"tokenId"`
	UserID        string      `json:"userId"`
	ProjectID     string      `json:"projectId"`
	Scopes        []ChatScope `json:"scopes"`
	Conversations []string    `json:"conversations"`
	ChatURL       string      `json:"chatUrl"`
	APIURL        string      `json:"apiUrl"`
	ExpiresAt     string      `json:"expiresAt"`
}

// ChatMemberInput is one member to add when creating a conversation.
type ChatMemberInput struct {
	UserID string         `json:"userId"`
	Role   ChatMemberRole `json:"role,omitempty"`
}

// CreateConversationParams is the body of Chat.CreateConversation.
//
// IMPORTANT: a conversation created with no members is unreadable and
// unwritable by every chat token, since the project API key isn't itself a
// chat user. List every userId that should connect, or call AddMember.
type CreateConversationParams struct {
	Name          string               `json:"name"`
	Type          ChatConversationType `json:"type,omitempty"`
	RoomID        string               `json:"roomId,omitempty"`
	RetentionDays *int                 `json:"retentionDays,omitempty"`
	Members       []ChatMemberInput    `json:"members,omitempty"`
	Metadata      map[string]any       `json:"metadata,omitempty"`
	// GetOrCreate returns the existing conversation on a name collision
	// instead of an error. Members is ignored on that path.
	GetOrCreate bool `json:"getOrCreate,omitempty"`
}

// ListConversationsParams filters Chat.ListConversations.
type ListConversationsParams struct {
	// UserID limits the list to conversations that user actively belongs to.
	UserID          string
	IncludeArchived *bool
}

// AddMemberParams is the body of Chat.AddMember.
type AddMemberParams struct {
	UserID string         `json:"userId"`
	Role   ChatMemberRole `json:"role,omitempty"`
}

// ChatConversation is a chat conversation.
type ChatConversation struct {
	ID            string               `json:"id"`
	PublicID      string               `json:"publicId"`
	ProjectID     string               `json:"projectId"`
	RoomID        *string              `json:"roomId"`
	Name          string               `json:"name"`
	Type          ChatConversationType `json:"type"`
	Status        string               `json:"status"` // ACTIVE | ARCHIVED
	RetentionDays *int                 `json:"retentionDays"`
	Metadata      map[string]any       `json:"metadata"`
	CreatedAt     string               `json:"createdAt"`
	UpdatedAt     string               `json:"updatedAt"`
}

// ChatMember is a conversation membership.
type ChatMember struct {
	ID             string         `json:"id"`
	ConversationID string         `json:"conversationId"`
	ProjectID      string         `json:"projectId"`
	UserID         string         `json:"userId"`
	Role           ChatMemberRole `json:"role"`
	Status         string         `json:"status"` // ACTIVE | LEFT
	JoinedAt       string         `json:"joinedAt"`
	LeftAt         *string        `json:"leftAt"`
}

// SendChatMessageParams is the body of Chat.SendMessage.
type SendChatMessageParams struct {
	Text *string `json:"text,omitempty"`
	// SenderID is required: a server-side send has to name the user it acts for.
	SenderID string          `json:"senderId"`
	Type     ChatMessageType `json:"type,omitempty"`
	ReplyTo  string          `json:"replyTo,omitempty"`
	// ClientMessageID is an idempotency key: retrying with it returns the original message.
	ClientMessageID string         `json:"clientMessageId,omitempty"`
	AttachmentID    string         `json:"attachmentId,omitempty"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}

// ChatReaction is an aggregated reaction on a message.
type ChatReaction struct {
	Emoji   string   `json:"emoji"`
	Count   int      `json:"count"`
	UserIDs []string `json:"userIds"`
}

// ChatMessage is one chat message.
type ChatMessage struct {
	ID              string          `json:"id"`
	RoomID          string          `json:"roomId"`
	ConversationID  string          `json:"conversationId"`
	SenderID        string          `json:"senderId"`
	Type            ChatMessageType `json:"type"`
	Text            *string         `json:"text"`
	ReplyTo         *string         `json:"replyTo"`
	ThreadRootID    *string         `json:"threadRootId"`
	ClientMessageID *string         `json:"clientMessageId"`
	Metadata        map[string]any  `json:"metadata"`
	Reactions       []ChatReaction  `json:"reactions"`
	Edited          bool            `json:"edited"`
	Deleted         bool            `json:"deleted"`
	CreatedAt       string          `json:"createdAt"`
	UpdatedAt       string          `json:"updatedAt"`
	EditedAt        *string         `json:"editedAt"`
	DeletedAt       *string         `json:"deletedAt"`
}

// ListChatMessagesParams pages Chat.ListMessages. Cursor-based, never an offset.
type ListChatMessagesParams struct {
	Limit int
	// Before is an opaque cursor from a previous page's NextCursor.
	Before         string
	After          string
	SenderID       string
	IncludeDeleted bool
}

// ChatMessagePage is one page of history.
type ChatMessagePage struct {
	Data           []ChatMessage `json:"data"`
	NextCursor     *string       `json:"nextCursor"`
	PreviousCursor *string       `json:"previousCursor"`
	HasMore        bool          `json:"hasMore"`
}

// ---------------------------------------------------------------------------
// Live Streaming
// ---------------------------------------------------------------------------

// LiveStreamStatus is a stream's lifecycle state.
type LiveStreamStatus string

const (
	LiveStreamCreated  LiveStreamStatus = "CREATED"
	LiveStreamStarting LiveStreamStatus = "STARTING"
	LiveStreamLive     LiveStreamStatus = "LIVE"
	LiveStreamEnding   LiveStreamStatus = "ENDING"
	LiveStreamEnded    LiveStreamStatus = "ENDED"
)

// LiveStreamVisibility is PUBLIC, PRIVATE or AUTHENTICATED.
type LiveStreamVisibility string

const (
	VisibilityPublic        LiveStreamVisibility = "PUBLIC"
	VisibilityPrivate       LiveStreamVisibility = "PRIVATE"
	VisibilityAuthenticated LiveStreamVisibility = "AUTHENTICATED"
)

// LiveStreamHostRole is HOST or CO_HOST.
type LiveStreamHostRole string

const (
	RoleHost   LiveStreamHostRole = "HOST"
	RoleCoHost LiveStreamHostRole = "CO_HOST"
	// RoleViewer only ever appears on an IssuedStreamCredential.
	RoleViewer LiveStreamHostRole = "VIEWER"
)

// DeliveryMode is how a stream's audience watches.
type DeliveryMode string

const (
	// DeliveryRTCOnly (default): viewers join over WebRTC.
	DeliveryRTCOnly DeliveryMode = "RTC_ONLY"
	// DeliveryBroadcast: viewers watch the HLS playback URL and never join the room.
	DeliveryBroadcast DeliveryMode = "BROADCAST"
)

// LiveStreamHostView is one registered host.
type LiveStreamHostView struct {
	Identity  string             `json:"identity"`
	Role      LiveStreamHostRole `json:"role"`
	InvitedAt string             `json:"invitedAt"`
}

// LiveStreamDelivery is a stream's audience delivery view: the HLS playback
// state for a BROADCAST stream, NOT_APPLICABLE for RTC_ONLY. Returned as
// LiveStream.Delivery and by LiveStreams.Playback.
type LiveStreamDelivery struct {
	Mode DeliveryMode `json:"mode"`
	// Status: NOT_APPLICABLE | NOT_STARTED | STARTING | READY | FAILED | ENDED.
	Status      string  `json:"status"`
	PlaybackURL *string `json:"playbackUrl"`
	// LLHLSPlaybackURL is low-latency HLS (about 2 s); nil when unavailable.
	// Prefer it, fall back to PlaybackURL.
	LLHLSPlaybackURL *string `json:"llhlsPlaybackUrl"`
	// RecordingURL is set once the stream has ended, when HLS ran.
	RecordingURL         *string  `json:"recordingUrl"`
	RecordingDurationSec *float64 `json:"recordingDurationSec"`
}

// LiveStream is a live stream.
type LiveStream struct {
	ID           string               `json:"id"`
	Title        string               `json:"title"`
	Description  *string              `json:"description"`
	ThumbnailURL *string              `json:"thumbnailUrl"`
	Category     *string              `json:"category"`
	Tags         []string             `json:"tags"`
	Language     *string              `json:"language"`
	Visibility   LiveStreamVisibility `json:"visibility"`
	Metadata     map[string]any       `json:"metadata"`
	Status       LiveStreamStatus     `json:"status"`
	Hosts        []LiveStreamHostView `json:"hosts"`
	// ViewerCount is nil when the SFU couldn't be reached, which is not a genuine 0.
	ViewerCount     *int `json:"viewerCount"`
	PeakViewerCount int  `json:"peakViewerCount"`
	// Delivery is the audience delivery view (HLS playback URLs for BROADCAST).
	Delivery       *LiveStreamDelivery `json:"delivery,omitempty"`
	ConversationID *string             `json:"conversationId"`
	// ChatRootMessageID is the chat message viewer reactions attach to.
	ChatRootMessageID *string `json:"chatRootMessageId"`
	ScheduledAt       *string `json:"scheduledAt"`
	StartedAt         *string `json:"startedAt"`
	EndedAt           *string `json:"endedAt"`
	CreatedAt         string  `json:"createdAt"`
	UpdatedAt         string  `json:"updatedAt"`
}

// CreateLiveStreamParams is the body of LiveStreams.Create.
type CreateLiveStreamParams struct {
	Title string `json:"title"`
	// HostIdentity is registered as the stream's HOST.
	HostIdentity string `json:"hostIdentity"`
	Description  string `json:"description,omitempty"`
	// ThumbnailURL is a URL you host. Swalvo neither accepts nor stores uploads.
	ThumbnailURL string               `json:"thumbnailUrl,omitempty"`
	Category     string               `json:"category,omitempty"`
	Tags         []string             `json:"tags,omitempty"`
	Language     string               `json:"language,omitempty"`
	Visibility   LiveStreamVisibility `json:"visibility,omitempty"`
	Metadata     map[string]any       `json:"metadata,omitempty"`
	// ScheduledAt is ISO 8601. Swalvo won't auto-start at this time.
	ScheduledAt  string       `json:"scheduledAt,omitempty"`
	DeliveryMode DeliveryMode `json:"deliveryMode,omitempty"`
	// EdgeScaling cascades the real-time audience across edge rooms on other media nodes.
	EdgeScaling *bool `json:"edgeScaling,omitempty"`
}

// UpdateLiveStreamParams is everything you might change about a stream. Never
// its status: Start and End handle that.
type UpdateLiveStreamParams struct {
	Title        *string              `json:"title,omitempty"`
	Description  *string              `json:"description,omitempty"`
	ThumbnailURL *string              `json:"thumbnailUrl,omitempty"`
	Category     *string              `json:"category,omitempty"`
	Tags         []string             `json:"tags,omitempty"`
	Language     *string              `json:"language,omitempty"`
	Visibility   LiveStreamVisibility `json:"visibility,omitempty"`
	Metadata     map[string]any       `json:"metadata,omitempty"`
}

// ListLiveStreamsParams filters LiveStreams.List.
type ListLiveStreamsParams struct {
	Status LiveStreamStatus
}

// AddHostParams is the body of LiveStreams.AddHost.
type AddHostParams struct {
	Identity string `json:"identity"`
	// Role defaults to CO_HOST. HOST and CO_HOST get identical grants.
	Role LiveStreamHostRole `json:"role,omitempty"`
}

// ViewerTokenOptions configures LiveStreams.CreateViewerToken.
type ViewerTokenOptions struct {
	// AcceptPlayback: your client can play HLS, so a BROADCAST stream returns
	// a playback credential (chat + Playback.URL) instead of a 409.
	AcceptPlayback bool
}

// StagePromoteOptions configures LiveStreams.Stage.Promote.
type StagePromoteOptions struct {
	// Role defaults to CO_HOST.
	Role LiveStreamHostRole
}

// StreamPlayback is a BROADCAST viewer's HLS playback on a credential.
type StreamPlayback struct {
	// URL may 404 briefly while the stream starts.
	URL      *string `json:"url"`
	LLHLSURL *string `json:"llhlsUrl,omitempty"`
	Status   string  `json:"status"`
	// Beacon is the player's watch-time heartbeat (viewer-minute billing).
	// Forward the credential to the client untouched so the SDK player gets it.
	Beacon *PlaybackBeacon `json:"beacon,omitempty"`
}

// PlaybackBeacon is where an SDK player reports watch time while playing.
type PlaybackBeacon struct {
	URL         string `json:"url"`
	Token       string `json:"token"`
	IntervalSec int    `json:"intervalSec"`
}

// IssuedStreamCredential is a host's or viewer's credentials for a stream.
type IssuedStreamCredential struct {
	// StreamID is forwarded straight through to LiveStream.join() on the client.
	StreamID string             `json:"streamId"`
	Identity string             `json:"identity"`
	Role     LiveStreamHostRole `json:"role"` // HOST | CO_HOST | VIEWER
	// RTC is absent on a BROADCAST viewer's playback credential.
	RTC               *IssuedToken     `json:"rtc,omitempty"`
	Chat              *IssuedChatToken `json:"chat,omitempty"`
	ChatRootMessageID *string          `json:"chatRootMessageId"`
	// RTCRoom is the stream's public id. Edge placement for a cascaded
	// viewer is carried by the RTC token itself, never here. Absent on a
	// playback credential.
	RTCRoom string `json:"rtcRoom,omitempty"`
	// Playback is set on a BROADCAST viewer's credential minted with AcceptPlayback.
	Playback *StreamPlayback `json:"playback,omitempty"`
}

// RestreamStatus is a restream destination's state.
type RestreamStatus string

const (
	RestreamIdle       RestreamStatus = "IDLE"
	RestreamConnecting RestreamStatus = "CONNECTING"
	RestreamActive     RestreamStatus = "ACTIVE"
	RestreamRetrying   RestreamStatus = "RETRYING"
	RestreamFailed     RestreamStatus = "FAILED"
	RestreamStopped    RestreamStatus = "STOPPED"
)

// RestreamView is one RTMP/RTMPS destination. Its stream key is never returned.
type RestreamView struct {
	ID    string  `json:"id"`
	Label *string `json:"label"`
	// URL is the ingest URL without the key.
	URL       string         `json:"url"`
	KeyLast4  string         `json:"keyLast4"`
	Enabled   bool           `json:"enabled"`
	Status    RestreamStatus `json:"status"`
	LastError *string        `json:"lastError"`
	// Attempts is consecutive failed connection attempts.
	Attempts    int     `json:"attempts"`
	ConnectedAt *string `json:"connectedAt"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

// CreateRestreamParams is the body of LiveStreams.Restreams.Create.
type CreateRestreamParams struct {
	// URL is rtmp:// or rtmps:// only, without the key.
	URL string `json:"url"`
	// StreamKey is write-only: encrypted at rest, never returned.
	StreamKey string `json:"streamKey"`
	Label     string `json:"label,omitempty"`
}

// UpdateRestreamParams is the body of LiveStreams.Restreams.Update.
type UpdateRestreamParams struct {
	// Enabled false pauses the destination mid-stream without deleting it.
	Enabled *bool   `json:"enabled,omitempty"`
	Label   *string `json:"label,omitempty"`
}

// IngressProtocol is WHIP or RTMP.
type IngressProtocol string

const (
	IngressWHIP IngressProtocol = "WHIP"
	IngressRTMP IngressProtocol = "RTMP"
)

// IngressStatus is an ingest endpoint's state.
type IngressStatus string

const (
	IngressIdle         IngressStatus = "IDLE"
	IngressConnecting   IngressStatus = "CONNECTING"
	IngressPublishing   IngressStatus = "PUBLISHING"
	IngressReconnecting IngressStatus = "RECONNECTING"
	IngressDisconnected IngressStatus = "DISCONNECTED"
	IngressFailed       IngressStatus = "FAILED"
)

// IngressInputVideo is the encoder's observed video input.
type IngressInputVideo struct {
	Codec               string   `json:"codec"`
	Width               *int     `json:"width,omitempty"`
	Height              *int     `json:"height,omitempty"`
	FPS                 *float64 `json:"fps,omitempty"`
	BitrateKbps         *float64 `json:"bitrateKbps,omitempty"`
	KeyframeIntervalSec *float64 `json:"keyframeIntervalSec,omitempty"`
}

// IngressInputAudio is the encoder's observed audio input.
type IngressInputAudio struct {
	Codec       string   `json:"codec"`
	SampleRate  *int     `json:"sampleRate,omitempty"`
	Channels    *int     `json:"channels,omitempty"`
	BitrateKbps *float64 `json:"bitrateKbps,omitempty"`
}

// IngressView is a stream's single ingest endpoint.
type IngressView struct {
	ID       string          `json:"id"`
	Protocol IngressProtocol `json:"protocol"`
	// Identity is the host identity the encoder publishes as.
	Identity string `json:"identity"`
	// KeyPrefix is the first characters of the stream key, for display.
	KeyPrefix          string             `json:"keyPrefix"`
	AutoStart          bool               `json:"autoStart"`
	Status             IngressStatus      `json:"status"`
	ReconnectWindowSec int                `json:"reconnectWindowSec"`
	LastError          *string            `json:"lastError"`
	InputVideo         *IngressInputVideo `json:"inputVideo"`
	InputAudio         *IngressInputAudio `json:"inputAudio"`
	WhipURL            string             `json:"whipUrl"`
	RtmpURL            string             `json:"rtmpUrl"`
	RtmpsURL           string             `json:"rtmpsUrl"`
	ConnectedAt        *string            `json:"connectedAt"`
	DisconnectedAt     *string            `json:"disconnectedAt"`
	CreatedAt          string             `json:"createdAt"`
	UpdatedAt          string             `json:"updatedAt"`
}

// IngressWithKey is IngressView plus the full stream key (sk_...). Returned
// only by Ingress.Create and Ingress.Reset: store it then.
type IngressWithKey struct {
	IngressView
	StreamKey string `json:"streamKey"`
}

// CreateIngressParams is the body of LiveStreams.Ingress.Create.
type CreateIngressParams struct {
	// Protocol defaults to RTMP.
	Protocol IngressProtocol `json:"protocol,omitempty"`
	// Identity must be a registered host. Defaults to the stream's HOST.
	Identity string `json:"identity,omitempty"`
	// AutoStart starts a CREATED stream when the encoder connects. Defaults to true.
	AutoStart *bool `json:"autoStart,omitempty"`
	// ReconnectWindowSec defaults to 60.
	ReconnectWindowSec *int `json:"reconnectWindowSec,omitempty"`
}
