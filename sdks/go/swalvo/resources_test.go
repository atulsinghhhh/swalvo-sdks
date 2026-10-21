package swalvo

import (
	"context"
	"testing"
)

var bg = context.Background()

func TestClientExposesEveryResource(t *testing.T) {
	_, c := newFake(t)
	if c.Projects == nil || c.Tokens == nil || c.Rooms == nil || c.Rooms.Participants == nil ||
		c.Connections == nil || c.Errors == nil || c.Metrics == nil || c.Diagnostics == nil ||
		c.Chat == nil || c.LiveStreams == nil || c.LiveStreams.Stage == nil ||
		c.LiveStreams.Restreams == nil || c.LiveStreams.Ingress == nil {
		t.Fatal("a resource is nil")
	}
	if c.Live != c.LiveStreams {
		t.Fatal("client.Live must be the very same object as client.LiveStreams")
	}
}

func TestProjectsGet(t *testing.T) {
	f, c := newFake(t, ok(`{"id":"proj_1","name":"Demo","description":null,"status":"ACTIVE","ownerId":"u_1","createdAt":"c","updatedAt":"u"}`))
	proj, err := c.Projects.Get(bg)
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/project")
	if proj.Name != "Demo" || proj.Description != nil || proj.Status != ProjectStatusActive {
		t.Fatalf("decoded %+v", proj)
	}
}

func TestTokensCreate(t *testing.T) {
	f, c := newFake(t,
		ok(`{"id":"tok_1","token":"jwt","endpoint":"wss://sfu","roomId":"room_1","roomName":"standup","participantIdentity":"user-42",
		     "permissions":{"subscribe":true,"publish":false},
		     "iceServers":[{"urls":"stun:stun.example.com"},{"urls":["turn:a","turn:b"],"username":"u","credential":"c"}],
		     "telemetryUrl":"https://t","expiresAt":"e","createdAt":"c"}`),
		ok(`{}`),
	)
	tok, err := c.Tokens.Create(bg, CreateTokenParams{
		Room:        "room_1",
		Identity:    "user-42",
		Permissions: &TokenPermissions{Subscribe: Bool(true), Publish: Bool(false)},
		ExpiresIn:   600,
		Metadata:    String(`{"name":"Ada"}`),
	})
	mustNoErr(t, err)
	r := f.last(t)
	assertReq(t, r, "POST", "/v1/rooms/room_1/rtc-tokens")
	assertJSON(t, r.Body, `{"participantIdentity":"user-42","permissions":{"subscribe":true,"publish":false},"ttlSeconds":600,"metadata":"{\"name\":\"Ada\"}"}`)
	if tok.Token != "jwt" || tok.Endpoint != "wss://sfu" || *tok.Permissions.Subscribe != true {
		t.Fatalf("decoded %+v", tok)
	}
	if len(tok.IceServers) != 2 || tok.IceServers[0].URLs[0] != "stun:stun.example.com" || len(tok.IceServers[1].URLs) != 2 || *tok.IceServers[1].Username != "u" {
		t.Fatalf("iceServers %+v", tok.IceServers)
	}

	// Optional fields are left out entirely, like `undefined` in the TS SDK.
	_, err = c.Tokens.Create(bg, CreateTokenParams{Room: "room_1", Identity: "u"})
	mustNoErr(t, err)
	assertJSON(t, f.last(t).Body, `{"participantIdentity":"u"}`)
}

func TestRooms(t *testing.T) {
	f, c := newFake(t,
		ok(`[{"id":"room_1","projectId":"p","name":"a","status":"ACTIVE","createdAt":"c","updatedAt":"u"}]`),
		ok(`{"id":"room_1","status":"CLOSED"}`),
		ok(`{"id":"room_2","name":"standup","e2ee":true}`),
		ok(`{"id":"room_3"}`),
		fakeResponse{status: 204},
	)
	rooms, err := c.Rooms.List(bg)
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/rooms")
	if len(rooms) != 1 || rooms[0].Name != "a" {
		t.Fatalf("rooms %+v", rooms)
	}

	room, err := c.Rooms.Get(bg, "room_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/rooms/room_1")
	if room.Status != RoomStatusClosed {
		t.Fatalf("room %+v", room)
	}

	room, err = c.Rooms.Create(bg, CreateRoomParams{Name: "standup", GetOrCreate: true, E2EE: Bool(true)})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/rooms")
	assertJSON(t, f.last(t).Body, `{"name":"standup","getOrCreate":true,"e2ee":true}`)
	if room.E2EE == nil || !*room.E2EE {
		t.Fatalf("room %+v", room)
	}

	_, err = c.Rooms.Create(bg, CreateRoomParams{Name: "plain", E2EE: Bool(false)})
	mustNoErr(t, err)
	assertJSON(t, f.last(t).Body, `{"name":"plain","e2ee":false}`)

	mustNoErr(t, c.Rooms.Delete(bg, "room_1"))
	assertReq(t, f.last(t), "DELETE", "/v1/rooms/room_1")
}

