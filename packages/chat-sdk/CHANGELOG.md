# @swalvo/chat

## Unreleased

### Major Changes

- Renamed from `@ravenkash/chat` to `@swalvo/chat` as part of the Raven/Livqeno → Swalvo rebrand. Error classes are now `SwalvoChatError`, `SwalvoChatConnectionError`, `SwalvoChatAuthenticationError`, `SwalvoChatPermissionError`, `SwalvoMessageError`, `SwalvoRateLimitError`, `SwalvoAttachmentError`, `SwalvoRoomError`, `SwalvoModerationError`, `SwalvoSlowModeError`, `SwalvoMessageBlockedError`, with `isSwalvoChatError`. The `Raven*` names and `isRavenChatError` remain exported as deprecated aliases of the same classes, so `instanceof` checks keep working. Note that `error.name` now reports the `Swalvo*` class name, and log lines are prefixed `[swalvo-chat]`. The `raven-chat` token audience, the `raven-chat-outbox` storage key and `RAVEN_*` HTTP error codes are unchanged.

## 0.1.1

### Patch Changes

- [`63303dd`](https://github.com/atulsinghhhh/swalvo-sdks/commit/63303dd184adac3beae884ca527cc82fc6f03490) Thanks [@atulsinghhhh](https://github.com/atulsinghhhh)! - Re-assert presence after a reconnect

  Presence is socket state. A reconnect opens a new socket, which knows
  nothing of what was set on the old one, and `syncRooms()` re-joined the
  rooms without re-sending the status — so a client that survived a blip
  went silently invisible to everybody else for the rest of the session
  while its own `connectionState` still read `connected`. Two people in a
  conversation could each see only themselves, with nothing anywhere to say
  why.

  `setPresence()` now remembers what it was asked for and `syncRooms()`
  re-sends it, ahead of the rejoins so the server never processes a join
  for somebody it currently believes is absent. Nothing is sent for a
  client that never called `setPresence()`: announcing a status nobody
  chose would invent one, and would make a deliberately invisible client —
  a moderation view, a bot, an agent watching a queue — impossible to
  build.

  The same fix ships in `raven_chat` for Flutter, which had the identical
  defect.
