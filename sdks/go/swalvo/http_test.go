package swalvo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func clearProdEnv(t *testing.T) {
	t.Setenv("NODE_ENV", "")
	t.Setenv("SWALVO_ENV", "")
	t.Setenv("RAVEN_ENV", "")
	t.Setenv("LIVQENO_ENV", "")
}

func TestSendsAuthorizationAndUserAgent(t *testing.T) {
	f, c := newFake(t, ok(`{"id":"proj_1"}`))
	_, err := c.Projects.Get(context.Background())
	mustNoErr(t, err)
	r := f.last(t)
	if got := r.Header.Get("Authorization"); got != "Bearer "+testKey {
		t.Fatalf("Authorization = %q", got)
	}
	if got := r.Header.Get("User-Agent"); got != "Swalvo-Server-SDK/"+Version+" (go)" {
		t.Fatalf("User-Agent = %q", got)
	}
	if got := r.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
}

func TestDefaults(t *testing.T) {
	clearProdEnv(t)
	c := New("k")
	if err := c.Err(); err != nil {
		t.Fatalf("unexpected config error: %v", err)
	}
	if c.BaseURL() != "http://localhost:4100" {
		t.Fatalf("BaseURL = %q", c.BaseURL())
	}
	if c.http.timeout != 10*time.Second || c.http.maxRetries != 2 || c.http.retryDelay != 300*time.Millisecond {
		t.Fatalf("defaults = %v / %d / %v", c.http.timeout, c.http.maxRetries, c.http.retryDelay)
	}
	if got := New("k", WithBaseURL("https://api.example.com///")).BaseURL(); got != "https://api.example.com" {
		t.Fatalf("trailing slashes not trimmed: %q", got)
	}
}

func TestMissingAPIKeyIsInvalidConfig(t *testing.T) {
	clearProdEnv(t)
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { atomic.AddInt32(&hits, 1) }))
	defer srv.Close()

	if _, err := NewClient("", WithBaseURL(srv.URL)); !hasCode(err, CodeInvalidConfig) {
		t.Fatalf("NewClient(\"\") err = %v", err)
	}
	c := New("  ", WithBaseURL(srv.URL))
	if !hasCode(c.Err(), CodeInvalidConfig) {
		t.Fatalf("Err() = %v", c.Err())
	}
	if _, err := c.Rooms.List(context.Background()); !hasCode(err, CodeInvalidConfig) {
		t.Fatalf("call err = %v", err)
	}
	if atomic.LoadInt32(&hits) != 0 {
		t.Fatal("a misconfigured client must not send requests")
	}
}

func TestBaseURLRequiredInProduction(t *testing.T) {
	for _, env := range []string{"NODE_ENV", "SWALVO_ENV", "RAVEN_ENV", "LIVQENO_ENV"} {
		t.Run(env, func(t *testing.T) {
			clearProdEnv(t)
			t.Setenv(env, "production")
			_, err := NewClient("k")
			if !hasCode(err, CodeInvalidConfig) || !strings.Contains(err.Error(), "baseUrl is required") {
				t.Fatalf("err = %v", err)
			}
			if _, err := NewClient("k", WithBaseURL("https://api.example.com")); err != nil {
				t.Fatalf("explicit base URL rejected: %v", err)
			}
		})
	}
	clearProdEnv(t)
	t.Setenv("NODE_ENV", "development")
	if _, err := NewClient("k"); err != nil {
		t.Fatalf("development must default to localhost: %v", err)
	}
}

func TestInvalidOptions(t *testing.T) {
	clearProdEnv(t)
	if _, err := NewClient("k", WithBaseURL("not a url")); !hasCode(err, CodeInvalidConfig) {
		t.Fatalf("bad base URL err = %v", err)
	}
	if _, err := NewClient("k", WithTimeout(0)); !hasCode(err, CodeInvalidConfig) {
		t.Fatalf("zero timeout err = %v", err)
	}
}