func TestRoomParticipants(t *testing.T) {
	f, c := newFake(t,
		ok(`[{"identity":"alice","joinedAt":"j","tracks":[{"sid":"TR_1","kind":"audio","name":"mic","muted":false}]}]`),
		ok(`null`),
		ok(`[]`),
		ok(`[{"identity":"alice","joinedAt":"j","tracks":[]},{"identity":"bob","joinedAt":"j","tracks":[]}]`),
		ok(`null`),
	)
	list, err := c.Rooms.Participants.List(bg, "room_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/rooms/room_1/participants")
	if len(list) != 1 || list[0].Tracks[0].Kind != "audio" {
		t.Fatalf("list %+v", list)
	}

	// null (SFU unreachable) and [] (empty room) stay distinct.
	unreachable, err := c.Rooms.Participants.List(bg, "room_1")
	mustNoErr(t, err)
	empty, err := c.Rooms.Participants.List(bg, "room_1")
	mustNoErr(t, err)
	if unreachable != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("null vs [] collapsed: %#v %#v", unreachable, empty)
	}

	bob, err := c.Rooms.Participants.Get(bg, "room_1", "bob")
	mustNoErr(t, err)
	if bob == nil || bob.Identity != "bob" {
		t.Fatalf("bob = %+v", bob)
	}
	none, err := c.Rooms.Participants.Get(bg, "room_1", "bob")
	mustNoErr(t, err)
	if none != nil {
		t.Fatalf("expected nil when the SFU is unreachable, got %+v", none)
	}
}

func TestRoomParticipantsModeration(t *testing.T) {
	notConnected := fakeResponse{status: 404, body: `{"code":"RAVEN_PARTICIPANT_NOT_CONNECTED","message":"Participant is not connected","statusCode":404}`}
	f, c := newFake(t,
		fakeResponse{status: 204},
		notConnected,
		fakeResponse{status: 204},
		fakeResponse{status: 204},
		fakeResponse{status: 404, body: `{"code":"RAVEN_TRACK_NOT_FOUND","message":"Track not found","statusCode":404}`},
		ok(`{"subscribe":true,"publish":false,"publishAudio":false,"publishVideo":true,"publishData":true}`),
		notConnected,
	)

	// Remove: POST, {} body, identity percent-encoded, 204 is a nil error.
	mustNoErr(t, c.Rooms.Participants.Remove(bg, "standup", "a b/c"))
	r := f.last(t)
	assertReq(t, r, "POST", "/v1/rooms/standup/participants/a%20b%2Fc/remove")
	assertJSON(t, r.Body, `{}`)

	err := c.Rooms.Participants.Remove(bg, "standup", "ghost")
	if lerr, isErr := AsError(err); !isErr || lerr.Code != "RAVEN_PARTICIPANT_NOT_CONNECTED" || lerr.StatusCode != 404 {
		t.Fatalf("remove 404: %v", err)
	}

	// Mute by kind; muted:false (unmute) is still sent, trackId is omitted.
	mustNoErr(t, c.Rooms.Participants.Mute(bg, "room_1", "a b/c", MuteParticipantParams{Kind: TrackKindAudio, Muted: false}))
	r = f.last(t)
	assertReq(t, r, "POST", "/v1/rooms/room_1/participants/a%20b%2Fc/mute")
	assertJSON(t, r.Body, `{"kind":"audio","muted":false}`)

	mustNoErr(t, c.Rooms.Participants.Mute(bg, "room_1", "bob", MuteParticipantParams{TrackID: "TR_1", Muted: true}))
	assertJSON(t, f.last(t).Body, `{"trackId":"TR_1","muted":true}`)

	err = c.Rooms.Participants.Mute(bg, "room_1", "bob", MuteParticipantParams{TrackID: "TR_x", Muted: true})
	if lerr, isErr := AsError(err); !isErr || lerr.Code != "RAVEN_TRACK_NOT_FOUND" || lerr.StatusCode != 404 {
		t.Fatalf("mute 404: %v", err)
	}

	// Both or neither of TrackID/Kind is rejected before any request.
	before := len(f.requests())
	for _, bad := range []MuteParticipantParams{
		{TrackID: "TR_1", Kind: TrackKindVideo, Muted: true},
		{Muted: true},
	} {
		err = c.Rooms.Participants.Mute(bg, "room_1", "bob", bad)
		if lerr, isErr := AsError(err); !isErr || lerr.Code != CodeInvalidConfig {
			t.Fatalf("mute %+v: want RAVEN_INVALID_CONFIG, got %v", bad, err)
		}
	}
	// An empty permissions patch is rejected the same way.
	if _, err = c.Rooms.Participants.UpdatePermissions(bg, "room_1", "bob", UpdateParticipantPermissionsParams{}); err == nil {
		t.Fatal("empty permissions update must be rejected")
	} else if lerr, _ := AsError(err); lerr.Code != CodeInvalidConfig {
		t.Fatalf("empty permissions: %v", err)
	}
	if got := len(f.requests()); got != before {
		t.Fatalf("invalid input sent %d request(s)", got-before)
	}

	// UpdatePermissions: PATCH, only set fields, false kept, response decoded.
	perms, err := c.Rooms.Participants.UpdatePermissions(bg, "room_1", "a b/c", UpdateParticipantPermissionsParams{
		Publish: Bool(false), PublishData: Bool(true),
	})
	mustNoErr(t, err)
	r = f.last(t)
	assertReq(t, r, "PATCH", "/v1/rooms/room_1/participants/a%20b%2Fc/permissions")
	assertJSON(t, r.Body, `{"publish":false,"publishData":true}`)
	want := ParticipantPermissions{Subscribe: true, Publish: false, PublishAudio: false, PublishVideo: true, PublishData: true}
	if perms == nil || *perms != want {
		t.Fatalf("perms = %+v", perms)
	}

	perms, err = c.Rooms.Participants.UpdatePermissions(bg, "room_1", "ghost", UpdateParticipantPermissionsParams{Subscribe: Bool(true)})
	if lerr, isErr := AsError(err); !isErr || lerr.Code != "RAVEN_PARTICIPANT_NOT_CONNECTED" || perms != nil {
		t.Fatalf("permissions 404: %v %+v", err, perms)
	}
}

