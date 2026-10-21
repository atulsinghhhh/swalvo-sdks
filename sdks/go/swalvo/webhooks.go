package swalvo

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Webhook delivery headers, as sent by the Swalvo webhook worker
// (apps/api/src/modules/webhooks/webhook-signature.util.ts).
//
// Every delivery carries the swalvo-* headers and, for integrations written
// before the rename, identical raven-* twins. Prefer the Swalvo* constants;
// the unprefixed Webhook*Header constants keep their legacy raven-* values
// (legacy: kept for wire compatibility).
const (
	// SwalvoWebhookSignatureHeader carries `t=<unix seconds>,v1=<hex HMAC-SHA256>`.
	SwalvoWebhookSignatureHeader = "swalvo-signature"
	// SwalvoWebhookEventIDHeader carries the event's id. Use it to deduplicate retries.
	SwalvoWebhookEventIDHeader = "swalvo-event-id"
	// SwalvoWebhookEventTypeHeader carries the event's type, e.g. live_stream.started.
	SwalvoWebhookEventTypeHeader = "swalvo-event-type"
	// WebhookSignatureHeader is the legacy twin of SwalvoWebhookSignatureHeader.
	WebhookSignatureHeader = "raven-signature"
	// WebhookEventIDHeader is the legacy twin of SwalvoWebhookEventIDHeader.
	WebhookEventIDHeader = "raven-event-id"
	// WebhookEventTypeHeader is the legacy twin of SwalvoWebhookEventTypeHeader.
	WebhookEventTypeHeader = "raven-event-type"
	// WebhookTolerance is how far a signature timestamp may drift from now
	// before the delivery is rejected (replay protection).
	WebhookTolerance = 300 * time.Second
)

// Errors returned by the webhook verifier. They never contain the secret.
var (
	// ErrWebhookMissingSecret: the signing secret passed in is empty.
	ErrWebhookMissingSecret = errors.New("swalvo: webhook signing secret is empty")
	// ErrWebhookInvalidHeader: the signature header is missing or malformed.
	ErrWebhookInvalidHeader = errors.New("swalvo: webhook signature header is missing or malformed")
	// ErrWebhookTimestampOutOfRange: the timestamp is outside the tolerance.
	ErrWebhookTimestampOutOfRange = errors.New("swalvo: webhook timestamp is outside the tolerance")
	// ErrWebhookSignatureMismatch: no v1 signature matches the body.
	ErrWebhookSignatureMismatch = errors.New("swalvo: webhook signature does not match")
)

// SignWebhookPayload returns the signature header value for body,
// exactly as the API computes it: `t=<t>,v1=hex(HMAC-SHA256(secret, "<t>.<body>"))`.
// Useful for testing your own webhook handler.
func SignWebhookPayload(body []byte, secret string, t time.Time) string {
	ts := strconv.FormatInt(t.Unix(), 10)
	return "t=" + ts + ",v1=" + computeWebhookSignature(ts, body, secret)
}

func computeWebhookSignature(ts string, body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	mac.Write([]byte("."))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyWebhookSignature checks a delivery's signature header value against
// the raw request body (the exact bytes received, before any JSON parsing)
// and your endpoint's signing secret, with the default 300 s tolerance.
// It returns nil when the delivery is authentic.
func VerifyWebhookSignature(body []byte, header, secret string) error {
	return VerifyWebhookSignatureAt(body, header, secret, time.Now(), WebhookTolerance)
}

// VerifyWebhookSignatureAt is VerifyWebhookSignature with an explicit clock
// and tolerance. The comparison is constant-time.
func VerifyWebhookSignatureAt(body []byte, header, secret string, now time.Time, tolerance time.Duration) error {
	if secret == "" {
		return ErrWebhookMissingSecret
	}
	var ts string
	var provided []string
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			ts = v
		case "v1":
			provided = append(provided, v)
		}
	}
	timestamp, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || len(provided) == 0 {
		return ErrWebhookInvalidHeader
	}

	drift := now.Unix() - timestamp
	if drift < 0 {
		drift = -drift
	}
	if time.Duration(drift)*time.Second > tolerance {
		return ErrWebhookTimestampOutOfRange
	}

	expected := []byte(computeWebhookSignature(ts, body, secret))
	match := false
	for _, sig := range provided {
		// hmac.Equal is constant-time for equal lengths and returns false
		// for differing lengths, like the API's timingSafeEqual check.
		if hmac.Equal([]byte(sig), expected) {
			match = true
		}
	}
	if !match {
		return ErrWebhookSignatureMismatch
	}
	return nil
}

// WebhookEvent is the JSON envelope Swalvo POSTs to a webhook endpoint.
type WebhookEvent struct {
	ID          string          `json:"id"`
	Type        string          `json:"type"`
	ProjectID   string          `json:"projectId"`
	Environment string          `json:"environment"`
	CreatedAt   string          `json:"createdAt"`
	Data        json.RawMessage `json:"data"`
}

// maxWebhookBody bounds how much of a request VerifyWebhookRequest reads.
const maxWebhookBody = 1 << 20

// VerifyWebhookRequest reads r's body, verifies its swalvo-signature header
// (falling back to the legacy raven-signature header)
// with the default tolerance, and decodes the event envelope. The body is
// restored on r so later handlers can read it again.
//
//	http.HandleFunc("/webhooks/swalvo", func(w http.ResponseWriter, r *http.Request) {
//		event, err := swalvo.VerifyWebhookRequest(r, os.Getenv("SWALVO_WEBHOOK_SECRET"))
//		if err != nil {
//			http.Error(w, "invalid signature", http.StatusBadRequest)
//			return
//		}
//		// event.Type, event.Data ...
//	})
func VerifyWebhookRequest(r *http.Request, secret string) (*WebhookEvent, error) {
	if r == nil || r.Body == nil {
		return nil, ErrWebhookInvalidHeader
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWebhookBody))
	_ = r.Body.Close()
	if err != nil {
		return nil, err
	}
	r.Body = io.NopCloser(bytes.NewReader(body))

	header := r.Header.Get(SwalvoWebhookSignatureHeader)
	if header == "" {
		header = r.Header.Get(WebhookSignatureHeader)
	}
	if err := VerifyWebhookSignature(body, header, secret); err != nil {
		return nil, err
	}
	var event WebhookEvent
	if err := json.Unmarshal(body, &event); err != nil {
		return nil, err
	}
	return &event, nil
}
