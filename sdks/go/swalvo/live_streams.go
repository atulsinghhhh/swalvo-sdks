package swalvo

import (
	"context"
	"net/http"
	"net/url"
)

// LiveStreamsResource is Swalvo Live Streaming, server-side.
//
// A stream composes an RTC room and a chat conversation. AddHost and
// CreateViewerToken are the security-critical pair: the role a caller ends up
// with is decided entirely by which method you call, never by a request
// field. A viewer token is always subscribe-only. AddHost, called from your
// backend after your own auth check, is the only route to publish access.
type LiveStreamsResource struct {
	http *httpClient
	// Restreams: RTMP/RTMPS destinations (YouTube, Twitch, ...) a stream is pushed to.
	Restreams *LiveStreamRestreamsResource
	// Ingress: the stream's ingest endpoint for OBS and other encoders, over WHIP or RTMP/RTMPS.
	Ingress *LiveStreamIngressResource
	// Stage: invite a viewer up, promote them to co-host, demote them.
	Stage *LiveStreamStageResource
}

func newLiveStreamsResource(h *httpClient) *LiveStreamsResource {
	return &LiveStreamsResource{
		http:      h,
		Restreams: &LiveStreamRestreamsResource{http: h},
		Ingress:   &LiveStreamIngressResource{http: h},
		Stage:     &LiveStreamStageResource{http: h},
	}
}

type identityBody struct {
	Identity string `json:"identity"`
}

