# swalvo_chat

Livqeno Chat for Flutter — real-time messaging with durable history,
presence, typing indicators, reactions, read receipts and threads.
Connect, send and listen without writing WebSocket code.

Part of [Livqeno](https://livqeno.com), managed real-time communication infrastructure.

## Requirements

- Dart SDK **>= 3.6.0**
- Flutter **>= 3.27.0**

## Install

```yaml
dependencies:
  swalvo_chat: ^0.2.0
```

### Migrating from `raven_chat`

This package was previously published as `raven_chat`. Replace the
dependency with `swalvo_chat` and the import with
`package:swalvo_chat/swalvo_chat.dart`. The `Raven*` type names (`RavenChat`,
…) still compile as deprecated aliases of the `Swalvo*` ones until 1.0;
error code strings (`RAVEN_*`) and the wire protocol are unchanged.

## Use

The chat token is minted by your backend and is a separate credential from
an RTC token — neither works on the other plane.

```dart
import 'package:swalvo_chat/swalvo_chat.dart';

final chat = SwalvoChat(token: grant.token, apiUrl: grant.apiUrl);

await chat.connect('room_123');

chat.messages.listen((message) => setState(() => _messages.add(message)));

await chat.send('Hello everyone!');
```

`SwalvoChat` extends `ChangeNotifier`, so a widget can rebuild from it
directly, with typed streams (`messages`, `typing`, `presence`,
`reactions`, `readReceipts`, `connectionStateChanges`, `errors`) for logic
outside the widget tree.

Postgres is the source of truth: a message is reported sent only once it is
durably stored, a retried send never duplicates, and a client that was
offline catches up from history rather than the socket.

## Offline, inbox, moderation and push

- **Recovery.** After a reconnect the client replays missed messages and
  then the edits, deletes, reactions and moderation events around them,
  in order and de-duplicated. Listen to `recovered` to know when it is
  done, and to `resyncs` for the rare case the server's event log no
  longer reached back far enough.
- **Outbox.** A send the connection drops stays queued (`chat.outbox`) and
  goes out on reconnect with the same idempotency key — never twice. Pass
  `outboxStorage:` to keep it across restarts.
- **Inbox.** `chat.inbox.load()` lists this user's conversations with
  unread counts that keep themselves current.
- **Moderation.** `block`, `flagMessage`, and for moderators `ban` /
  `mute` with durations; `memberModeration` and `removedFromRoom` streams.
- **Push.** `registerDevice`, `setNotificationLevel`, `muteConversation`.
- **Attachments.** `uploadAttachment(bytes, …)` then
  `send(text, attachmentId: ticket.id)`.

## Independent of swalvo_rtc

WebSocket and HTTP only — no WebRTC. A messaging app never pulls in a
media stack, and a video app never pulls in a message store. Use both
together for a call with a chat panel.

## Documentation

- [Flutter SDK reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/flutter.md)
- [Chat overview](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/chat/overview.md)
- Runnable example: [`examples/flutter-rtc-chat`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/examples/flutter-rtc-chat)

## License

MIT
