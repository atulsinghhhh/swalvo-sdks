# Node.js backend example — `@swalvo/server`

The Phase 10 quickstart: a real Express server that mints RTC tokens for
your frontend, using `@swalvo/server`. `SWALVO_API_KEY` never leaves this
process — the browser only ever sees a short-lived RTC token.

## Running it

Sign up for a Swalvo Cloud project at the
[dashboard](https://app.swalvo.com) and create an API key from the
project's API Keys tab (or `swalvo keys create` — see `docs/cli.md`).

```bash
cd examples/node-server
npm install     # installs @swalvo/server from npm
SWALVO_API_KEY=rvk_xxxx.yyyy SWALVO_API_URL=https://api.swalvo.com npm start
# → Swalvo node-server example listening on http://localhost:8787
```

## Try it

```bash
curl -X POST http://localhost:8787/api/rtc/token \
  -H "Content-Type: application/json" \
  -d '{"room": "<a real room ID from swalvo rooms create>", "identity": "alice"}'
```

Returns the same shape `POST /v1/rooms/:roomId/rtc-tokens` does —
`{ token, endpoint, iceServers, telemetryUrl, expiresAt, ... }` — pass
that straight into `createRTCClient()` from `@swalvo/rtc` on the frontend
(see `examples/video-call`).

## The full flow this demonstrates

```
Browser: fetch('/api/rtc/token', { method: 'POST', body: { room, identity } })
  → this server: swalvo.tokens.create({ room, identity, permissions })
    → Swalvo Control API (authenticated by SWALVO_API_KEY, never sent to the browser)
      → a short-lived RTC token
  ← back to the browser
Browser: createRTCClient({ token, endpoint, iceServers }).join(room)
```

See `docs/sdk/server/typescript.md` and `docs/security/server-sdk.md` for
the full authorization model and security notes.
