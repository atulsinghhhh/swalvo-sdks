# @swalvo/chat

Livqeno's browser chat SDK — durable, ordered messaging with presence,
typing indicators, read receipts, reactions, threads and attachments.
Connect, send and receive without writing a line of WebSocket code.

Part of [Livqeno](https://github.com/atulsinghhhh/swalvo-sdks), open-source real-time communication infrastructure.

## Install

```bash
npm install @swalvo/chat
```

## Use

The chat token is minted by your backend (`POST /v1/chat/tokens`) and is a
separate credential from an RTC token — neither works on the other plane.

```ts
import { createChatClient } from '@swalvo/chat';

const chat = createChatClient({
  token: grant.token,
  apiUrl: grant.apiUrl,
});

await chat.connect({ room: 'room_123' });

chat.on('message', (message) => render(message));

await chat.sendMessage({ text: 'Hello' });
```

Postgres is the source of truth, so history survives a reconnect and
messages arrive in a defined order rather than whatever the socket
delivered.

Reconnection is automatic, and so is catching up. If the connection drops,
the SDK reconnects, re-joins your rooms, and replays whatever you missed
through the same `message` handler — oldest first, de-duplicated, with
nothing lost and nothing delivered twice. There is no catch-up call for you
to make. Listen for `recovered` if you want to know when it has finished:

```js
chat.on('recovered', ({ recovered, gap }) => {
  if (gap) reloadConversation();   // resume point was unusable; see the docs
});
```

Sends survive a dropped connection too. Every `sendMessage()` goes through
an outbox: if the connection fails, the message stays `pending` and goes out
on reconnect with the same idempotency key, so it is stored once. Edits,
deletes and reactions you missed are caught up as well, in order. Keep the
outbox across reloads with `outbox: { storage: new LocalStorageOutboxStorage() }`.

```js
chat.on('outboxChanged', (entries) => renderPending(entries));
```

Beyond messaging:

- **Inbox** — `chat.inbox.load()` gives the user's conversations with unread
  counts that keep themselves current.
- **Moderation** — `chat.moderation.block()`, `flagMessage()`, and for
  moderators `ban()` / `mute()`; typed errors for `MUTED`, `SLOW_MODE` and
  friends.
- **Push** — `chat.registerDevice({ provider, token, platform })` and
  per-conversation `setNotificationLevel()`.
- **Mentions, pins, search, link previews and paginated threads.**

## Exports

`createChatClient`, `ChatClient`, `MessagesApi`, `AttachmentsApi`,
`ModerationApi`, `Inbox`, `Outbox`, `MemoryOutboxStorage`,
`LocalStorageOutboxStorage`, `compareSeq`, `isSwalvoChatError`, the error
classes, and the message/presence/reaction/inbox types (plus
`RecoverySummary` and `RoomRecoveryResult` for the `recovered` event).

## Documentation

- [Chat SDK reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/chat.md)
- [Chat overview](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/chat/overview.md) · [architecture](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/chat/architecture.md) · [WebSocket protocol](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/chat/websocket.md)
- Presence · typing · read receipts · reactions · threads · attachments — one page each under [`docs/chat/`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/docs/chat)
- Runnable example: [`examples/chat`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/examples/chat)

## License

MIT
