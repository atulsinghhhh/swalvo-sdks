package swalvo

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Client is Swalvo's server SDK. For your backend only.
//
// It authenticates with a permanent project API key. Never expose that key,
// or a Client, to a browser: mint short-lived tokens here and send those.
//
//	client := swalvo.New(os.Getenv("SWALVO_API_KEY"),
//		swalvo.WithBaseURL("https://api.livqeno.com"))
//	token, err := client.Tokens.Create(ctx, swalvo.CreateTokenParams{Room: roomID, Identity: "user-42"})
//
// A Client is safe for concurrent use. Its String, GoString and JSON forms
// never include the API key.
type Client struct {
	Projects    *ProjectsResource
	Tokens      *TokensResource
	Rooms       *RoomsResource
	Connections *ConnectionsResource
	Errors      *ErrorsResource
	Metrics     *MetricsResource
	Diagnostics *DiagnosticsResource
	// Chat: mint browser chat tokens, manage conversations, post server-side messages.
	Chat *ChatResource
	// LiveStreams: create streams, register hosts, mint viewer credentials,
	// manage the stage, restreams, ingest and playback.
	LiveStreams *LiveStreamsResource
	// Live is LiveStreams under the shorter name. The very same pointer, not a
	// wrapper: client.Live == client.LiveStreams.
	Live *LiveStreamsResource

	http *httpClient
}

// Option configures a Client.
type Option func(*config)

type config struct {
	baseURL    string
	timeout    time.Duration
	maxRetries int
	httpClient *http.Client
	err        *Error
}

// WithBaseURL sets the Control API host, e.g. https://api.livqeno.com.
// Defaults to http://localhost:4100 (local dev). Required in production; see New.
func WithBaseURL(baseURL string) Option {
	return func(c *config) { c.baseURL = baseURL }
}

// WithTimeout sets the per-attempt request timeout. Defaults to 10 s.
func WithTimeout(d time.Duration) Option {
	return func(c *config) {
		if d <= 0 {
			c.err = newConfigError("timeout must be positive")
			return
		}
		c.timeout = d
	}
}

// WithMaxRetries sets how many times a transient failure (network error,
// 429/502/503/504) is retried. Defaults to 2. Zero disables retries.
func WithMaxRetries(n int) Option {
	return func(c *config) {
		if n < 0 {
			n = 0
		}
		c.maxRetries = n
	}
}

// WithHTTPClient supplies the *http.Client used for requests, e.g. one with a
// custom Transport. Its own Timeout still applies on top of WithTimeout.
func WithHTTPClient(hc *http.Client) Option {
	return func(c *config) {
		if hc != nil {
			c.httpClient = hc
		}
	}
}

// New builds a Client.
//
// It never fails outright, so it fits the one-line `client := swalvo.New(...)`
// form. A configuration problem (missing API key, missing base URL in
// production, bad option) is reported by Err and returned, as a *Error with
// code RAVEN_INVALID_CONFIG, from every call. Use NewClient to get it up front.
//
// The base URL is required when SWALVO_ENV (or the deprecated RAVEN_ENV /
// LIVQENO_ENV) or NODE_ENV is "production":
// silently defaulting to localhost there only produces a confusing
// connection-refused error later.
func New(apiKey string, opts ...Option) *Client {
	cfg := config{timeout: DefaultTimeout, maxRetries: DefaultMaxRetries}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}

	h := &httpClient{
		apiKey:     newSecretKey(apiKey),
		timeout:    cfg.timeout,
		maxRetries: cfg.maxRetries,
		client:     cfg.httpClient,
		retryDelay: baseRetryDelay,
		configErr:  cfg.err,
	}
	if h.client == nil {
		h.client = &http.Client{}
	}

	base := strings.TrimRight(cfg.baseURL, "/")
	switch {
	case strings.TrimSpace(apiKey) == "":
		h.configErr = newConfigError("apiKey is required; pass your Swalvo project API key, e.g. swalvo.New(os.Getenv(\"SWALVO_API_KEY\"))")
	case base == "" && isProduction():
		h.configErr = newConfigError("baseUrl is required outside local development. Pass your Swalvo API host, e.g. " +
			"swalvo.WithBaseURL(\"https://api.livqeno.com\") (or your self-hosted deployment's URL); " +
			"omitting it defaults to " + DefaultBaseURL + ", which does not exist in production.")
	}
	if base == "" {
		base = DefaultBaseURL
	}
	if u, err := url.Parse(base); h.configErr == nil && (err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "") {
		h.configErr = newConfigError("baseUrl must be an absolute http(s) URL, e.g. https://api.livqeno.com")
	}
	h.baseURL = base

	c := &Client{http: h}
	c.Projects = &ProjectsResource{http: h}
	c.Tokens = &TokensResource{http: h}
	c.Rooms = &RoomsResource{http: h, Participants: &RoomParticipantsResource{http: h}}
	c.Connections = &ConnectionsResource{http: h}
	c.Errors = &ErrorsResource{http: h}
	c.Metrics = &MetricsResource{http: h}
	c.Diagnostics = &DiagnosticsResource{http: h}
	c.Chat = &ChatResource{http: h}
	c.LiveStreams = newLiveStreamsResource(h)
	c.Live = c.LiveStreams
	return c
}

// NewClient is New, but returns the configuration error (a *Error with code
// RAVEN_INVALID_CONFIG) immediately instead of from the first call.
func NewClient(apiKey string, opts ...Option) (*Client, error) {
	c := New(apiKey, opts...)
	if err := c.Err(); err != nil {
		return nil, err
	}
	return c, nil
}

// Err returns the client's configuration error, or nil if it is usable.
func (c *Client) Err() error {
	if c.http.configErr != nil {
		return c.http.configErr
	}
	return nil
}

// BaseURL returns the Control API host this client talks to.
func (c *Client) BaseURL() string { return c.http.baseURL }

// String never includes the API key, so a Client is safe to log.
func (c *Client) String() string { return "swalvo.Client(" + c.http.baseURL + ")" }

// GoString backs %#v; it never includes the API key.
func (c *Client) GoString() string { return c.String() }

// MarshalJSON never includes the API key.
func (c *Client) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		BaseURL string `json:"baseUrl"`
	}{c.http.baseURL})
}

func isProduction() bool {
	for _, v := range []string{envWithLegacyFallback("ENV"), os.Getenv("NODE_ENV")} {
		if strings.EqualFold(strings.TrimSpace(v), "production") {
			return true
		}
	}
	return false
}

var legacyEnvWarning sync.Once

// envWithLegacyFallback reads SWALVO_<name>, falling back to the pre-rename
// RAVEN_<name> and then LIVQENO_<name>. Using a legacy name logs one
// deprecation notice per process.
func envWithLegacyFallback(name string) string {
	if v := os.Getenv("SWALVO_" + name); v != "" {
		return v
	}
	for _, legacy := range []string{"RAVEN_" + name, "LIVQENO_" + name} {
		if v := os.Getenv(legacy); v != "" {
			legacyEnvWarning.Do(func() {
				fmt.Fprintf(os.Stderr, "swalvo: %s is deprecated; set SWALVO_%s instead\n", legacy, name)
			})
			return v
		}
	}
	return ""
}