func TestQueryEncodingOmitsEmptyValues(t *testing.T) {
	f, c := newFake(t, ok(`[]`), ok(`[]`))
	_, err := c.Connections.List(context.Background(), &ListConnectionsParams{RoomID: "room 1&x=y", State: ConnectionConnected, Limit: 5})
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/connections?limit=5&roomId=room+1%26x%3Dy&state=CONNECTED")

	_, err = c.Connections.List(context.Background(), nil)
	mustNoErr(t, err)
	assertReq(t, f.last(t), "GET", "/v1/connections")
}

func TestNoContentReturnsNil(t *testing.T) {
	f, c := newFake(t, fakeResponse{status: 204})
	mustNoErr(t, c.Rooms.Delete(context.Background(), "room_1"))
	assertReq(t, f.last(t), "DELETE", "/v1/rooms/room_1")
}

func TestRetries503ThenSucceeds(t *testing.T) {
	f, c := newFake(t,
		fakeResponse{status: 503, body: `{"message":"unavailable"}`},
		fakeResponse{status: 503, body: `{"message":"unavailable"}`},
		ok(`[{"id":"room_1"}]`),
	)
	rooms, err := c.Rooms.List(context.Background())
	mustNoErr(t, err)
	if len(rooms) != 1 || rooms[0].ID != "room_1" || len(f.requests()) != 3 {
		t.Fatalf("rooms=%v requests=%d", rooms, len(f.requests()))
	}
}

func TestRetries502And504(t *testing.T) {
	for _, status := range []int{502, 504} {
		f, c := newFake(t, fakeResponse{status: status}, ok(`[]`))
		_, err := c.Rooms.List(context.Background())
		mustNoErr(t, err)
		if n := len(f.requests()); n != 2 {
			t.Fatalf("%d: %d requests", status, n)
		}
	}
}

func TestRetriesExhaustedReturnsLastError(t *testing.T) {
	f, c := newFake(t,
		fakeResponse{status: 503}, fakeResponse{status: 503},
		fakeResponse{status: 503, body: `{"code":"RAVEN_CAPACITY_EXCEEDED","message":"busy"}`},
	)
	_, err := c.Rooms.List(context.Background())
	lerr, isErr := AsError(err)
	if !isErr || lerr.StatusCode != 503 || lerr.Code != "RAVEN_CAPACITY_EXCEEDED" {
		t.Fatalf("err = %v", err)
	}
	if n := len(f.requests()); n != 3 {
		t.Fatalf("%d requests, want 1 + 2 retries", n)
	}
}

// The TypeScript client does not read Retry-After, so neither does this one:
// a 429 is retried on the normal backoff schedule. Retry-After: 30 here would
// stall the test for 30 s if it were honoured.
func TestRetries429WithRetryAfterOnBackoffSchedule(t *testing.T) {
	f, c := newFake(t,
		fakeResponse{status: 429, body: `{"code":"RAVEN_RATE_LIMITED","message":"slow down"}`, headers: map[string]string{"Retry-After": "30"}},
		ok(`{"id":"proj_1","name":"p"}`),
	)
	start := time.Now()
	proj, err := c.Projects.Get(context.Background())
	mustNoErr(t, err)
	if proj.ID != "proj_1" || len(f.requests()) != 2 {
		t.Fatalf("project=%v requests=%d", proj, len(f.requests()))
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("waited on Retry-After instead of the backoff schedule")
	}
}

func TestNeverRetriesClientErrors(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 409, 422} {
		f, c := newFake(t, fakeResponse{status: status, body: `{"message":"no"}`})
		_, err := c.Rooms.Get(context.Background(), "room_1")
		if lerr, _ := AsError(err); lerr == nil || lerr.StatusCode != status {
			t.Fatalf("%d: err = %v", status, err)
		}
		if n := len(f.requests()); n != 1 {
			t.Fatalf("%d was retried: %d requests", status, n)
		}
	}
}

func TestNoRetryFlagIsHonoured(t *testing.T) {
	f, c := newFake(t, fakeResponse{status: 503})
	err := c.http.request(context.Background(), "/v1/rooms", requestOptions{noRetry: true}, nil)
	if !hasCode(err, CodeInternalError) || len(f.requests()) != 1 {
		t.Fatalf("err=%v requests=%d", err, len(f.requests()))
	}
}

