package swalvo

import "testing"

const streamJSON = `{"id":"stream_1","title":"Launch","description":null,"thumbnailUrl":null,"category":null,"tags":["a"],"language":null,
  "visibility":"PUBLIC","metadata":null,"status":"LIVE","hosts":[{"identity":"host-1","role":"HOST","invitedAt":"i"}],
  "viewerCount":null,"peakViewerCount":7,
  "delivery":{"mode":"BROADCAST","status":"READY","playbackUrl":"https://cdn/x.m3u8","llhlsPlaybackUrl":"https://edge/ll.m3u8","recordingUrl":null,"recordingDurationSec":null},
  "conversationId":"conv_1","chatRootMessageId":"msg_root","scheduledAt":null,"startedAt":"s","endedAt":null,"createdAt":"c","updatedAt":"u"}`

func TestLiveStreamsLifecycle(t *testing.T) {
	f, c := newFake(t,
		ok(streamJSON), ok(`[]`), ok(`[]`), ok(streamJSON), ok(streamJSON), ok(streamJSON), ok(streamJSON),
	)

	s, err := c.LiveStreams.Create(bg, CreateLiveStreamParams{
		Title: "Launch", HostIdentity: "host-1", Tags: []string{"a"}, Visibility: VisibilityPublic,
		DeliveryMode: DeliveryBroadcast, EdgeScaling: Bool(true), Metadata: map[string]any{"k": "v"},
	})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/live-streams")
	assertJSON(t, f.last(t).Body, `{"title":"Launch","hostIdentity":"host-1","tags":["a"],"visibility":"PUBLIC","deliveryMode":"BROADCAST","edgeScaling":true,"metadata":{"k":"v"}}`)
	if s.ViewerCount != nil || s.PeakViewerCount != 7 || s.Hosts[0].Role != RoleHost || *s.ChatRootMessageID != "msg_root" {
		t.Fatalf("stream %+v", s)
	}
	if s.Delivery == nil || s.Delivery.Mode != DeliveryBroadcast || *s.Delivery.LLHLSPlaybackURL != "https://edge/ll.m3u8" || *s.Delivery.PlaybackURL != "https://cdn/x.m3u8" || s.Delivery.RecordingURL != nil {
		t.Fatalf("delivery %+v", s.Delivery)
	}

	_, err = c.LiveStreams.List(bg, nil)
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/live-streams")
	_, err = c.LiveStreams.List(bg, &ListLiveStreamsParams{Status: LiveStreamLive})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/live-streams?status=LIVE")

	_, err = c.LiveStreams.Get(bg, "stream_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/live-streams/stream_1")

	_, err = c.LiveStreams.Update(bg, "stream_1", UpdateLiveStreamParams{Title: String("New"), Description: String("")})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "PATCH", "/v1/live-streams/stream_1")
	assertJSON(t, f.last(t).Body, `{"title":"New","description":""}`)

	_, err = c.LiveStreams.Start(bg, "stream_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/start")
	assertNoBody(t, f.last(t))

	_, err = c.Live.End(bg, "stream_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/end")
	assertNoBody(t, f.last(t))
}

