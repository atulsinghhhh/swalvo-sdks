## 0.2.0

* **Renamed from `raven_chat` to `swalvo_chat`** (Raven/Livqeno is now
  Swalvo). Change the dependency to `swalvo_chat` and the import to
  `package:swalvo_chat/swalvo_chat.dart`. Every public `Raven*` type is now
  `Swalvo*` (`RavenChat` →
  `SwalvoChat`, …); the old names remain as deprecated
  typedefs until 1.0, so existing code compiles with deprecation warnings
  only. Wire contracts are unchanged: `RAVEN_*` error code strings,
  data-channel labels and protocol ids, and E2EE key-derivation labels
  stay as they were, so this release interoperates with every server and
  every client built on `raven_chat`.

Phase 3: the Flutter SDK catches up with `@swalvo/chat`, feature for
feature. Everything is additive; an app written against 0.1 compiles and
behaves the same.

* **Catch-up recovery, which was missing.** 0.1 reconnected and re-joined
  but never replayed anything: a message sent while the socket was down
  was simply never seen until the next history load. The client now keeps
  a resume point per room and, after every reconnect, replays missed
  messages from history (oldest first, de-duplicated), then the edits,
  deletes, reactions, pins and moderation events around them from the
  server's event log. Live frames that arrive meanwhile are held so they
  cannot overtake the replay. `recovered` reports the outcome.
* **Event ordering.** Conversation events carry an `eventSeq`; they are
  applied in order, duplicates are dropped, and a hole that does not close
  by itself within `gapFillDelay` (300 ms) is backfilled. When the log has
  expired (`EVENTS_EXPIRED`), the newest history page is re-read and
  published on `resyncs`.
* **Outbox.** `send()` queues every message until the server confirms it.
  A send the connection drops fails with `queued: true` and goes out again
  on reconnect with the same `clientMessageId`, so it is stored once. A
  send the server refuses is `failed` until `outbox.retry()` or
  `outbox.cancel()`. Implement `RavenOutboxStorage` to keep the queue
  across restarts.
* **Inbox.** `queryMyConversations()` and a live `chat.inbox` with unread
  counts and mentions, counted once across the page/socket overlap by
  `seq`.
* **Moderation.** `block` / `unblock` / `listBlocks`, `flagMessage`, and
  `ban` / `unban` / `mute` / `unmute` for moderators. New error codes
  `muted`, `banned`, `blocked`, `slowMode` (with `retryAfterSeconds`),
  `messageBlocked` (with `reason`), `eventsExpired`. A ban or a revoked
  membership arrives on `removedFromRoom`, and the room is no longer
  re-joined.
* **Push.** `registerDevice` / `unregisterDevice` / `listDevices`,
  `setNotificationLevel`, `muteConversation`.
* **Messages.** `mentions` on `send`, `pin` / `unpin` / `listPins` and the
  `pins` stream, `search`, paginated `threadPage`, `linkPreview`,
  `replyCount`, `lastReplyAt` and `seq` on `RavenMessage`, and
  `messageUpdateEvents` carrying the update's reason.
* **Large rooms.** `presenceCounts` and a paginated `listPresence`.
  Audience tokens (`isAudienceViewer`) join their room without naming it
  and refuse member-only calls locally.
* **Attachments, which were missing.** `createUploadTicket`,
  `uploadAttachment` (ticket, PUT straight to storage, confirm) and
  `getAttachmentDownloadUrl`.
* **Fixed:** HTTP errors were mapped on the canonical `RAVEN_*` code the
  API sends over REST, so every REST failure surfaced as `unknown`. The
  chat code (`legacyCode`) is preferred now. A bodiless 4xx/5xx is an
  error rather than an empty success.
* **Fixed:** a `read` frame's `messageId` was dropped, leaving
  `RavenReadState.lastReadMessageId` null for every live read receipt.

## 0.1.1

Two fixes from an external integration, both in behaviour the
documentation promised and the code did not deliver.

* **Fixed:** presence was lost on every reconnect. Presence is socket
  state, and the new socket a reconnect opens knows nothing of what was
  set on the old one — so a client that survived a blip went silently
  invisible to everybody else for the rest of the session, while its own
  `connectionState` still read `connected`. `setPresence()` now remembers
  what it was asked for and re-sends it after each reconnect, ahead of
  the room rejoins so the server never processes a join for somebody it
  believes is absent. A client that never called `setPresence()` still
  announces nothing.

* **Fixed:** `startTyping()`'s documentation said it was safe to call on
  every keystroke. The server disagreed — typing frames are limited to 20
  per 10 seconds, which a fast typist passes inside a sentence, and the
  21st came back as an error banner mid-message. The repeats are now
  dropped client-side rather than sent and refused: at most one frame
  every two seconds per room, well inside the limit and well short of the
  indicator's own TTL. `stopTyping()` clears the window, so stopping and
  starting again still signals immediately.

* **Documented:** `connect()` joins a conversation; it does not announce
  the user. Two connected clients each see only themselves until they
  call `setPresence()`. That is deliberate and shared with every other
  Livqeno Chat SDK — a client that reads without appearing is an ordinary
  thing to build — but it was nowhere in the API documentation.

## 0.1.0

Initial release (Livqeno Phase 13).

* `RavenChat` — connect, join rooms, send and receive, with bounded
  exponential-backoff reconnection.
* Message history with cursor pagination, editing, soft deletion, threads.
* Presence, typing indicators, reactions, read receipts.
* Idempotent sends: a retry after a reconnect returns the original message
  instead of posting a duplicate.
* Typed errors sharing the web SDK's codes.