func TestBackoffIsExponentialFrom300ms(t *testing.T) {
	h := &httpClient{retryDelay: baseRetryDelay}
	for attempt, want := range []time.Duration{300 * time.Millisecond, 600 * time.Millisecond, 1200 * time.Millisecond} {
		if got := h.retryDelay << attempt; got != want {
			t.Fatalf("attempt %d: %v, want %v", attempt, got, want)
		}
	}
}

func TestNetworkErrorRetriedThenMapped(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		conn, _, _ := w.(http.Hijacker).Hijack()
		_ = conn.Close() // drop the connection without a response
	}))
	defer srv.Close()
	c := newTestClient(t, srv.URL)

	_, err := c.Rooms.List(context.Background())
	if !hasCode(err, CodeNetworkError) {
		t.Fatalf("err = %v", err)
	}
	if n := atomic.LoadInt32(&hits); n != 3 {
		t.Fatalf("%d attempts, want 3", n)
	}
	if errors.Unwrap(err) == nil {
		t.Fatal("network error should wrap its cause")
	}
}

func slowServer(t *testing.T, hits *int32) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestTimeout(t *testing.T) {
	var hits int32
	srv := slowServer(t, &hits)
	c := newTestClient(t, srv.URL, WithTimeout(30*time.Millisecond), WithMaxRetries(0))

	start := time.Now()
	_, err := c.Rooms.List(context.Background())
	if !hasCode(err, CodeTimeout) || !strings.Contains(err.Error(), "timed out after 30ms") {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("timeout not enforced")
	}

	// Timeouts are transient: retried like any network failure.
	atomic.StoreInt32(&hits, 0)
	c = newTestClient(t, srv.URL, WithTimeout(30*time.Millisecond), WithMaxRetries(2))
	_, err = c.Rooms.List(context.Background())
	if !hasCode(err, CodeTimeout) || atomic.LoadInt32(&hits) != 3 {
		t.Fatalf("err=%v hits=%d", err, hits)
	}
}

