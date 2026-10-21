# Livqeno Chat example

A working chat client built on `@swalvo/chat` and `@swalvo/react`. Every message you
see came out of Postgres and arrived over a real WebSocket — there is no mock
message array anywhere in this example.

It demonstrates:

- authentication (short-lived chat tokens, minted server-side)
- message history with cursor pagination ("Load earlier messages")
- sending and receiving in real time
- typing indicators
- presence
- read receipts ("Read by …")
- reactions
- editing and deleting
- automatic reconnection
- server-only system messages

## Architecture

```
Browser (@swalvo/chat)          Your backend (@swalvo/server)         Swalvo
        │                              │                              │
        │  POST /api/chat/token        │                              │
        ├─────────────────────────────►│  swalvo.chat.createToken()   │
        │                              ├─────────────────────────────►│
        │       short-lived token      │◄─────────────────────────────┤
        │◄─────────────────────────────┤                              │
        │                                                             │
        │  wss://…/v1/chat/ws?token=…                                 │
        ├────────────────────────────────────────────────────────────►│
```

`SWALVO_API_KEY` never leaves the backend. The browser only ever holds a token
that expires, is scoped to one user, and can be revoked.

## Running it

You need a Livqeno Cloud project and API key: sign up at the
[dashboard](https://app.livqeno.com), create a project, then create
an API key from the project's API Keys tab.

Then:

```bash
cd examples/chat
npm install

# Terminal 1 — the backend that holds the API key
SWALVO_API_KEY=rvk_xxx.yyy SWALVO_API_URL=https://api.livqeno.com npm run server

# Terminal 2 — the frontend
npm run dev
```

Open <http://localhost:8902>, sign in as `alice`, then open a second tab (or a
second browser) and sign in as `bob`. Everything you do in one appears in the
other.

### Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `SWALVO_API_KEY` | *(required)* | Project API key. Backend only. |
| `SWALVO_API_URL` | `http://localhost:4100` | Livqeno Control API base URL. Set this to `https://api.livqeno.com` to use hosted Livqeno Cloud — the `localhost:4100` default only exists as a fallback for developers running Livqeno's own backend locally. |
| `SWALVO_CHAT_ROOM` | `example-chat` | Conversation name. Created on first run. |
| `PORT` | `8788` | Port for this example's backend. |

## Things worth trying

**Reconnection.** With both tabs open, briefly interrupt the backend's
connectivity to Livqeno Cloud (e.g. toggle your network off and on, or stop
the `npm run server` process and restart it). Watch the connection badge go
`reconnecting` → `connected`, and note that no messages are lost — the SDK
refetches what it missed from history, because the WebSocket is never the
source of truth.

**Offline delivery.** Close Bob's tab, send a few messages as Alice, then bring
Bob back. His history loads with everything he missed.

**Idempotency.** The SDK attaches a `clientMessageId` to every send. A retry
after a reconnect returns the original message instead of posting a duplicate.

**System messages.** A browser token can't send them — that's enforced
server-side. Try it from the backend instead:

```bash
curl -X POST http://localhost:8788/api/chat/announce \
  -H 'content-type: application/json' \
  -d '{"text":"Server maintenance in 5 minutes"}'
```

## What this example is not

It has no real authentication — `userId` comes straight from the request body so
the example runs without an auth system. In a real app that identity must come
from your own session (`req.user.id`), because whoever controls it controls who
Livqeno attributes messages to. Same caveat as `examples/node-server`.

See [docs/chat/overview.md](../../docs/chat/overview.md) for the full API.
