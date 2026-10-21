package swalvo

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"
)

const testKey = "rvk_super-secret-value.dontleakme"

type recorded struct {
	Method     string
	RequestURI string // raw path + query, exactly as sent
	Header     http.Header
	Body       []byte
}

type fakeResponse struct {
	status  int
	body    string
	headers map[string]string
}

// fakeAPI is an httptest.Server that records every request and replies from
// a queue (then {} 200 once the queue is empty).
type fakeAPI struct {
	mu        sync.Mutex
	reqs      []recorded
	responses []fakeResponse
	srv       *httptest.Server
}

func newFake(t *testing.T, responses ...fakeResponse) (*fakeAPI, *Client) {
	t.Helper()
	f := &fakeAPI{responses: responses}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.reqs = append(f.reqs, recorded{Method: r.Method, RequestURI: r.RequestURI, Header: r.Header.Clone(), Body: body})
		resp := fakeResponse{status: 200, body: "{}"}
		if len(f.responses) > 0 {
			resp = f.responses[0]
			f.responses = f.responses[1:]
		}
		f.mu.Unlock()
		for k, v := range resp.headers {
			w.Header().Set(k, v)
		}
		if resp.status == 0 {
			resp.status = 200
		}
		w.WriteHeader(resp.status)
		_, _ = io.WriteString(w, resp.body)
	}))
	t.Cleanup(f.srv.Close)
	return f, newTestClient(t, f.srv.URL)
}

func newTestClient(t *testing.T, baseURL string, opts ...Option) *Client {
	t.Helper()
	c, err := NewClient(testKey, append([]Option{WithBaseURL(baseURL)}, opts...)...)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c.http.retryDelay = time.Millisecond // keep retry tests fast; the schedule itself is tested separately
	return c
}

func (f *fakeAPI) requests() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.reqs...)
}

func (f *fakeAPI) last(t *testing.T) recorded {
	t.Helper()
	reqs := f.requests()
	if len(reqs) == 0 {
		t.Fatal("no request was made")
	}
	return reqs[len(reqs)-1]
}

func ok(body string) fakeResponse { return fakeResponse{status: 200, body: body} }

func assertJSON(t *testing.T, got []byte, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("request body is not JSON: %q", got)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("bad expectation %q", want)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

func assertReq(t *testing.T, r recorded, method, uri string) {
	t.Helper()
	if r.Method != method || r.RequestURI != uri {
		t.Fatalf("got %s %s, want %s %s", r.Method, r.RequestURI, method, uri)
	}
}

func assertNoBody(t *testing.T, r recorded) {
	t.Helper()
	if len(r.Body) != 0 {
		t.Fatalf("expected no body, got %q", r.Body)
	}
}

func mustNoErr(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
