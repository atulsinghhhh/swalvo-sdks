package swalvo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// DefaultBaseURL is the local development Control API. Override it with
	// WithBaseURL for any real deployment.
	DefaultBaseURL = "http://localhost:4100"
	// DefaultTimeout is the per-attempt request timeout.
	DefaultTimeout = 10 * time.Second
	// DefaultMaxRetries is how many times a transient failure is retried.
	DefaultMaxRetries = 2

	baseRetryDelay = 300 * time.Millisecond
)

// userAgent names the SDK and its version, like the TypeScript
// ("Swalvo-Server-SDK/x (node)") and Python ("... (python)") SDKs.
var userAgent = "Swalvo-Server-SDK/" + Version + " (go)"

func isRetryableStatus(status int) bool {
	switch status {
	case 429, 502, 503, 504:
		return true
	}
	return false
}

// secretKey hands out the API key. It is a closure rather than a string
// field so that no formatting path (fmt's %+v on the struct, a reflection
// dumper, json.Marshal) can reach the key itself: they only see a func.
type secretKey func() string

func newSecretKey(key string) secretKey { return func() string { return key } }

// httpClient is the one place this SDK speaks HTTP to the Control API. Every
// resource goes through it; none builds a request of its own.
type httpClient struct {
	apiKey     secretKey
	baseURL    string
	timeout    time.Duration
	maxRetries int
	client     *http.Client
	retryDelay time.Duration
	configErr  *Error
}

func (h *httpClient) String() string   { return "SwalvoHttpClient(" + h.baseURL + ")" }
func (h *httpClient) GoString() string { return h.String() }

type requestOptions struct {
	method string
	query  url.Values
	body   any
	// noRetry mirrors `retryable: false` in the TypeScript client: never
	// retried, transient failure or not.
	noRetry bool
}

// request performs one API call and decodes a successful JSON body into out
// (which may be nil). A 204 leaves out untouched.
func (h *httpClient) request(ctx context.Context, path string, opts requestOptions, out any) error {
	if h.configErr != nil {
		return h.configErr
	}
	if ctx == nil {
		ctx = context.Background()
	}
	method := opts.method
	if method == "" {
		method = http.MethodGet
	}

	rawURL := h.baseURL + path
	if len(opts.query) > 0 {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		rawURL += sep + opts.query.Encode()
	}

	var payload []byte
	if opts.body != nil {
		b, err := json.Marshal(opts.body)
		if err != nil {
			return &Error{Code: CodeUnknownError, Message: "Could not encode the request body", cause: err}
		}
		payload = b
	}

	attempt := 0
	for {
		status, header, body, err := h.do(ctx, method, rawURL, payload)
		if err != nil {
			// The caller's own context ending is final: never retried.
			if ctxErr := ctx.Err(); ctxErr != nil {
				code := CodeNetworkError
				msg := "Request canceled"
				if errors.Is(ctxErr, context.DeadlineExceeded) {
					code = CodeTimeout
					msg = "Request deadline exceeded"
				}
				return &Error{Code: code, Message: msg, cause: ctxErr}
			}
			if !opts.noRetry && attempt < h.maxRetries {
				if serr := h.sleep(ctx, attempt); serr != nil {
					return serr
				}
				attempt++
				continue
			}
			if isTimeout(err) {
				return &Error{Code: CodeTimeout, Message: fmt.Sprintf("Request timed out after %dms", h.timeout.Milliseconds()), cause: err}
			}
			return &Error{Code: CodeNetworkError, Message: "Could not reach the Swalvo API", cause: err}
		}

		requestID := header.Get("x-request-id")

		if status == http.StatusNoContent {
			return nil
		}

		if status >= 200 && status < 300 {
			if out == nil || len(bytes.TrimSpace(body)) == 0 {
				return nil
			}
			if derr := json.Unmarshal(body, out); derr != nil {
				return &Error{
					Code:       CodeUnknownError,
					StatusCode: status,
					Message:    "Could not decode the Swalvo API response",
					RequestID:  requestID,
					cause:      derr,
				}
			}
			return nil
		}

		if !opts.noRetry && isRetryableStatus(status) && attempt < h.maxRetries {
			if serr := h.sleep(ctx, attempt); serr != nil {
				return serr
			}
			attempt++
			continue
		}

		var decoded any
		if len(body) > 0 {
			if json.Unmarshal(body, &decoded) != nil {
				decoded = nil
			}
		}
		return scrubSecret(mapErrorResponse(status, decoded, requestID), h.apiKey())
	}
}

func (h *httpClient) do(ctx context.Context, method, rawURL string, payload []byte) (int, http.Header, []byte, error) {
	attemptCtx, cancel := context.WithTimeout(ctx, h.timeout)
	defer cancel()

	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(attemptCtx, method, rawURL, reader)
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.apiKey())
	req.Header.Set("User-Agent", userAgent)

	resp, err := h.client.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, nil, err
	}
	return resp.StatusCode, resp.Header, body, nil
}

// sleep waits out the exponential backoff (300 ms, 600 ms, 1.2 s, ...), the
// same schedule as the TypeScript client. Like that client it does not read
// Retry-After.
func (h *httpClient) sleep(ctx context.Context, attempt int) error {
	delay := h.retryDelay << attempt
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		code := CodeNetworkError
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = CodeTimeout
		}
		return &Error{Code: code, Message: "Request canceled while waiting to retry", cause: ctx.Err()}
	}
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var te interface{ Timeout() bool }
	return errors.As(err, &te) && te.Timeout()
}

// encodePathSegment matches JavaScript's encodeURIComponent, which the
// TypeScript SDK uses on every id it puts in a path.
func encodePathSegment(s string) string {
	const unreserved = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// p joins path segments, encoding each dynamic one.
func p(format string, segments ...string) string {
	args := make([]any, len(segments))
	for i, s := range segments {
		args[i] = encodePathSegment(s)
	}
	return fmt.Sprintf(format, args...)
}

// scrubSecret removes the API key from an error built from a response body,
// in case a misbehaving proxy or server echoes the request back.
func scrubSecret(e *Error, secret string) *Error {
	if secret == "" {
		return e
	}
	e.Message = strings.ReplaceAll(e.Message, secret, "[REDACTED]")
	e.Details = scrubValue(e.Details, secret)
	return e
}

func scrubValue(v any, secret string) any {
	switch t := v.(type) {
	case string:
		return strings.ReplaceAll(t, secret, "[REDACTED]")
	case map[string]any:
		for k, item := range t {
			t[k] = scrubValue(item, secret)
		}
		return t
	case []any:
		for i, item := range t {
			t[i] = scrubValue(item, secret)
		}
		return t
	}
	return v
}
