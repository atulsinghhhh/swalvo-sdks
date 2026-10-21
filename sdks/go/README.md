# Swalvo Go server SDK

Swalvo's **backend** SDK for Go. Use it to mint short-lived RTC and chat tokens, manage
rooms, chat and live streams, read connection and error diagnostics, and verify
webhook deliveries.

It mirrors the TypeScript server SDK [`@swalvo/server`](../../packages/server-sdk)
resource for resource: same endpoints, same wire fields, same retry and error rules.
It uses only the standard library and needs Go 1.22+.

> **Never ship this to a browser or a mobile app.** It holds a permanent project API key.
> The client gets a short-lived token that *this* SDK mints.

## Install

> Renamed: this package was `github.com/atulsinghhhh/swalvo-sdks/sdks/go/livqeno`
> (package `livqeno`). Change the import path's last element to `swalvo` and
> the package qualifier from `livqeno.` to `swalvo.`; nothing else changed.
> Error `Code` strings such as `RAVEN_NOT_FOUND` are unchanged.

```bash
go get github.com/atulsinghhhh/swalvo-sdks/sdks/go/swalvo
```

```go
import "github.com/atulsinghhhh/swalvo-sdks/sdks/go/swalvo"
```

## Quickstart

```go
ctx := context.Background()

client := swalvo.New(
	os.Getenv("SWALVO_API_KEY"),                    // rvk_...; never hardcode it
	swalvo.WithBaseURL(os.Getenv("SWALVO_API_URL")), // https://api.swalvo.com
)

room, err := client.Rooms.Create(ctx, swalvo.CreateRoomParams{Name: "standup", GetOrCreate: true})
if err != nil {
	log.Fatal(err)
}

// Identity comes from YOUR session, never from the request body.
grant, err := client.Tokens.Create(ctx, swalvo.CreateTokenParams{
	Room:     room.ID,
	Identity: "user-42",
})
// grant.Token, grant.Endpoint, grant.IceServers, grant.ExpiresAt ... go to your frontend.
```

### Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `WithBaseURL(url)` | `http://localhost:4100` | Required when `SWALVO_ENV` or `NODE_ENV` is `production`. |
| `WithTimeout(d)` | `10s` | Per attempt. |
| `WithMaxRetries(n)` | `2` | Retries network errors, timeouts and 429/502/503/504 only. |
| `WithHTTPClient(hc)` | `&http.Client{}` | For a custom transport or proxy. |

`New` never fails, so it fits on one line. A configuration problem (empty API key, no
base URL in production, a bad option) comes back from `client.Err()` and from every
call as a `*swalvo.Error` with code `RAVEN_INVALID_CONFIG`. To fail fast, use
`NewClient`:

```go
client, err := swalvo.NewClient(apiKey, swalvo.WithBaseURL(baseURL))
```

Every method takes a `context.Context`. Cancelling it, or letting its deadline pass,
stops the call at once and is never retried. A `Client` is safe for concurrent use. It
never prints its API key: `String`, `%+v`, `%#v` and `json.Marshal` show only the base
URL.

Optional request fields are pointers or `omitempty`. Use `swalvo.String`,
`swalvo.Bool`, `swalvo.Int` and `swalvo.Float64` to fill pointers in place. A
response field that can be JSON `null` is a pointer, so it is `nil` for null.

## Resources

Each resource is a field on the client. The comment after each call gives the HTTP
route it uses.

### Projects

```go
project, err := client.Projects.Get(ctx)        // GET /v1/project: the key's own project
```

### Tokens

```go
tok, err := client.Tokens.Create(ctx, swalvo.CreateTokenParams{
	Room:        roomID,
	Identity:    "user-42",
	Permissions: &swalvo.TokenPermissions{Subscribe: swalvo.Bool(true), Publish: swalvo.Bool(false)},
	ExpiresIn:   600,                            // seconds, 30..21600; 0 = API default
	Metadata:    swalvo.String(`{"name":"Ada"}`),
})                                               // POST /v1/rooms/{room}/rtc-tokens
```

### Rooms

```go
rooms, err := client.Rooms.List(ctx)                       // GET /v1/rooms
room, err := client.Rooms.Get(ctx, roomID)                 // GET /v1/rooms/{id}
room, err := client.Rooms.Create(ctx, swalvo.CreateRoomParams{
	Name: "standup", GetOrCreate: true, E2EE: swalvo.Bool(true),
})                                                         // POST /v1/rooms
err := client.Rooms.Delete(ctx, roomID)                    // DELETE: soft-close, status CLOSED

// The SFU's live state. A nil slice means the SFU was unreachable;
// an empty, non-nil slice means the room really is empty.
people, err := client.Rooms.Participants.List(ctx, roomID)
alice, err := client.Rooms.Participants.Get(ctx, roomID, "alice") // nil if absent
```

