---
"@swalvo/rtc": minor
"@swalvo/react-native": minor
"@swalvo/live": patch
---

Client resilience: session resume, live token refresh, close-code handling, media rejoin, live permissions and server mutes.

- **`refreshToken` in `RTCClientConfig`** (and `SwalvoConfig` on React Native and `@swalvo/live`). On the server's `token.expiring` the SDK fetches a new token and hands it to the live session with no reconnect; it is also used before reconnecting with an expired token and after a `4001` close. A refused refresh (`TOKEN_INVALID`) or a failing callback is a `warning` event, not an error: the session carries on.
- **Session resume.** A reconnect offers the server's latest resume token. When the server keeps the session (`resumed: true`) the PeerConnection is kept and media never stops; otherwise the connection is rebuilt and local tracks republished, as before. Remote tracks on a rebuilt connection now re-subscribe (`trackUnsubscribed` then `trackSubscribed`) instead of staying bound to the dead connection.
- **Close codes.** `1012` (server restart) reconnects within 0–2 s with resume. `4003` never reconnects. `4001` refreshes then reconnects when `refreshToken` is set, otherwise disconnects with `TOKEN_EXPIRED`. A first `join()` that fails no longer keeps reconnecting in the background.
- **Media rejoin.** A PeerConnection that fails while signaling is up now triggers a rejoin with a new media connection (bounded, with backoff), reported as `reconnecting` / `reconnected`. Previously the room sat in `reconnecting` forever.
- **`disconnected` now carries a `DisconnectReason`**: `CLIENT_INITIATED`, `REMOVED`, `ROOM_CLOSED`, `TOKEN_EXPIRED`, `CONNECTION_FAILED`. The `error` emitted with a `failed` room is now the real cause (for example `TOKEN_EXPIRED`) when known.
- **New Room events and members**: `permissionsChanged` and `room.permissions` (publish rights withdrawn mid-call stop those local tracks without an error; rights granted take effect without reconnecting), `localTrackMutedByServer`, `warning`, and `room.handleNetworkChange()`.
- **React Native**: regaining connectivity now calls `room.handleNetworkChange()`, so a pending reconnect runs at once and a live call restarts ICE. `onNetworkReconnect` still fires for a room that already gave up.
