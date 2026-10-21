// Package swalvo is the Go server SDK for Swalvo.
//
// It mirrors @swalvo/server (packages/server-sdk) resource for resource:
// mint short-lived RTC and chat tokens, manage rooms, chat and live streams
// (hosts, viewer tokens, the stage, restreams, ingest and playback), and read
// connection, error, metrics and diagnostics data. It also verifies the
// signatures on Swalvo webhook deliveries.
//
// Use it from your backend only. It holds a permanent project API key; the
// browser gets the short-lived tokens this SDK mints.
//
//	client := swalvo.New(os.Getenv("SWALVO_API_KEY"),
//		swalvo.WithBaseURL("https://api.livqeno.com"))
//
//	room, err := client.Rooms.Create(ctx, swalvo.CreateRoomParams{Name: "standup", GetOrCreate: true})
//	token, err := client.Tokens.Create(ctx, swalvo.CreateTokenParams{Room: room.ID, Identity: "user-42"})
//
// Every failure is a *Error carrying the API's code, HTTP status, message,
// request id and response details:
//
//	var lerr *swalvo.Error
//	if errors.As(err, &lerr) && lerr.Code == "RAVEN_ROOM_NOT_FOUND" { ... }
package swalvo