### Moderation

Act on a participant who is connected right now. `roomID` is the room's id or its
name.

```go
// Disconnect every live session of the identity. Doesn't revoke their token,
// so revoke it too if they must stay out.
err := client.Rooms.Participants.Remove(ctx, roomID, "alice")    // POST .../participants/{identity}/remove

// Mute one track, or every track of one kind. Set exactly one of TrackID and Kind;
// Muted: false unmutes.
err := client.Rooms.Participants.Mute(ctx, roomID, "alice", swalvo.MuteParticipantParams{
	Kind: swalvo.TrackKindAudio, Muted: true,
})                                                               // POST .../participants/{identity}/mute
err := client.Rooms.Participants.Mute(ctx, roomID, "alice", swalvo.MuteParticipantParams{
	TrackID: "TR_abc123", Muted: false,
})

// Change live permissions in place. Only the fields you set are sent (false included);
// the rest stay as they are. Returns the merged permissions.
perms, err := client.Rooms.Participants.UpdatePermissions(ctx, roomID, "alice",
	swalvo.UpdateParticipantPermissionsParams{Publish: swalvo.Bool(false)},
)                                                                // PATCH .../participants/{identity}/permissions
perms.Subscribe // true
```

`Mute` with both or neither of `TrackID` and `Kind`, or `UpdatePermissions` with no
field set, returns `RAVEN_INVALID_CONFIG` without sending a request. A participant who
isn't connected is a 404 with `RAVEN_PARTICIPANT_NOT_CONNECTED`; a `TrackID` that
isn't theirs is a 404 with `RAVEN_TRACK_NOT_FOUND`.

### Chat

```go
chatTok, err := client.Chat.CreateToken(ctx, swalvo.CreateChatTokenParams{
	UserID: "user-42", Conversations: []string{"conv_1"},
	Scopes: []swalvo.ChatScope{swalvo.ChatScopeRead, swalvo.ChatScopeSend}, ExpiresIn: 900,
})                                                         // POST /v1/chat/tokens

conv, err := client.Chat.CreateConversation(ctx, swalvo.CreateConversationParams{
	Name: "general", Type: swalvo.ConversationChannel, GetOrCreate: true,
	Members: []swalvo.ChatMemberInput{{UserID: "user-42"}, {UserID: "mod-1", Role: swalvo.ChatRoleModerator}},
})
convs, err := client.Chat.ListConversations(ctx, &swalvo.ListConversationsParams{UserID: "user-42"})
conv, err := client.Chat.GetConversation(ctx, "general")   // conv_ id, name, or attached room id
member, err := client.Chat.AddMember(ctx, "general", swalvo.AddMemberParams{UserID: "user-7"})
err := client.Chat.RemoveMember(ctx, "general", "user-7")
members, err := client.Chat.ListMembers(ctx, "general")
msg, err := client.Chat.SendMessage(ctx, "general", swalvo.SendChatMessageParams{
	SenderID: "system", Type: swalvo.MessageSystem, Text: swalvo.String("Welcome!"),
	ClientMessageID: "welcome-1",                          // idempotency key
})
page, err := client.Chat.ListMessages(ctx, "general", &swalvo.ListChatMessagesParams{Limit: 50})
older, err := client.Chat.ListMessages(ctx, "general", &swalvo.ListChatMessagesParams{Before: *page.NextCursor})
deleted, err := client.Chat.DeleteMessage(ctx, msg.ID)     // soft delete
```

A conversation created with no members can't be used by any chat token. List the
members when you create it, or call `AddMember` before you mint their tokens.

### Live streams

`client.Live` is the same object as `client.LiveStreams`.