func (r *LiveStreamsResource) stream(ctx context.Context, path string, opts requestOptions) (*LiveStream, error) {
	var out LiveStream
	if err := r.http.request(ctx, path, opts, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create creates a stream. POST /v1/live-streams
func (r *LiveStreamsResource) Create(ctx context.Context, params CreateLiveStreamParams) (*LiveStream, error) {
	return r.stream(ctx, "/v1/live-streams", requestOptions{method: http.MethodPost, body: params})
}

// List returns the project's streams, optionally filtered by status.
// GET /v1/live-streams?status=
func (r *LiveStreamsResource) List(ctx context.Context, params *ListLiveStreamsParams) ([]LiveStream, error) {
	q := url.Values{}
	if params != nil {
		setIf(q, "status", string(params.Status))
	}
	var out []LiveStream
	if err := r.http.request(ctx, "/v1/live-streams", requestOptions{query: q}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Get returns one stream, including its live viewer count (List doesn't, to
// avoid an SFU round trip per row). GET /v1/live-streams/{id}
func (r *LiveStreamsResource) Get(ctx context.Context, streamID string) (*LiveStream, error) {
	return r.stream(ctx, p("/v1/live-streams/%s", streamID), requestOptions{})
}

// Update changes a stream's details. PATCH /v1/live-streams/{id}
func (r *LiveStreamsResource) Update(ctx context.Context, streamID string, params UpdateLiveStreamParams) (*LiveStream, error) {
	return r.stream(ctx, p("/v1/live-streams/%s", streamID), requestOptions{method: http.MethodPatch, body: params})
}

// Start moves CREATED to LIVE. POST /v1/live-streams/{id}/start
func (r *LiveStreamsResource) Start(ctx context.Context, streamID string) (*LiveStream, error) {
	return r.stream(ctx, p("/v1/live-streams/%s/start", streamID), requestOptions{method: http.MethodPost})
}

// End moves LIVE to ENDED, which is terminal. POST /v1/live-streams/{id}/end
func (r *LiveStreamsResource) End(ctx context.Context, streamID string) (*LiveStream, error) {
	return r.stream(ctx, p("/v1/live-streams/%s/end", streamID), requestOptions{method: http.MethodPost})
}

// AddHost registers a host or co-host and mints full-publish RTC plus
// moderator-or-above chat credentials. Call it again to re-mint.
// POST /v1/live-streams/{id}/hosts
func (r *LiveStreamsResource) AddHost(ctx context.Context, streamID string, params AddHostParams) (*IssuedStreamCredential, error) {
	var out IssuedStreamCredential
	if err := r.http.request(ctx, p("/v1/live-streams/%s/hosts", streamID), requestOptions{method: http.MethodPost, body: params}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveHost soft-removes a host; their chat history survives.
// DELETE /v1/live-streams/{id}/hosts/{identity}
func (r *LiveStreamsResource) RemoveHost(ctx context.Context, streamID, identity string) error {
	return r.http.request(ctx, p("/v1/live-streams/%s/hosts/%s", streamID, identity), requestOptions{method: http.MethodDelete}, nil)
}

type viewerTokenBody struct {
	Identity       string `json:"identity"`
	AcceptPlayback bool   `json:"acceptPlayback,omitempty"`
}

// CreateViewerToken mints a viewer's credentials: always subscribe-only on
// RTC and MEMBER on chat. With opts.AcceptPlayback, a BROADCAST stream
// returns a playback credential (chat + Playback.URL/LLHLSURL) instead of a
// 409, so one call serves every delivery mode. opts may be nil.
// POST /v1/live-streams/{id}/viewer-tokens
func (r *LiveStreamsResource) CreateViewerToken(ctx context.Context, streamID, identity string, opts *ViewerTokenOptions) (*IssuedStreamCredential, error) {
	body := viewerTokenBody{Identity: identity}
	if opts != nil {
		body.AcceptPlayback = opts.AcceptPlayback
	}
	var out IssuedStreamCredential
	if err := r.http.request(ctx, p("/v1/live-streams/%s/viewer-tokens", streamID), requestOptions{method: http.MethodPost, body: body}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Playback returns the stream's delivery view: whether HLS playback is
// ready, and its PlaybackURL and LLHLSPlaybackURL. Works for RTC_ONLY streams
// too (status NOT_APPLICABLE). GET /v1/live-streams/{id}/playback
func (r *LiveStreamsResource) Playback(ctx context.Context, streamID string) (*LiveStreamDelivery, error) {
	var out LiveStreamDelivery
	if err := r.http.request(ctx, p("/v1/live-streams/%s/playback", streamID), requestOptions{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Leave is a clean-leave signal for live_stream.viewer_left, not a
// disconnect detector. POST /v1/live-streams/{id}/leave
func (r *LiveStreamsResource) Leave(ctx context.Context, streamID, identity string) error {
	return r.http.request(ctx, p("/v1/live-streams/%s/leave", streamID), requestOptions{method: http.MethodPost, body: identityBody{identity}}, nil)
}

// LiveStreamStageResource is the stage (Agora's setClientRole).
type LiveStreamStageResource struct{ http *httpClient }

// Invite announces a stage invite to the viewer's client. It changes no
// permissions. POST /v1/live-streams/{id}/stage/invites
func (r *LiveStreamStageResource) Invite(ctx context.Context, streamID, identity string) error {
	return r.http.request(ctx, p("/v1/live-streams/%s/stage/invites", streamID), requestOptions{method: http.MethodPost, body: identityBody{identity}}, nil)
}

type stagePromoteBody struct {
	Identity string             `json:"identity"`
	Role     LiveStreamHostRole `json:"role,omitempty"`
}

// Promote registers a viewer as a co-host (or HOST via opts.Role) and returns
// host credentials, which their client passes to LiveStream.switchRole().
// opts may be nil. POST /v1/live-streams/{id}/stage/promote
func (r *LiveStreamStageResource) Promote(ctx context.Context, streamID, identity string, opts *StagePromoteOptions) (*IssuedStreamCredential, error) {
	body := stagePromoteBody{Identity: identity}
	if opts != nil {
		body.Role = opts.Role
	}
	var out IssuedStreamCredential
	if err := r.http.request(ctx, p("/v1/live-streams/%s/stage/promote", streamID), requestOptions{method: http.MethodPost, body: body}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Demote takes a co-host off stage and stops their publishing at once.
// POST /v1/live-streams/{id}/stage/demote
func (r *LiveStreamStageResource) Demote(ctx context.Context, streamID, identity string) error {
	return r.http.request(ctx, p("/v1/live-streams/%s/stage/demote", streamID), requestOptions{method: http.MethodPost, body: identityBody{identity}}, nil)
}

// LiveStreamRestreamsResource is restream ("RTMP out"): push a live stream to
// up to 5 RTMP/RTMPS destinations. A destination's key is encrypted at rest
// and never returned; to change it, delete and recreate the destination.
type LiveStreamRestreamsResource struct{ http *httpClient }

// Create adds a destination; if the stream is LIVE, pushing starts at once.
// POST /v1/live-streams/{id}/restreams
func (r *LiveStreamRestreamsResource) Create(ctx context.Context, streamID string, params CreateRestreamParams) (*RestreamView, error) {
	var out RestreamView
	if err := r.http.request(ctx, p("/v1/live-streams/%s/restreams", streamID), requestOptions{method: http.MethodPost, body: params}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// List returns the stream's destinations. GET /v1/live-streams/{id}/restreams
func (r *LiveStreamRestreamsResource) List(ctx context.Context, streamID string) ([]RestreamView, error) {
	var out []RestreamView
	if err := r.http.request(ctx, p("/v1/live-streams/%s/restreams", streamID), requestOptions{}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Update pauses (Enabled false) or resumes a destination, or relabels it.
// PATCH /v1/live-streams/{id}/restreams/{restreamId}
func (r *LiveStreamRestreamsResource) Update(ctx context.Context, streamID, restreamID string, params UpdateRestreamParams) (*RestreamView, error) {
	var out RestreamView
	if err := r.http.request(ctx, p("/v1/live-streams/%s/restreams/%s", streamID, restreamID), requestOptions{method: http.MethodPatch, body: params}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete stops pushing to the destination and removes it.
// DELETE /v1/live-streams/{id}/restreams/{restreamId}
func (r *LiveStreamRestreamsResource) Delete(ctx context.Context, streamID, restreamID string) error {
	return r.http.request(ctx, p("/v1/live-streams/%s/restreams/%s", streamID, restreamID), requestOptions{method: http.MethodDelete}, nil)
}

// LiveStreamIngressResource is ingest: broadcast into a stream from OBS,
// vMix, ffmpeg or a hardware encoder. One ingest per stream. The stream key
// (sk_...) is returned only by Create and Reset.
type LiveStreamIngressResource struct{ http *httpClient }

// Create creates the stream's ingest and returns its URLs plus the stream
// key, shown this once. params may be nil (an empty body).
// POST /v1/live-streams/{id}/ingress
func (r *LiveStreamIngressResource) Create(ctx context.Context, streamID string, params *CreateIngressParams) (*IngressWithKey, error) {
	if params == nil {
		params = &CreateIngressParams{}
	}
	var out IngressWithKey
	if err := r.http.request(ctx, p("/v1/live-streams/%s/ingress", streamID), requestOptions{method: http.MethodPost, body: params}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns status and observed input. Never the stream key.
// GET /v1/live-streams/{id}/ingress
func (r *LiveStreamIngressResource) Get(ctx context.Context, streamID string) (*IngressView, error) {
	var out IngressView
	if err := r.http.request(ctx, p("/v1/live-streams/%s/ingress", streamID), requestOptions{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Reset rotates the stream key and disconnects any connected encoder.
// POST /v1/live-streams/{id}/ingress/reset
func (r *LiveStreamIngressResource) Reset(ctx context.Context, streamID string) (*IngressWithKey, error) {
	var out IngressWithKey
	if err := r.http.request(ctx, p("/v1/live-streams/%s/ingress/reset", streamID), requestOptions{method: http.MethodPost}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete deletes the ingest and disconnects any encoder; the stream keeps
// running. DELETE /v1/live-streams/{id}/ingress
func (r *LiveStreamIngressResource) Delete(ctx context.Context, streamID string) error {
	return r.http.request(ctx, p("/v1/live-streams/%s/ingress", streamID), requestOptions{method: http.MethodDelete}, nil)
}
