package swalvo_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/atulsinghhhh/swalvo-sdks/sdks/go/swalvo"
)

// TestIntegration runs against a real Swalvo Control API. It is skipped
// unless both SWALVO_IT_BASE_URL and SWALVO_IT_API_KEY are set, and it
// creates real records (a room, which it closes, and a live stream, which it
// starts and ends), so point it at a disposable project:
//
//	SWALVO_IT_BASE_URL=https://api.example.com SWALVO_IT_API_KEY=rvk_... go test -run TestIntegration -v ./...
func TestIntegration(t *testing.T) {
	baseURL, apiKey := os.Getenv("SWALVO_IT_BASE_URL"), os.Getenv("SWALVO_IT_API_KEY")
	if baseURL == "" || apiKey == "" {
		t.Skip("set SWALVO_IT_BASE_URL and SWALVO_IT_API_KEY to run the integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	client, err := swalvo.NewClient(apiKey, swalvo.WithBaseURL(baseURL))
	if err != nil {
		t.Fatal(err)
	}
	suffix := fmt.Sprintf("go-sdk-it-%d", time.Now().UnixNano())

	room, err := client.Rooms.Create(ctx, swalvo.CreateRoomParams{Name: suffix, GetOrCreate: true})
	if err != nil {
		t.Fatalf("rooms.create: %v", err)
	}
	t.Cleanup(func() { _ = client.Rooms.Delete(context.Background(), room.ID) })

	token, err := client.Tokens.Create(ctx, swalvo.CreateTokenParams{Room: room.ID, Identity: "it-user", ExpiresIn: 60})
	if err != nil {
		t.Fatalf("tokens.create: %v", err)
	}
	if token.Token == "" || token.Endpoint == "" {
		t.Fatalf("token missing fields: endpoint=%q", token.Endpoint)
	}

	stream, err := client.LiveStreams.Create(ctx, swalvo.CreateLiveStreamParams{Title: suffix, HostIdentity: "it-host"})
	if err != nil {
		t.Fatalf("liveStreams.create: %v", err)
	}
	ended := false
	t.Cleanup(func() {
		if !ended {
			_, _ = client.LiveStreams.End(context.Background(), stream.ID)
		}
	})

	// Only a LIVE stream can be ended, so start it first.
	if _, err := client.LiveStreams.Start(ctx, stream.ID); err != nil {
		t.Fatalf("liveStreams.start: %v", err)
	}

	viewer, err := client.LiveStreams.CreateViewerToken(ctx, stream.ID, "it-viewer", &swalvo.ViewerTokenOptions{AcceptPlayback: true})
	if err != nil {
		t.Fatalf("liveStreams.createViewerToken: %v", err)
	}
	if viewer.StreamID != stream.ID || viewer.Role != swalvo.RoleViewer {
		t.Fatalf("viewer credential: streamId=%q role=%q", viewer.StreamID, viewer.Role)
	}

	if _, err := client.LiveStreams.End(ctx, stream.ID); err != nil {
		t.Fatalf("liveStreams.end: %v", err)
	}
	ended = true
}
