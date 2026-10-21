package swalvo

import (
	"errors"
	"fmt"
	"strings"
)

// Error codes the SDK itself produces. Every other code comes straight from
// the API response body (for example RAVEN_ROOM_NOT_FOUND) and is passed
// through untouched. See docs/error-codes.md for the full vocabulary.
const (
	CodeInvalidConfig    = "RAVEN_INVALID_CONFIG"
	CodeTimeout          = "RAVEN_TIMEOUT"
	CodeNetworkError     = "RAVEN_NETWORK_ERROR"
	CodeUnknownError     = "RAVEN_UNKNOWN_ERROR"
	CodeAuthError        = "RAVEN_AUTH_ERROR"
	CodePermissionDenied = "RAVEN_PERMISSION_DENIED"
	CodeNotFound         = "RAVEN_NOT_FOUND"
	CodeRateLimited      = "RAVEN_RATE_LIMITED"
	CodeInternalError    = "RAVEN_INTERNAL_ERROR"
	CodeValidationError  = "VALIDATION_ERROR"
)

// Error is the only error type this SDK returns from an API call.
//
// It is built purely from the parsed response body ({message, code}, matching
// AppError on the API side) plus response metadata. Never from anything that
// could carry the API key, so there is no route by which a key ends up in
// here.
//
//	var lerr *swalvo.Error
//	if errors.As(err, &lerr) && lerr.Code == "RAVEN_ROOM_NOT_FOUND" { ... }
type Error struct {
	// Code is the API's error code, e.g. RAVEN_ROOM_NOT_FOUND, or one the SDK
	// derives (RAVEN_TIMEOUT, RAVEN_NETWORK_ERROR, RAVEN_INVALID_CONFIG, ...).
	Code string
	// StatusCode is the HTTP status, or 0 when no response was received.
	StatusCode int
	// Message is the human-readable message from the API (or the SDK).
	Message string
	// RequestID is the x-request-id the API sent, if any. Quote it in bug reports.
	RequestID string
	// Details is the decoded JSON error body, or nil when it wasn't JSON.
	Details any

	cause error
}

// Error implements the error interface. The output never contains the API key.
func (e *Error) Error() string {
	var b strings.Builder
	b.WriteString("swalvo: ")
	b.WriteString(e.Message)
	b.WriteString(" (code=")
	b.WriteString(e.Code)
	if e.StatusCode != 0 {
		fmt.Fprintf(&b, ", status=%d", e.StatusCode)
	}
	if e.RequestID != "" {
		b.WriteString(", request_id=")
		b.WriteString(e.RequestID)
	}
	b.WriteString(")")
	return b.String()
}

// Unwrap returns the underlying transport error (for network failures and
// timeouts), so errors.Is(err, context.DeadlineExceeded) works.
func (e *Error) Unwrap() error { return e.cause }

// AsError reports whether err is (or wraps) a *Error and returns it.
// It mirrors isSwalvoError in the TypeScript SDK.
func AsError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

func newConfigError(message string) *Error {
	return &Error{Code: CodeInvalidConfig, Message: message}
}

func codeForStatus(status int) string {
	// Same names the API returns, on purpose, so a 401 surfaces as
	// RAVEN_AUTH_ERROR whether the code came from the body or from here. This
	// fallback only fires when a proxy has eaten the JSON body.
	switch {
	case status == 401:
		return CodeAuthError
	case status == 403:
		return CodePermissionDenied
	case status == 404:
		return CodeNotFound
	case status == 429:
		return CodeRateLimited
	case status >= 500:
		return CodeInternalError
	default:
		return CodeValidationError
	}
}

func mapErrorResponse(status int, payload any, requestID string) *Error {
	message, ok := extractMessage(payload)
	if !ok {
		message = fmt.Sprintf("Request failed with status %d", status)
	}
	code, ok := extractCode(payload)
	if !ok {
		code = codeForStatus(status)
	}
	return &Error{Code: code, StatusCode: status, Message: message, RequestID: requestID, Details: payload}
}

func extractMessage(payload any) (string, bool) {
	obj, ok := payload.(map[string]any)
	if !ok {
		return "", false
	}
	switch m := obj["message"].(type) {
	case string:
		return m, true
	case []any:
		parts := make([]string, 0, len(m))
		for _, p := range m {
			parts = append(parts, fmt.Sprint(p))
		}
		return strings.Join(parts, "; "), true
	}
	return "", false
}

func extractCode(payload any) (string, bool) {
	obj, ok := payload.(map[string]any)
	if !ok {
		return "", false
	}
	c, ok := obj["code"].(string)
	return c, ok
}