func TestLiveStreamsHostsAndViewers(t *testing.T) {
	f, c := newFake(t,
		ok(`{"streamId":"stream_1","identity":"cohost","role":"CO_HOST","rtc":{"token":"rt","endpoint":"wss://sfu"},"chat":{"token":"ct"},"chatRootMessageId":null,"rtcRoom":"stream_1"}`),
		fakeResponse{status: 204},
		ok(`{"streamId":"stream_1","identity":"dave","role":"VIEWER","rtc":{"token":"rt"},"chat":{"token":"ct"},"chatRootMessageId":"r","rtcRoom":"edge_room_2"}`),
		ok(`{"streamId":"stream_1","identity":"dave","role":"VIEWER","chat":{"token":"ct"},"chatRootMessageId":"r",
		     "playback":{"url":"https://cdn/x.m3u8","llhlsUrl":"https://edge/ll.m3u8","status":"STARTING"}}`),
		ok(`{"mode":"BROADCAST","status":"READY","playbackUrl":"https://cdn/x.m3u8","llhlsPlaybackUrl":"https://edge/ll.m3u8","recordingUrl":null,"recordingDurationSec":null}`),
		fakeResponse{status: 204},
	)

	host, err := c.LiveStreams.AddHost(bg, "stream_1", AddHostParams{Identity: "cohost", Role: RoleCoHost})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/hosts")
	assertJSON(t, f.last(t).Body, `{"identity":"cohost","role":"CO_HOST"}`)
	if host.Role != RoleCoHost || host.RTC.Token != "rt" || host.RTCRoom != "stream_1" || host.Playback != nil {
		t.Fatalf("host %+v", host)
	}

	mustNoErr(t, c.LiveStreams.RemoveHost(bg, "stream_1", "co host"))
	assertReq(t, f.last(t), "DELETE", "/v1/live-streams/stream_1/hosts/co%20host")

	// Never a role in the viewer body; acceptPlayback only when asked.
	viewer, err := c.LiveStreams.CreateViewerToken(bg, "stream_1", "dave", nil)
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/viewer-tokens")
	assertJSON(t, f.last(t).Body, `{"identity":"dave"}`)
	if viewer.Role != RoleViewer || viewer.RTCRoom != "edge_room_2" {
		t.Fatalf("viewer %+v", viewer)
	}

	pb, err := c.LiveStreams.CreateViewerToken(bg, "stream_1", "dave", &ViewerTokenOptions{AcceptPlayback: true})
	mustNoErr(t, err)
	assertJSON(t, f.last(t).Body, `{"identity":"dave","acceptPlayback":true}`)
	if pb.RTC != nil || pb.RTCRoom != "" || pb.Playback == nil || *pb.Playback.URL != "https://cdn/x.m3u8" || *pb.Playback.LLHLSURL != "https://edge/ll.m3u8" || pb.Playback.Status != "STARTING" {
		t.Fatalf("playback credential %+v / %+v", pb, pb.Playback)
	}

	d, err := c.LiveStreams.Playback(bg, "stream_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/live-streams/stream_1/playback")
	if d.Status != "READY" || *d.LLHLSPlaybackURL != "https://edge/ll.m3u8" {
		t.Fatalf("delivery %+v", d)
	}

	mustNoErr(t, c.LiveStreams.Leave(bg, "stream_1", "dave"))
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/leave")
	assertJSON(t, f.last(t).Body, `{"identity":"dave"}`)
}

func TestLiveStreamsStage(t *testing.T) {
	f, c := newFake(t,
		fakeResponse{status: 204},
		ok(`{"streamId":"stream_1","identity":"dave","role":"CO_HOST","rtc":{"token":"rt"}}`),
		ok(`{"streamId":"stream_1","identity":"dave","role":"HOST"}`),
		fakeResponse{status: 204},
	)
	mustNoErr(t, c.LiveStreams.Stage.Invite(bg, "stream_1", "dave"))
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/stage/invites")
	assertJSON(t, f.last(t).Body, `{"identity":"dave"}`)

	cred, err := c.LiveStreams.Stage.Promote(bg, "stream_1", "dave", nil)
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/stage/promote")
	assertJSON(t, f.last(t).Body, `{"identity":"dave"}`)
	if cred.Role != RoleCoHost || cred.RTC.Token != "rt" {
		t.Fatalf("cred %+v", cred)
	}
	_, err = c.LiveStreams.Stage.Promote(bg, "stream_1", "dave", &StagePromoteOptions{Role: RoleHost})
	mustNoErr(t, err)
	assertJSON(t, f.last(t).Body, `{"identity":"dave","role":"HOST"}`)

	mustNoErr(t, c.Live.Stage.Demote(bg, "stream_1", "dave"))
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/stage/demote")
	assertJSON(t, f.last(t).Body, `{"identity":"dave"}`)
}

