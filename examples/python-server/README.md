# Python backend example — `swalvo`

The Phase 10 quickstart: a real FastAPI server that mints RTC tokens for
your frontend, using `swalvo`. `SWALVO_API_KEY` never leaves this
process — the browser only ever sees a short-lived RTC token. The SDK
itself works the same way with Flask/Django/plain Python — FastAPI is
just this example's framework of choice.

## Running it

Sign up for a Livqeno Cloud project at the
[dashboard](https://app.livqeno.com) and create an API key from the
project's API Keys tab (or with the CLI — see `docs/cli.md`).

```bash
cd examples/python-server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt   # installs swalvo from local source — not yet published to PyPI, see note below
SWALVO_API_KEY=rvk_xxxx.yyyy SWALVO_API_URL=https://api.livqeno.com uvicorn main:app --port 8787
# → http://127.0.0.1:8787
```

`swalvo` (Python) is **not yet published to PyPI** — `requirements.txt`
installs it from local monorepo source for development purposes only.
See `PUBLISHING.md` and `apps/docs/content/getting-started/installing-from-source.md`.

## Try it

```bash
curl -X POST http://localhost:8787/api/rtc/token \
  -H "Content-Type: application/json" \
  -d '{"room": "<a real room ID>", "identity": "alice"}'
```

Returns the same shape `POST /v1/rooms/:roomId/rtc-tokens` does —
`{token, endpoint, iceServers, telemetryUrl, expiresAt, ...}` — pass
that straight into `createRTCClient()` from `@swalvo/rtc` on the frontend
(see `examples/video-call`).

## The full flow this demonstrates

```
Browser: fetch('/api/rtc/token', { method: 'POST', body: {room, identity} })
  → this server: swalvo.tokens.create(CreateTokenParams(room=..., identity=..., permissions=...))
    → Swalvo Control API (authenticated by SWALVO_API_KEY, never sent to the browser)
      → a short-lived RTC token
  ← back to the browser
Browser: createRTCClient({ token, endpoint, iceServers }).join(room)
```

See `docs/sdk/server/python.md` and `docs/security/server-sdk.md` for the
full authorization model and security notes.

## Chat

The same backend also mints Livqeno Chat tokens, because the security model
is identical: the API key stays here, and the browser gets a short-lived
token scoped to one user.

```bash
curl -X POST http://localhost:8000/api/chat/token \
  -H 'content-type: application/json' \
  -d '{"room":"support","user_id":"alice"}'
```

The conversation is created on first use and the user is added as a
member — membership is what authorizes them inside it, not the token
alone.

RTC and chat are separate planes with separate credentials. Neither token
works on the other, so a leak on one doesn't compromise the other. See
[docs/chat/overview.md](../../docs/chat/overview.md).