func TestConnectionsAndErrors(t *testing.T) {
	f, c := newFake(t,
		ok(`[]`),
		ok(`{"id":"c1","publicId":"conn_1","state":"FAILED","roomId":null,"durationMs":1234,"events":[{"id":"e1","type":"ice","data":{"k":1},"timestamp":"t"}],"errors":[{"id":"x","category":"ICE_ERROR","message":"m"}]}`),
		ok(`[]`),
		ok(`{"id":"x","publicId":"err_1","category":"TURN_ERROR","message":"m","connection":null}`),
	)
	_, err := c.Connections.List(bg, &ListConnectionsParams{RoomID: "room_1", State: ConnectionFailed, Limit: 10})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/connections?limit=10&roomId=room_1&state=FAILED")

	conn, err := c.Connections.Get(bg, "conn_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/connections/conn_1")
	if conn.PublicID != "conn_1" || conn.RoomID != nil || *conn.DurationMs != 1234 || len(conn.Events) != 1 || conn.Errors[0].Category != ErrorCategoryICE {
		t.Fatalf("conn %+v", conn)
	}

	_, err = c.Errors.List(bg, &ListErrorsParams{Category: ErrorCategoryTURN, ConnectionID: "conn_1", Limit: 3})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/errors?category=TURN_ERROR&connectionId=conn_1&limit=3")

	e, err := c.Errors.Get(bg, "err_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/errors/err_1")
	if e.Category != ErrorCategoryTURN || e.Connection != nil {
		t.Fatalf("error %+v", e)
	}
}

func TestMetricsAndDiagnostics(t *testing.T) {
	f, c := newFake(t,
		ok(`{"range":"24h","activeRooms":2,"activeParticipants":5,"connections":9,"connectionSuccessRate":0.98,"reconnectionRate":null,"averageConnectionDurationMs":null,"errors":1}`),
		ok(`{}`),
		ok(`{"project":{"id":"p","name":"Demo"},"api":"up","authentication":"ok","dependencies":{"signaling":"up","sfu":"down","turn":"up"},"connections":{"active":4}}`),
	)
	m, err := c.Metrics.Get(bg, MetricsRange24h)
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/metrics?range=24h")
	if m.ActiveRooms != 2 || *m.ConnectionSuccessRate != 0.98 || m.ReconnectionRate != nil {
		t.Fatalf("metrics %+v", m)
	}
	_, err = c.Metrics.Get(bg, "")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/metrics")

	d, err := c.Diagnostics.Get(bg)
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/diagnostics")
	if d.Project.Name != "Demo" || d.Dependencies.SFU != DependencyDown || d.Connections.Active != 4 {
		t.Fatalf("diagnostics %+v", d)
	}
}