```go
stream, err := client.LiveStreams.Create(ctx, swalvo.CreateLiveStreamParams{
	Title: "Launch", HostIdentity: "host-1",
	DeliveryMode: swalvo.DeliveryBroadcast,               // or DeliveryRTCOnly (default)
	EdgeScaling:  swalvo.Bool(true),
})
streams, err := client.LiveStreams.List(ctx, &swalvo.ListLiveStreamsParams{Status: swalvo.LiveStreamLive})
stream, err := client.LiveStreams.Get(ctx, stream.ID)      // includes ViewerCount (nil = SFU unreachable)
stream, err := client.LiveStreams.Update(ctx, stream.ID, swalvo.UpdateLiveStreamParams{Title: swalvo.String("New title")})
stream, err := client.LiveStreams.Start(ctx, stream.ID)    // CREATED -> LIVE
stream, err := client.LiveStreams.End(ctx, stream.ID)      // LIVE -> ENDED (terminal)

// Hosts: the only route to publish access. Call it after your own auth check.
host, err := client.LiveStreams.AddHost(ctx, stream.ID, swalvo.AddHostParams{Identity: "guest-1", Role: swalvo.RoleCoHost})
err := client.LiveStreams.RemoveHost(ctx, stream.ID, "guest-1")

// Viewers: always subscribe-only. AcceptPlayback lets a BROADCAST stream answer
// with an HLS playback credential instead of a 409.
viewer, err := client.LiveStreams.CreateViewerToken(ctx, stream.ID, "viewer-9",
	&swalvo.ViewerTokenOptions{AcceptPlayback: true})
if viewer.Playback != nil {
	// viewer.Playback.URL, viewer.Playback.LLHLSURL, viewer.Playback.Status
}
err := client.LiveStreams.Leave(ctx, stream.ID, "viewer-9") // clean-leave signal

// Delivery view: HLS state and URLs. NOT_APPLICABLE for RTC_ONLY streams.
// Also available as stream.Delivery.
d, err := client.LiveStreams.Playback(ctx, stream.ID)      // GET /v1/live-streams/{id}/playback
// d.Status, d.PlaybackURL, d.LLHLSPlaybackURL (prefer it), d.RecordingURL

// The stage
err := client.LiveStreams.Stage.Invite(ctx, stream.ID, "viewer-9")
cred, err := client.LiveStreams.Stage.Promote(ctx, stream.ID, "viewer-9", nil) // CO_HOST credentials
cred, err = client.LiveStreams.Stage.Promote(ctx, stream.ID, "viewer-9", &swalvo.StagePromoteOptions{Role: swalvo.RoleHost})
err = client.LiveStreams.Stage.Demote(ctx, stream.ID, "viewer-9")

// Restream (RTMP out) to up to 5 destinations. The key is write-only; you get KeyLast4 back.
dest, err := client.LiveStreams.Restreams.Create(ctx, stream.ID, swalvo.CreateRestreamParams{
	URL: "rtmps://a.rtmp.youtube.com/live2", StreamKey: ytKey, Label: "YouTube",
})
dests, err := client.LiveStreams.Restreams.List(ctx, stream.ID)
dest, err = client.LiveStreams.Restreams.Update(ctx, stream.ID, dest.ID, swalvo.UpdateRestreamParams{Enabled: swalvo.Bool(false)})
err = client.LiveStreams.Restreams.Delete(ctx, stream.ID, dest.ID)

// Ingest (WHIP / RTMP in) from OBS, vMix, ffmpeg. StreamKey is returned only here and by Reset.
ing, err := client.LiveStreams.Ingress.Create(ctx, stream.ID, &swalvo.CreateIngressParams{Protocol: swalvo.IngressRTMP})
// ing.RtmpURL / ing.RtmpsURL / ing.WhipURL + ing.StreamKey
view, err := client.LiveStreams.Ingress.Get(ctx, stream.ID)
ing, err = client.LiveStreams.Ingress.Reset(ctx, stream.ID) // rotates the key
err = client.LiveStreams.Ingress.Delete(ctx, stream.ID)
```

### Connections, errors, metrics, diagnostics

```go
conns, err := client.Connections.List(ctx, &swalvo.ListConnectionsParams{RoomID: roomID, State: swalvo.ConnectionFailed, Limit: 20})
conn, err := client.Connections.Get(ctx, conns[0].PublicID)  // with Events and Errors

errs, err := client.Errors.List(ctx, &swalvo.ListErrorsParams{Category: swalvo.ErrorCategoryICE})
detail, err := client.Errors.Get(ctx, errs[0].PublicID)

metrics, err := client.Metrics.Get(ctx, swalvo.MetricsRange24h) // "" for the API default
diag, err := client.Diagnostics.Get(ctx)                         // signaling / SFU / TURN health
```

## Webhooks

Swalvo signs every webhook delivery:

```
swalvo-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
swalvo-event-id:   evt_...
swalvo-event-type: live_stream.started
```

