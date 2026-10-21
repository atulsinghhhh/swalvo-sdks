# Swalvo — video call with a chat panel

`@swalvo/rtc` and `@swalvo/chat` on the same screen, doing different jobs.

```
┌─────────────────────────────────────────┐
│                Swalvo Room                │
├──────────────────────┬──────────────────┤
│                      │      Chat        │
│       Video          │                  │
│   (@swalvo/rtc)          │  alice: Hello    │
│                      │  bob:   Hi       │
│                      │                  │
│  [camera] [mute]     │  [ message… ]    │
└──────────────────────┴──────────────────┘
```

## Why two SDKs and not one

Media and messaging have almost nothing in common at the transport layer.
Video needs WebRTC: peer connections, ICE, SRTP, an SFU, and TURN relays for
clients behind hostile NATs. Messages need durability, ordering, and history —
things WebRTC data channels are actively bad at, because a data channel is
peer-to-peer and evaporates when the peer leaves.

So Swalvo keeps them separate:

| | Video | Chat |
| --- | --- | --- |
| SDK | `@swalvo/rtc` | `@swalvo/chat` |
| Transport | WebRTC via Swalvo's SFU | WebSocket |
| Token | RTC token (`aud: raven-rtc`) | Chat token (`aud: raven-chat`) |
| Durability | none — media is live or gone | Postgres |
| Provider | `<SwalvoRoom>` | `<SwalvoChat>` |

The practical payoff: **either half can fail without the other noticing.** Kill
the SFU container and the chat panel keeps working. Restart the Swalvo API
and the video call carries on while chat reconnects. Neither token is accepted
by the other plane — try it and you'll get a `401`.

The only thing linking them is `Conversation.roomId`: creating a conversation
with `roomId` attaches it to an RTC room, so `chat.connect()` and `client.join()`
can be handed the same identifier.

## Running it

You need a Swalvo Cloud project and API key: sign up at the
[dashboard](https://app.swalvo.com), create a project, then create
an API key from the project's API Keys tab.

```bash
cd examples/rtc-chat
npm install

# Terminal 1 — backend (holds SWALVO_API_KEY, mints both tokens)
SWALVO_API_KEY=rvk_xxx.yyy SWALVO_API_URL=https://api.swalvo.com npm run server

# Terminal 2 — frontend
npm run dev
```

Open <http://localhost:8903> in two tabs, join the same room with different
identities, and allow camera/microphone access.

| Variable | Default | What it does |
| --- | --- | --- |
| `SWALVO_API_KEY` | *(required)* | Project API key. Backend only. |
| `SWALVO_API_URL` | `http://localhost:4100` | Swalvo Control API base URL. Set this to `https://api.swalvo.com` to use hosted Swalvo Cloud — the `localhost:4100` default only exists as a fallback for developers running Swalvo's own backend locally. |
| `PORT` | `8789` | Port for this example's backend. |

## Things worth trying

**Independence.** With both tabs in a call, briefly interrupt the
backend's connectivity to Swalvo Cloud (stop and restart the `npm run
server` process, or toggle your network). The video tiles drop and
recover; the chat panel never flinches, and messages sent during the
outage are all there.

The reverse also holds: interrupt just the chat WebSocket (e.g. by
briefly blocking outbound traffic to the chat endpoint) and video stays
connected while chat shows `reconnecting`, then refetches what it missed
once it's back.

**Cross-plane token rejection.** Paste the RTC token into a chat connection (or
vice versa) — both are rejected. They're signed with different keys and carry
different audiences, so a leak on one plane doesn't compromise the other.

## Backend flow

```js
const [rtc, chat] = await Promise.all([
  swalvo.tokens.create({ room: room.id, identity, permissions: { ... } }),
  swalvo.chat.createToken({ userId: identity, conversations: [conversation.publicId] }),
]);
```

Two calls, two credentials, one response. See `server.mjs`.

More detail in [docs/chat/overview.md](../../docs/chat/overview.md) and
[docs/sdk/chat.md](../../docs/sdk/chat.md).
