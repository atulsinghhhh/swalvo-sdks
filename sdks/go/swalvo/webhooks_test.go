package swalvo

import (
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	whSecret = "whsec_test"
	whBody   = `{"id":"evt_1","type":"live_stream.started"}`
	// hex(HMAC-SHA256("whsec_test", "1700000000." + whBody)), computed with
	// Node's crypto exactly as apps/api's signWebhookPayload does.
	whNodeSig = "ed7c6d42388f7624080cc5c9c296e1df6625812810aada5741a9471dfed16413"
)

var whTime = time.Unix(1700000000, 0)

func TestWebhookSignatureMatchesTheAPI(t *testing.T) {
	got := SignWebhookPayload([]byte(whBody), whSecret, whTime)
	if got != "t=1700000000,v1="+whNodeSig {
		t.Fatalf("signature = %s", got)
	}
}

func TestWebhookValid(t *testing.T) {
	header := "t=1700000000,v1=" + whNodeSig
	if err := VerifyWebhookSignatureAt([]byte(whBody), header, whSecret, whTime.Add(10*time.Second), WebhookTolerance); err != nil {
		t.Fatalf("valid delivery rejected: %v", err)
	}
	// Whitespace around parts, and a second (rotated) v1, are tolerated.
	header = "t=1700000000, v1=" + strings.Repeat("0", 64) + ", v1=" + whNodeSig
	if err := VerifyWebhookSignatureAt([]byte(whBody), header, whSecret, whTime, WebhookTolerance); err != nil {
		t.Fatalf("valid delivery rejected: %v", err)
	}
	// The real-clock entry point.
	now := time.Now()
	if err := VerifyWebhookSignature([]byte(whBody), SignWebhookPayload([]byte(whBody), whSecret, now), whSecret); err != nil {
		t.Fatalf("fresh delivery rejected: %v", err)
	}
}

func TestWebhookTampered(t *testing.T) {
	header := SignWebhookPayload([]byte(whBody), whSecret, whTime)
	tampered := strings.Replace(whBody, "started", "ended", 1)
	if err := VerifyWebhookSignatureAt([]byte(tampered), header, whSecret, whTime, WebhookTolerance); !errors.Is(err, ErrWebhookSignatureMismatch) {
		t.Fatalf("tampered body: %v", err)
	}
	if err := VerifyWebhookSignatureAt([]byte(whBody), header, "whsec_other", whTime, WebhookTolerance); !errors.Is(err, ErrWebhookSignatureMismatch) {
		t.Fatalf("wrong secret: %v", err)
	}
	// Replaying with a fresher timestamp bolted on fails: t is inside the MAC.
	replayed := "t=1700000100,v1=" + whNodeSig
	if err := VerifyWebhookSignatureAt([]byte(whBody), replayed, whSecret, whTime.Add(100*time.Second), WebhookTolerance); !errors.Is(err, ErrWebhookSignatureMismatch) {
		t.Fatalf("re-timestamped replay: %v", err)
	}
	if err := VerifyWebhookSignatureAt([]byte(whBody), "t=1700000000,v1="+whNodeSig[:10], whSecret, whTime, WebhookTolerance); !errors.Is(err, ErrWebhookSignatureMismatch) {
		t.Fatalf("truncated signature: %v", err)
	}
}

func TestWebhookExpired(t *testing.T) {
	header := SignWebhookPayload([]byte(whBody), whSecret, whTime)
	if err := VerifyWebhookSignatureAt([]byte(whBody), header, whSecret, whTime.Add(301*time.Second), WebhookTolerance); !errors.Is(err, ErrWebhookTimestampOutOfRange) {
		t.Fatalf("expired: %v", err)
	}
	if err := VerifyWebhookSignatureAt([]byte(whBody), header, whSecret, whTime.Add(-301*time.Second), WebhookTolerance); !errors.Is(err, ErrWebhookTimestampOutOfRange) {
		t.Fatalf("from the future: %v", err)
	}
	if err := VerifyWebhookSignatureAt([]byte(whBody), header, whSecret, whTime.Add(300*time.Second), WebhookTolerance); err != nil {
		t.Fatalf("exactly at tolerance must pass: %v", err)
	}
	if err := VerifyWebhookSignature([]byte(whBody), header, whSecret); !errors.Is(err, ErrWebhookTimestampOutOfRange) {
		t.Fatalf("2023 delivery verified against the real clock: %v", err)
	}
}