func TestCallerCancellationIsNotRetried(t *testing.T) {
	var hits int32
	srv := slowServer(t, &hits)
	c := newTestClient(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := c.Rooms.List(ctx)
	if !hasCode(err, CodeTimeout) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	if n := atomic.LoadInt32(&hits); n != 1 {
		t.Fatalf("%d attempts after the caller's deadline", n)
	}
}

func TestErrorDecoding(t *testing.T) {
	_, c := newFake(t, fakeResponse{
		status:  404,
		body:    `{"code":"RAVEN_ROOM_NOT_FOUND","message":"Room not found","statusCode":404}`,
		headers: map[string]string{"x-request-id": "req_abc123"},
	})
	_, err := c.Rooms.Get(context.Background(), "room_x")

	var lerr *Error
	if !errors.As(err, &lerr) {
		t.Fatalf("not a *Error: %T", err)
	}
	if lerr.Code != "RAVEN_ROOM_NOT_FOUND" || lerr.StatusCode != 404 || lerr.Message != "Room not found" || lerr.RequestID != "req_abc123" {
		t.Fatalf("decoded %+v", lerr)
	}
	details, isMap := lerr.Details.(map[string]any)
	if !isMap || details["code"] != "RAVEN_ROOM_NOT_FOUND" {
		t.Fatalf("details = %#v", lerr.Details)
	}
	want := "swalvo: Room not found (code=RAVEN_ROOM_NOT_FOUND, status=404, request_id=req_abc123)"
	if lerr.Error() != want {
		t.Fatalf("Error() = %q", lerr.Error())
	}
}

func TestErrorMessageArrayIsJoined(t *testing.T) {
	_, c := newFake(t, fakeResponse{status: 400, body: `{"message":["name must be a string","name should not be empty"],"code":"VALIDATION_ERROR"}`})
	_, err := c.Rooms.Create(context.Background(), CreateRoomParams{})
	if lerr, _ := AsError(err); lerr == nil || lerr.Message != "name must be a string; name should not be empty" {
		t.Fatalf("err = %v", err)
	}
}

func TestErrorCodeDerivedFromStatusWhenBodyHasNone(t *testing.T) {
	cases := map[int]string{401: "RAVEN_AUTH_ERROR", 403: "RAVEN_PERMISSION_DENIED", 404: "RAVEN_NOT_FOUND", 429: "RAVEN_RATE_LIMITED", 503: "RAVEN_INTERNAL_ERROR", 400: "VALIDATION_ERROR"}
	for status, code := range cases {
		f, _ := newFake(t, fakeResponse{status: status, body: "<html>Gateway error</html>"})
		c := newTestClient(t, f.srv.URL, WithMaxRetries(0))
		_, err := c.Rooms.List(context.Background())
		lerr, _ := AsError(err)
		if lerr == nil || lerr.Code != code || lerr.Details != nil || lerr.Message != fmt.Sprintf("Request failed with status %d", status) {
			t.Fatalf("%d: err = %v", status, err)
		}
	}
}

func TestUndecodableSuccessBodyIsAnError(t *testing.T) {
	_, c := newFake(t, ok(`{"id": 42}`))
	_, err := c.Rooms.Get(context.Background(), "room_1")
	if !hasCode(err, CodeUnknownError) {
		t.Fatalf("err = %v", err)
	}
}

func TestAPIKeyNeverAppearsInFormattedOutput(t *testing.T) {
	_, c := newFake(t)
	outputs := []string{
		fmt.Sprint(c), fmt.Sprintf("%v", c), fmt.Sprintf("%+v", c), fmt.Sprintf("%#v", c), fmt.Sprintf("%s", c),
		fmt.Sprintf("%+v", *c), fmt.Sprintf("%#v", *c),
		fmt.Sprintf("%+v", c.http), fmt.Sprintf("%#v", c.http), fmt.Sprintf("%+v", *c.http), fmt.Sprintf("%#v", *c.http),
		fmt.Sprintf("%+v", c.Rooms), fmt.Sprintf("%+v", *c.Rooms), fmt.Sprintf("%#v", *c.LiveStreams),
	}
	js, _ := json.Marshal(c)
	outputs = append(outputs, string(js))
	var logged strings.Builder
	slog.New(slog.NewTextHandler(&logged, nil)).Info("client", "client", c, "rooms", c.Rooms)
	outputs = append(outputs, logged.String())

	for _, out := range outputs {
		if strings.Contains(out, "dontleakme") || strings.Contains(out, "rvk_super") || strings.Contains(out, fmt.Sprintf("%x", testKey)) {
			t.Fatalf("API key leaked: %s", out)
		}
	}
	if !strings.Contains(fmt.Sprint(c), c.BaseURL()) {
		t.Fatalf("String() should name the base URL: %s", c)
	}
}

func TestAPIKeyNeverAppearsInErrors(t *testing.T) {
	// A misbehaving proxy that echoes the request (headers included) back.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code":    "VALIDATION_FAILED",
			"message": "bad request, you sent " + r.Header.Get("Authorization"),
			"echo":    map[string]any{"headers": []any{r.Header.Get("Authorization")}},
		})
	}))
	defer srv.Close()
	c := newTestClient(t, srv.URL)
	_, err := c.Rooms.List(context.Background())
	lerr, _ := AsError(err)
	if lerr == nil {
		t.Fatalf("err = %v", err)
	}
	js, _ := json.Marshal(lerr)
	for _, out := range []string{err.Error(), fmt.Sprintf("%+v", err), fmt.Sprintf("%#v", lerr), fmt.Sprintf("%v", lerr.Details), string(js)} {
		if strings.Contains(out, "dontleakme") {
			t.Fatalf("API key leaked into error: %s", out)
		}
	}

	// Network errors and timeouts too.
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close()
	c = newTestClient(t, dead.URL, WithMaxRetries(0))
	_, err = c.Rooms.List(context.Background())
	if !hasCode(err, CodeNetworkError) || strings.Contains(fmt.Sprintf("%+v %v", err, errors.Unwrap(err)), "dontleakme") {
		t.Fatalf("err = %v", err)
	}
}

func hasCode(err error, code string) bool {
	lerr, isErr := AsError(err)
	return isErr && lerr.Code == code
}