func TestLiveStreamsRestreams(t *testing.T) {
	view := `{"id":"rst_1","label":"YouTube","url":"rtmps://a.rtmp.youtube.com/live2","keyLast4":"abcd","enabled":true,"status":"IDLE","lastError":null,"attempts":0,"connectedAt":null,"createdAt":"c","updatedAt":"u"}`
	f, c := newFake(t, ok(view), ok(`[`+view+`]`), ok(view), fakeResponse{status: 204})

	r, err := c.LiveStreams.Restreams.Create(bg, "stream_1", CreateRestreamParams{URL: "rtmps://a.rtmp.youtube.com/live2", StreamKey: "xxxx-abcd", Label: "YouTube"})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/restreams")
	assertJSON(t, f.last(t).Body, `{"url":"rtmps://a.rtmp.youtube.com/live2","streamKey":"xxxx-abcd","label":"YouTube"}`)
	if r.KeyLast4 != "abcd" || r.Status != RestreamIdle || r.LastError != nil {
		t.Fatalf("restream %+v", r)
	}

	list, err := c.LiveStreams.Restreams.List(bg, "stream_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/live-streams/stream_1/restreams")
	if len(list) != 1 {
		t.Fatalf("list %+v", list)
	}

	// enabled:false must be sent, not dropped as a zero value.
	_, err = c.LiveStreams.Restreams.Update(bg, "stream 1", "rst/1", UpdateRestreamParams{Enabled: Bool(false)})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "PATCH", "/v1/live-streams/stream%201/restreams/rst%2F1")
	assertJSON(t, f.last(t).Body, `{"enabled":false}`)

	mustNoErr(t, c.LiveStreams.Restreams.Delete(bg, "stream_1", "rst_1"))
	assertReq(t, f.last(t), "DELETE", "/v1/live-streams/stream_1/restreams/rst_1")
}

func TestLiveStreamsIngress(t *testing.T) {
	withKey := `{"id":"ing_1","protocol":"RTMP","identity":"host-1","keyPrefix":"sk_ab","autoStart":false,"status":"IDLE","reconnectWindowSec":30,
	  "lastError":null,"inputVideo":{"codec":"h264","width":1920,"height":1080,"fps":30},"inputAudio":null,
	  "whipUrl":"https://w","rtmpUrl":"rtmp://r","rtmpsUrl":"rtmps://r","connectedAt":null,"disconnectedAt":null,"createdAt":"c","updatedAt":"u","streamKey":"sk_abcdef"}`
	f, c := newFake(t, ok(withKey), ok(withKey), ok(`{"id":"ing_1","status":"PUBLISHING"}`), ok(withKey), fakeResponse{status: 204})

	ing, err := c.LiveStreams.Ingress.Create(bg, "stream_1", &CreateIngressParams{Protocol: IngressRTMP, Identity: "host-1", AutoStart: Bool(false), ReconnectWindowSec: Int(30)})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/ingress")
	assertJSON(t, f.last(t).Body, `{"protocol":"RTMP","identity":"host-1","autoStart":false,"reconnectWindowSec":30}`)
	if ing.StreamKey != "sk_abcdef" || ing.ID != "ing_1" || *ing.InputVideo.Width != 1920 || ing.InputAudio != nil {
		t.Fatalf("ingress %+v", ing)
	}

	_, err = c.LiveStreams.Ingress.Create(bg, "stream_1", nil)
	mustNoErr(t, err)
	assertJSON(t, f.last(t).Body, `{}`)

	got, err := c.LiveStreams.Ingress.Get(bg, "stream_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/live-streams/stream_1/ingress")
	if got.Status != IngressPublishing {
		t.Fatalf("ingress %+v", got)
	}

	_, err = c.LiveStreams.Ingress.Reset(bg, "stream_1")
	mustNoErr(t, err)
	assertReq(t, f.last(t), "POST", "/v1/live-streams/stream_1/ingress/reset")
	assertNoBody(t, f.last(t))

	mustNoErr(t, c.LiveStreams.Ingress.Delete(bg, "stream_1"))
	assertReq(t, f.last(t), "DELETE", "/v1/live-streams/stream_1/ingress")
}

func TestPathSegmentsMatchEncodeURIComponent(t *testing.T) {
	cases := map[string]string{
		"stream_1":        "stream_1",
		"a b":             "a%20b",
		"a/b?c#d":         "a%2Fb%3Fc%23d",
		"user@x.com":      "user%40x.com",
		"-_.!~*'()":       "-_.!~*'()",
		"a+b=c&d:e;f,g$h": "a%2Bb%3Dc%26d%3Ae%3Bf%2Cg%24h",
		"é":               "%C3%A9",
	}
	for in, want := range cases {
		if got := encodePathSegment(in); got != want {
			t.Errorf("encodePathSegment(%q) = %q, want %q", in, got, want)
		}
	}
}