func TestWebhookMalformed(t *testing.T) {
	for _, header := range []string{"", "garbage", "t=abc,v1=" + whNodeSig, "v1=" + whNodeSig, "t=1700000000"} {
		if err := VerifyWebhookSignatureAt([]byte(whBody), header, whSecret, whTime, WebhookTolerance); !errors.Is(err, ErrWebhookInvalidHeader) {
			t.Fatalf("%q: %v", header, err)
		}
	}
	err := VerifyWebhookSignatureAt([]byte(whBody), "t=1700000000,v1="+whNodeSig, "", whTime, WebhookTolerance)
	if !errors.Is(err, ErrWebhookMissingSecret) {
		t.Fatalf("empty secret: %v", err)
	}
}

func TestVerifyWebhookRequest(t *testing.T) {
	body := `{"id":"evt_9","type":"live_stream.ended","projectId":"proj_1","environment":"production","createdAt":"c","data":{"streamId":"stream_1"}}`
	req := httptest.NewRequest("POST", "/hooks", strings.NewReader(body))
	req.Header.Set(WebhookSignatureHeader, SignWebhookPayload([]byte(body), whSecret, time.Now()))
	req.Header.Set(WebhookEventIDHeader, "evt_9")
	req.Header.Set(WebhookEventTypeHeader, "live_stream.ended")

	event, err := VerifyWebhookRequest(req, whSecret)
	mustNoErr(t, err)
	if event.ID != "evt_9" || event.Type != "live_stream.ended" || string(event.Data) != `{"streamId":"stream_1"}` {
		t.Fatalf("event %+v", event)
	}
	again, _ := io.ReadAll(req.Body)
	if string(again) != body {
		t.Fatal("body not restored for later handlers")
	}

	bad := httptest.NewRequest("POST", "/hooks", strings.NewReader(body))
	bad.Header.Set(WebhookSignatureHeader, SignWebhookPayload([]byte(body), "whsec_wrong", time.Now()))
	if _, err := VerifyWebhookRequest(bad, whSecret); !errors.Is(err, ErrWebhookSignatureMismatch) {
		t.Fatalf("bad signature: %v", err)
	}
	if err != nil && strings.Contains(err.Error(), whSecret) {
		t.Fatal("secret leaked into error")
	}
}

func TestVerifyWebhookRequestPrefersSwalvoHeader(t *testing.T) {
	body := `{"id":"evt_10","type":"room.started","data":{}}`
	req := httptest.NewRequest("POST", "/hooks", strings.NewReader(body))
	req.Header.Set(SwalvoWebhookSignatureHeader, SignWebhookPayload([]byte(body), whSecret, time.Now()))
	req.Header.Set(WebhookSignatureHeader, SignWebhookPayload([]byte(body), "whsec_wrong", time.Now()))
	event, err := VerifyWebhookRequest(req, whSecret)
	mustNoErr(t, err)
	if event.ID != "evt_10" {
		t.Fatalf("event %+v", event)
	}

	legacyOnly := httptest.NewRequest("POST", "/hooks", strings.NewReader(body))
	legacyOnly.Header.Set(WebhookSignatureHeader, SignWebhookPayload([]byte(body), whSecret, time.Now()))
	if _, err := VerifyWebhookRequest(legacyOnly, whSecret); err != nil {
		t.Fatalf("legacy raven-signature header rejected: %v", err)
	}
}