Deliveries also carry identical legacy `raven-*` twins of these headers for
integrations written before the rename. `VerifyWebhookRequest` reads
`swalvo-signature` first and falls back to `raven-signature`. The
`Swalvo*Header` constants name the new headers; the unprefixed
`WebhookSignatureHeader`, `WebhookEventIDHeader` and `WebhookEventTypeHeader`
keep their legacy `raven-*` values.

`VerifyWebhookRequest` reads the body, checks the signature in constant time, rejects a
timestamp more than 300 s from now, and decodes the event envelope. It puts the body
back on the request afterwards.

```go
http.HandleFunc("/webhooks/swalvo", func(w http.ResponseWriter, r *http.Request) {
	event, err := swalvo.VerifyWebhookRequest(r, os.Getenv("SWALVO_WEBHOOK_SECRET"))
	if err != nil {
		http.Error(w, "invalid signature", http.StatusBadRequest)
		return
	}
	// Deliveries can repeat: deduplicate on event.ID (also r.Header.Get(swalvo.SwalvoWebhookEventIDHeader)).
	switch event.Type {
	case "live_stream.started":
		// json.Unmarshal(event.Data, &yourStruct)
	}
	w.WriteHeader(http.StatusNoContent)
})
```

If you already have the raw body, verify it directly. Verify the exact bytes you
received. Re-encoded JSON won't match.

```go
err := swalvo.VerifyWebhookSignature(rawBody, r.Header.Get(swalvo.SwalvoWebhookSignatureHeader), secret)
// errors.Is(err, swalvo.ErrWebhookSignatureMismatch / ErrWebhookTimestampOutOfRange /
//           ErrWebhookInvalidHeader / ErrWebhookMissingSecret)

// Explicit clock and tolerance:
err = swalvo.VerifyWebhookSignatureAt(rawBody, header, secret, time.Now(), swalvo.WebhookTolerance)

// To test your own handler, sign a payload:
header := swalvo.SignWebhookPayload(body, secret, time.Now())
```

## Errors

Every failure is a `*swalvo.Error`:

```go
room, err := client.Rooms.Get(ctx, "room_missing")
var lerr *swalvo.Error
if errors.As(err, &lerr) {
	lerr.Code       // "RAVEN_ROOM_NOT_FOUND": the API's own code, passed through
	lerr.StatusCode // 404 (0 if no response arrived)
	lerr.Message    // "Room not found"
	lerr.RequestID  // x-request-id; quote it in bug reports
	lerr.Details    // the decoded JSON error body, or nil
}
// or: if lerr, ok := swalvo.AsError(err); ok { ... }
```

Branch on `Code`, not on the message. If a proxy strips the JSON body, the code is
derived from the status and uses the same vocabulary:

| Status | Code |
| --- | --- |
| 401 | `RAVEN_AUTH_ERROR` |
| 403 | `RAVEN_PERMISSION_DENIED` |
| 404 | `RAVEN_NOT_FOUND` |
| 429 | `RAVEN_RATE_LIMITED` |
| 5xx | `RAVEN_INTERNAL_ERROR` |
| other | `VALIDATION_ERROR` |

The SDK adds these codes of its own:

| Code | When |
| --- | --- |
| `RAVEN_INVALID_CONFIG` | The client is misconfigured, or a call's input was rejected before sending. |
| `RAVEN_TIMEOUT` | An attempt or your context deadline timed out. `errors.Is(err, context.DeadlineExceeded)` works for the context case. |
| `RAVEN_NETWORK_ERROR` | The API couldn't be reached, or your context was cancelled. |
| `RAVEN_UNKNOWN_ERROR` | A 2xx body couldn't be decoded. |

Error strings never contain the API key. If a server echoes the key back, the SDK
redacts it from `Message` and `Details`.

### Retries

The SDK retries network errors, timeouts and 429/502/503/504 responses, up to
`maxRetries` times (2 by default). The backoff is exponential: 300 ms, then 600 ms,
then 1.2 s. Like the TypeScript SDK, it doesn't read `Retry-After`. It never retries
any other 4xx.

## Tests

```bash
go test ./...      # httptest-based; never touches a real API
go vet ./... && gofmt -l .
```

The integration test is opt-in. It creates a room, mints a token, creates, starts and
ends a live stream, and mints a viewer token. Point it at a disposable project:

```bash
SWALVO_IT_BASE_URL=https://api.example.com SWALVO_IT_API_KEY=rvk_... go test -run TestIntegration -v ./...
```

## License

MIT