func TestChat(t *testing.T) {
	f, c := newFake(t,
		ok(`{"token":"ct","tokenId":"ctk_1","userId":"u1","scopes":["chat:read"],"conversations":["conv_1"],"chatUrl":"wss://chat","apiUrl":"https://api","expiresAt":"e"}`),
		ok(`{"id":"conv_1","name":"general","type":"CHANNEL","roomId":null,"metadata":{"topic":"x"}}`),
		ok(`[]`), ok(`[]`),
		ok(`{"id":"conv_1"}`),
		ok(`{"id":"m1","userId":"u2","role":"MODERATOR","leftAt":null}`),
		fakeResponse{status: 204},
		ok(`[{"id":"m1","userId":"u2"}]`),
		ok(`{"id":"msg_1","text":"hello","type":"system","reactions":[{"emoji":"🔥","count":2,"userIds":["a","b"]}]}`),
		ok(`{"data":[{"id":"msg_1"}],"nextCursor":"cur_2","previousCursor":null,"hasMore":true}`),
		ok(`{"data":[],"nextCursor":null,"previousCursor":null,"hasMore":false}`),
		ok(`{"id":"msg_1","deleted":true,"deletedAt":"d"}`),
	)

	tok, err := c.Chat.CreateToken(bg, CreateChatTokenParams{UserID: "u1", Conversations: []string{"conv_1"}, Scopes: []ChatScope{ChatScopeRead}, ExpiresIn: 900})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/chat/tokens")
	assertJSON(t, f.last(t).Body, `{"userId":"u1","conversations":["conv_1"],"scopes":["chat:read"],"ttlSeconds":900}`)
	if tok.Token != "ct" || tok.ChatURL != "wss://chat" {
		t.Fatalf("token %+v", tok)
	}

	conv, err := c.Chat.CreateConversation(bg, CreateConversationParams{
		Name: "general", Type: ConversationChannel, RetentionDays: Int(30),
		Members:     []ChatMemberInput{{UserID: "u1", Role: ChatRoleAdmin}, {UserID: "u2"}},
		Metadata:    map[string]any{"topic": "x"},
		GetOrCreate: true,
	})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/chat/conversations")
	assertJSON(t, f.last(t).Body, `{"name":"general","type":"CHANNEL","retentionDays":30,"members":[{"userId":"u1","role":"ADMIN"},{"userId":"u2"}],"metadata":{"topic":"x"},"getOrCreate":true}`)
	if conv.Type != ConversationChannel || conv.Metadata["topic"] != "x" {
		t.Fatalf("conv %+v", conv)
	}

	_, err = c.Chat.ListConversations(bg, nil)
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/chat/conversations")
	_, err = c.Chat.ListConversations(bg, &ListConversationsParams{UserID: "u 1", IncludeArchived: Bool(false)})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/chat/conversations?includeArchived=false&userId=u+1")

	_, err = c.Chat.GetConversation(bg, "general chat/#1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/chat/conversations/general%20chat%2F%231")

	member, err := c.Chat.AddMember(bg, "conv_1", AddMemberParams{UserID: "u2", Role: ChatRoleModerator})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/chat/conversations/conv_1/members")
	assertJSON(t, f.last(t).Body, `{"userId":"u2","role":"MODERATOR"}`)
	if member.Role != ChatRoleModerator || member.LeftAt != nil {
		t.Fatalf("member %+v", member)
	}

	mustNoErr(t, c.Chat.RemoveMember(bg, "conv_1", "user@example.com"))
	assertReq(t, f.last(t), "DELETE", "/v1/chat/conversations/conv_1/members/user%40example.com")

	_, err = c.Chat.ListMembers(bg, "conv_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/chat/conversations/conv_1/members")

	msg, err := c.Chat.SendMessage(bg, "conv_1", SendChatMessageParams{Text: String("hello"), SenderID: "bot", Type: MessageSystem, ClientMessageID: "idem-1", Metadata: map[string]any{"n": 1}})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/chat/conversations/conv_1/messages")
	assertJSON(t, f.last(t).Body, `{"text":"hello","senderId":"bot","type":"system","clientMessageId":"idem-1","metadata":{"n":1}}`)
	if *msg.Text != "hello" || msg.Reactions[0].Count != 2 {
		t.Fatalf("msg %+v", msg)
	}

	page, err := c.Chat.ListMessages(bg, "conv_1", &ListChatMessagesParams{Limit: 50, Before: "cur_1", SenderID: "bot", IncludeDeleted: true})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/chat/conversations/conv_1/messages?before=cur_1&includeDeleted=true&limit=50&senderId=bot")
	if !page.HasMore || *page.NextCursor != "cur_2" || page.PreviousCursor != nil {
		t.Fatalf("page %+v", page)
	}
	_, err = c.Chat.ListMessages(bg, "conv_1", nil)
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/chat/conversations/conv_1/messages")

	del, err := c.Chat.DeleteMessage(bg, "msg_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "DELETE", "/v1/chat/messages/msg_1")
	if !del.Deleted {
		t.Fatalf("deleted %+v", del)
	}
}
