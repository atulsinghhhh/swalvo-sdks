# Signaling Demo

A single static HTML file (`index.html`, no build step, no dependencies)
that demonstrates the Phase 3 signaling layer end-to-end: connect,
authenticate, join a room, see participant events, exchange placeholder
SDP/ICE messages, and disconnect. It does **not** establish real media —
see `docs/rtc/architecture.md` for why that's intentionally out of scope until
Phase 4.

## Running it

1. Sign up for a Swalvo Cloud project at the
   [dashboard](https://app.swalvo.com) and create an API key from
   the project's API Keys tab.
2. Get two RTC tokens for the same room:

   ```bash
   curl -X POST https://api.swalvo.com/v1/rooms/<roomId>/rtc-tokens \
     -H "Authorization: Bearer <your-api-key>" \
     -H "Content-Type: application/json" \
     -d '{"participantIdentity":"alice","permissions":{"join":true,"subscribe":true,"publish":true}}'
   ```

   Run it again with `"participantIdentity":"bob"` for a second token.
   (Create a room first with `swalvo rooms create` or `POST /v1/rooms` if
   you don't have a `roomId` yet.)

3. Open `index.html` directly in two browser tabs (double-click it, or
   `open index.html` — no server needed, `file://` works fine since the
   page only ever talks to the signaling WebSocket directly).
4. In tab 1: paste alice's token, click **Connect**, then **room.join**.
5. In tab 2: paste bob's token, click **Connect**, then **room.join**.
   Tab 1 should show a `participant.joined` event for bob.
6. Try **Send sdp.offer** / **Send sdp.answer** / **Send ice.candidate**
   in either tab (target the other participant's ID, shown in the
   Participants list) — the message log shows the exact frames sent and
   received.
7. Click **Disconnect** in either tab — the other tab receives
   `participant.left`.

See `docs/rtc/signaling.md` for the full message reference.
