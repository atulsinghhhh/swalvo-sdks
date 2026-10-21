package swalvo

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// ProjectsResource reads the project an API key belongs to. A key is scoped
// to exactly one project, so there is nothing to list, create or delete here.
type ProjectsResource struct{ http *httpClient }

// Get returns the project this API key belongs to. GET /v1/project
func (r *ProjectsResource) Get(ctx context.Context) (*Project, error) {
	var out Project
	if err := r.http.request(ctx, "/v1/project", requestOptions{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// TokensResource mints short-lived RTC tokens server-side. Never mint one in
// a browser, and never hold on to one longer than it takes to forward it.
type TokensResource struct{ http *httpClient }

type createTokenBody struct {
	ParticipantIdentity string            `json:"participantIdentity"`
	Permissions         *TokenPermissions `json:"permissions,omitempty"`
	TTLSeconds          int               `json:"ttlSeconds,omitempty"`
	Metadata            *string           `json:"metadata,omitempty"`
}

// Create mints an RTC token. POST /v1/rooms/{room}/rtc-tokens
func (r *TokensResource) Create(ctx context.Context, params CreateTokenParams) (*IssuedToken, error) {
	body := createTokenBody{
		ParticipantIdentity: params.Identity,
		Permissions:         params.Permissions,
		TTLSeconds:          params.ExpiresIn,
		Metadata:            params.Metadata,
	}
	var out IssuedToken
	if err := r.http.request(ctx, p("/v1/rooms/%s/rtc-tokens", params.Room), requestOptions{method: http.MethodPost, body: body}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RoomsResource manages rooms. Rooms are control-plane records: Delete
// soft-closes a room (status CLOSED) rather than destroying history.
type RoomsResource struct {
	http *httpClient
	// Participants reads the SFU's live participant list and moderates it.
	Participants *RoomParticipantsResource
}

// List returns the project's rooms. GET /v1/rooms
func (r *RoomsResource) List(ctx context.Context) ([]Room, error) {
	var out []Room
	if err := r.http.request(ctx, "/v1/rooms", requestOptions{}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Get returns one room. GET /v1/rooms/{roomId}
func (r *RoomsResource) Get(ctx context.Context, roomID string) (*Room, error) {
	var out Room
	if err := r.http.request(ctx, p("/v1/rooms/%s", roomID), requestOptions{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create creates a room. Set GetOrCreate when several participants create the
// room they are all about to join. POST /v1/rooms
func (r *RoomsResource) Create(ctx context.Context, params CreateRoomParams) (*Room, error) {
	var out Room
	if err := r.http.request(ctx, "/v1/rooms", requestOptions{method: http.MethodPost, body: params}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete soft-closes the room, setting status to CLOSED. DELETE /v1/rooms/{roomId}
func (r *RoomsResource) Delete(ctx context.Context, roomID string) error {
	return r.http.request(ctx, p("/v1/rooms/%s", roomID), requestOptions{method: http.MethodDelete}, nil)
}

// RoomParticipantsResource reflects the SFU's current live state, never a
// stored roster.
type RoomParticipantsResource struct{ http *httpClient }

// List returns the room's live participants. GET /v1/rooms/{roomId}/participants
//
// A nil slice means the SFU couldn't be reached (the API returned null). A
// genuinely empty room is a non-nil, zero-length slice. The two are never
// collapsed into one.
func (r *RoomParticipantsResource) List(ctx context.Context, roomID string) ([]LiveParticipantInfo, error) {
	var out []LiveParticipantInfo
	if err := r.http.request(ctx, p("/v1/rooms/%s/participants", roomID), requestOptions{}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Get finds one participant by identity in the live list. It returns nil,
// not an error, when the participant isn't there or the SFU is unreachable.
func (r *RoomParticipantsResource) Get(ctx context.Context, roomID, identity string) (*LiveParticipantInfo, error) {
	participants, err := r.List(ctx, roomID)
	if err != nil {
		return nil, err
	}
	for i := range participants {
		if participants[i].Identity == identity {
			return &participants[i], nil
		}
	}
	return nil, nil
}

// Remove disconnects every live session of identity from the room. It does
// not revoke their token: revoke it too to keep them out. A participant who
// isn't connected is a 404 with code RAVEN_PARTICIPANT_NOT_CONNECTED.
// POST /v1/rooms/{roomId}/participants/{identity}/remove
func (r *RoomParticipantsResource) Remove(ctx context.Context, roomID, identity string) error {
	return r.http.request(ctx, p("/v1/rooms/%s/participants/%s/remove", roomID, identity), requestOptions{method: http.MethodPost, body: struct{}{}}, nil)
}

// Mute mutes (or, with Muted false, unmutes) one track or every track of one
// kind. Exactly one of params.TrackID and params.Kind must be set, otherwise
// it returns RAVEN_INVALID_CONFIG without sending anything. A 404 carries
// RAVEN_PARTICIPANT_NOT_CONNECTED or RAVEN_TRACK_NOT_FOUND.
// POST /v1/rooms/{roomId}/participants/{identity}/mute
func (r *RoomParticipantsResource) Mute(ctx context.Context, roomID, identity string, params MuteParticipantParams) error {
	if (params.TrackID == "") == (params.Kind == "") {
		return newConfigError("mute needs exactly one of TrackID or Kind")
	}
	return r.http.request(ctx, p("/v1/rooms/%s/participants/%s/mute", roomID, identity), requestOptions{method: http.MethodPost, body: params}, nil)
}

// UpdatePermissions merges params into a connected participant's live
// permissions and returns the result. Only the fields set are sent; at least
// one must be, otherwise it returns RAVEN_INVALID_CONFIG without sending
// anything. Issued tokens are not changed.
// PATCH /v1/rooms/{roomId}/participants/{identity}/permissions
func (r *RoomParticipantsResource) UpdatePermissions(ctx context.Context, roomID, identity string, params UpdateParticipantPermissionsParams) (*ParticipantPermissions, error) {
	if params.Subscribe == nil && params.Publish == nil && params.PublishAudio == nil && params.PublishVideo == nil &&
		params.PublishScreen == nil && params.PublishData == nil {
		return nil, newConfigError("updatePermissions needs at least one permission field")
	}
	var out ParticipantPermissions
	if err := r.http.request(ctx, p("/v1/rooms/%s/participants/%s/permissions", roomID, identity), requestOptions{method: http.MethodPatch, body: params}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ConnectionsResource reads event-sourced RTC connection data.
type ConnectionsResource struct{ http *httpClient }

// List returns connection records. GET /v1/connections?roomId=&state=&limit=
func (r *ConnectionsResource) List(ctx context.Context, params *ListConnectionsParams) ([]ConnectionSummary, error) {
	q := url.Values{}
	if params != nil {
		setIf(q, "roomId", params.RoomID)
		setIf(q, "state", string(params.State))
		if params.Limit != 0 {
			q.Set("limit", strconv.Itoa(params.Limit))
		}
	}
	var out []ConnectionSummary
	if err := r.http.request(ctx, "/v1/connections", requestOptions{query: q}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Get returns one connection with its events and errors. GET /v1/connections/{id}
func (r *ConnectionsResource) Get(ctx context.Context, connectionID string) (*ConnectionDetail, error) {
	var out ConnectionDetail
	if err := r.http.request(ctx, p("/v1/connections/%s", connectionID), requestOptions{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ErrorsResource reads classified RTC errors. Never a raw SFU or coturn code.
type ErrorsResource struct{ http *httpClient }

// List returns classified errors. GET /v1/errors?category=&connectionId=&limit=
func (r *ErrorsResource) List(ctx context.Context, params *ListErrorsParams) ([]ErrorSummary, error) {
	q := url.Values{}
	if params != nil {
		setIf(q, "category", string(params.Category))
		setIf(q, "connectionId", params.ConnectionID)
		if params.Limit != 0 {
			q.Set("limit", strconv.Itoa(params.Limit))
		}
	}
	var out []ErrorSummary
	if err := r.http.request(ctx, "/v1/errors", requestOptions{query: q}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Get returns one error with its connection. GET /v1/errors/{id}
func (r *ErrorsResource) Get(ctx context.Context, errorID string) (*ErrorDetail, error) {
	var out ErrorDetail
	if err := r.http.request(ctx, p("/v1/errors/%s", errorID), requestOptions{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// MetricsResource reads real aggregate metrics, which double as today's usage view.
type MetricsResource struct{ http *httpClient }

// Get returns the overview for range ("" for the API default). GET /v1/metrics?range=
func (r *MetricsResource) Get(ctx context.Context, rng MetricsRange) (*MetricsOverview, error) {
	q := url.Values{}
	setIf(q, "range", string(rng))
	var out MetricsOverview
	if err := r.http.request(ctx, "/v1/metrics", requestOptions{query: q}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DiagnosticsResource reports signaling, SFU and TURN health plus the
// project's active-connection count.
type DiagnosticsResource struct{ http *httpClient }

// Get returns the project's diagnostics. GET /v1/diagnostics
func (r *DiagnosticsResource) Get(ctx context.Context) (*ProjectDiagnostics, error) {
	var out ProjectDiagnostics
	if err := r.http.request(ctx, "/v1/diagnostics", requestOptions{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func setIf(q url.Values, key, value string) {
	if value != "" {
		q.Set(key, value)
	}
}
