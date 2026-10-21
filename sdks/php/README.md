# swalvo/swalvo-php

Swalvo's **PHP server SDK**. Use it to mint short-lived RTC, chat and live-stream credentials,
manage rooms, conversations and live streams, read connection and error diagnostics, and verify
webhooks.

It is the PHP counterpart of [`@swalvo/server`](../../packages/server-sdk) (TypeScript) and
[`swalvo`](../python) (Python). It has the same resources, methods and wire fields.

> **Backend only.** The client holds a permanent project API key. Your frontend only ever gets the
> short-lived token that *this* SDK mints.

- PHP 8.1+, `ext-curl` and `ext-json`. Nothing else: no Guzzle, no PSR-18 adapter needed.
- Typed, readonly response objects. `json_encode()` on any of them gives back the exact API payload,
  ready to forward to your frontend.
- One exception type, `Swalvo\SwalvoException`, carrying the API's error code.

## Install

```bash
composer require swalvo/swalvo-php
```

The package isn't on Packagist yet. Until it is, install it from a checkout with a path repository:

```json
{
    "repositories": [{ "type": "path", "url": "../path/to/checkout/sdks/php" }],
    "require": { "swalvo/swalvo-php": "*" }
}
```

## Quickstart

Identity comes from **your** session, never from the request body. Otherwise any caller could claim to
be anyone.

```php
<?php
require 'vendor/autoload.php';

$client = new \Swalvo\Client(
    apiKey: getenv('SWALVO_API_KEY'),
    baseUrl: getenv('SWALVO_API_URL'), // https://api.swalvo.com
);

$room = $client->rooms->create(['name' => 'standup', 'getOrCreate' => true]);

$grant = $client->tokens->create([
    'room' => $room->id,          // the room's id, not its name
    'identity' => $currentUser->id,
    'expiresIn' => 600,           // seconds, 30 to 21600
]);

header('Content-Type: application/json');
echo json_encode($grant); // { token, endpoint, iceServers, telemetryUrl, expiresAt, ... }
```

Hand that JSON to your frontend, which passes it to `@swalvo/rtc`.

## Configuration

```php
new \Swalvo\Client(
    apiKey: getenv('SWALVO_API_KEY'), // required
    baseUrl: 'https://api.swalvo.com', // default http://localhost:4100 (local dev only)
    timeout: 10.0,                      // seconds per attempt
    maxRetries: 2,                      // network errors and 429/502/503/504 only
    transport: null,                    // a Swalvo\Http\TransportInterface; defaults to ext-curl
);
```

| Behaviour | Value |
|---|---|
| Auth | `Authorization: Bearer <apiKey>` |
| User-Agent | `Swalvo-Server-SDK/<version> (php <PHP_VERSION>)` |
| Timeout | 10 s per attempt (`RAVEN_TIMEOUT` when exceeded) |
| Retries | 2, with exponential backoff (300 ms, then 600 ms), on network errors and HTTP 429/502/503/504 only. Never on 400/401/403/404/409/422/500. |
| Missing `apiKey` | throws `RAVEN_INVALID_CONFIG`. `getenv()` returning `false` counts as missing. |
| Production | When `APP_ENV` is `production` or `prod` (from `getenv`, `$_ENV` or `$_SERVER`), `baseUrl` is required and leaving it out throws `RAVEN_INVALID_CONFIG`. It never silently falls back to localhost. This mirrors the TS SDK's `NODE_ENV=production` rule. |
| Redirects | Not followed. The bearer token only ever goes to `baseUrl`. |

The SDK never reads the API key from the environment on its own. You pass it explicitly.

## Responses

- **Single objects.** Each method returns a typed object from `Swalvo\Model\*` (`Room`,
  `IssuedToken`, `LiveStream`, ...). Its properties are `public readonly` and named exactly like the
  wire fields.
- **Lists.** A list call returns a `list<...>` of those objects.
- **No content.** A 204 response returns `void`.

`$model->toArray()` returns the raw payload, including any field newer than this SDK version, and
`json_encode($model)` returns the same payload as JSON. TypeScript's inline object shapes, such as
`ProjectDiagnostics::$dependencies` and `ChatMessage::$reactions`, stay as arrays.

The parameters you pass are plain arrays using the same keys as the TypeScript SDK's parameter types.

## Resources

### Projects

```php
$project = $client->projects->get(); // the one project this key belongs to
```

### Rooms

```php
$client->rooms->list();
$client->rooms->get($roomId);
$client->rooms->create(['name' => 'standup', 'getOrCreate' => true, 'e2ee' => false]);
$client->rooms->delete($roomId); // soft-close: status CLOSED, never a hard delete

$client->rooms->participants->list($roomId);           // list<LiveParticipantInfo>, or null if the SFU is unreachable
$client->rooms->participants->get($roomId, 'user-42'); // ?LiveParticipantInfo
```

### Moderation

Act on a participant who is connected right now. `$roomId` is the room's id or its name.

```php
// Disconnect every live session of the identity. Doesn't revoke their token, so revoke it too
// if they must stay out.
$client->rooms->participants->remove($roomId, 'alice');   // POST .../participants/{identity}/remove

// Mute one track, or every track of one kind. Pass exactly one of trackId and kind; muted: false unmutes.
$client->rooms->participants->mute($roomId, 'alice', ['kind' => 'audio', 'muted' => true]);
$client->rooms->participants->mute($roomId, 'alice', ['trackId' => 'TR_abc123', 'muted' => false]);

// Change live permissions in place. Only the fields you pass are sent (false included); the rest
// stay as they are. Returns the merged ParticipantPermissions.
$perms = $client->rooms->participants->updatePermissions($roomId, 'alice', ['publish' => false]);
$perms->subscribe; // true
```

`mute()` with both or neither of `trackId` and `kind`, or no boolean `muted`, and `updatePermissions()`
with no field, throw `VALIDATION_ERROR` without sending a request. A participant who isn't connected is
a 404 with `RAVEN_PARTICIPANT_NOT_CONNECTED`; a `trackId` that isn't theirs is a 404 with
`RAVEN_TRACK_NOT_FOUND`.

### Tokens (RTC)

```php
$client->tokens->create([
    'room' => $roomId,
    'identity' => 'user-42',
    'permissions' => ['publish' => false, 'subscribe' => true],
    'expiresIn' => 600,
    'metadata' => '{"displayName":"Ada"}',
]); // IssuedToken
```

### Chat

```php
$chatToken = $client->chat->createToken([
    'userId' => 'user-42',
    'conversations' => ['conv_123'],
    'scopes' => ['chat:read', 'chat:send'], // can only narrow the user's role
    'expiresIn' => 900,
]);

$conv = $client->chat->createConversation([
    'name' => 'general',
    'type' => 'CHANNEL',
    'members' => [['userId' => 'user-42', 'role' => 'ADMIN']], // a conversation with no members is unusable
    'getOrCreate' => true,
]);
$client->chat->listConversations(['userId' => 'user-42', 'includeArchived' => false]);
$client->chat->getConversation('general');            // conv_ id, name, or attached RTC room id
$client->chat->addMember('general', ['userId' => 'user-43', 'role' => 'MODERATOR']);
$client->chat->listMembers('general');
$client->chat->removeMember('general', 'user-43');
$client->chat->sendMessage('general', ['senderId' => 'system', 'type' => 'system', 'text' => 'Welcome!']);
$page = $client->chat->listMessages('general', ['limit' => 50, 'before' => $cursor]);
$page->data; $page->nextCursor; $page->hasMore;
$client->chat->deleteMessage('msg_123');               // soft delete
```

### Live streams

`$client->live` is the same object as `$client->liveStreams`.

```php
$stream = $client->liveStreams->create([
    'title' => 'Launch day',
    'hostIdentity' => 'alice',
    'deliveryMode' => 'BROADCAST', // or RTC_ONLY (default)
    'edgeScaling' => true,
]);
$client->liveStreams->list(['status' => 'LIVE']);
$client->liveStreams->get($stream->id);                // includes viewerCount
$client->liveStreams->update($stream->id, ['title' => 'Launch day (replay)']);
$client->liveStreams->start($stream->id);              // CREATED -> LIVE
$client->liveStreams->end($stream->id);                // LIVE -> ENDED (terminal)

// Hosts: the only route to publish access. Call it after your own auth check.
$host = $client->liveStreams->addHost($stream->id, ['identity' => 'bob', 'role' => 'CO_HOST']);
$client->liveStreams->removeHost($stream->id, 'bob');

// Viewers: always subscribe-only. acceptPlayback lets a BROADCAST stream return HLS instead of a 409.
$viewer = $client->liveStreams->createViewerToken($stream->id, 'viewer-9', ['acceptPlayback' => true]);
$viewer->rtc;                 // ?IssuedToken (null on a playback credential)
$viewer->rtcRoom;             // ?string
$viewer->playback?->url;      // HLS manifest
$viewer->playback?->llhlsUrl; // low-latency HLS, when available
$viewer->playback?->status;

// Delivery: how the audience watches the stream.
$stream->delivery?->playbackUrl;
$stream->delivery?->llhlsPlaybackUrl;
$client->liveStreams->getPlayback($stream->id); // LiveStreamDeliveryView

// The stage
$client->liveStreams->stage->invite($stream->id, 'viewer-9');
$cred = $client->liveStreams->stage->promote($stream->id, 'viewer-9', ['role' => 'CO_HOST']);
$client->liveStreams->stage->demote($stream->id, 'viewer-9');

$client->liveStreams->leave($stream->id, 'viewer-9'); // clean-leave signal for live_stream.viewer_left
```

#### Restreams (RTMP out)

```php
$dest = $client->liveStreams->restreams->create($stream->id, [
    'url' => 'rtmps://a.rtmp.youtube.com/live2',
    'streamKey' => getenv('YOUTUBE_STREAM_KEY'), // write-only; only keyLast4 comes back
    'label' => 'YouTube',
]);
$client->liveStreams->restreams->list($stream->id);
$client->liveStreams->restreams->update($stream->id, $dest->id, ['enabled' => false]); // pause
$client->liveStreams->restreams->delete($stream->id, $dest->id);
```

#### Ingress (OBS / WHIP / RTMP in)

```php
$ingress = $client->liveStreams->ingress->create($stream->id, ['protocol' => 'RTMP']);
$ingress->streamKey; // sk_... shown only by create() and reset(): store it now
$ingress->rtmpUrl; $ingress->rtmpsUrl; $ingress->whipUrl;
$client->liveStreams->ingress->get($stream->id);   // status and the encoder's input; never the key
$client->liveStreams->ingress->reset($stream->id); // rotate the key, disconnect the encoder
$client->liveStreams->ingress->delete($stream->id);
```

### Connections, errors, metrics, diagnostics

```php
$client->connections->list(['roomId' => $roomId, 'state' => 'FAILED', 'limit' => 20]);
$client->connections->get($connectionId);          // ConnectionDetail with events and errors
$client->errors->list(['category' => 'ICE_ERROR', 'limit' => 20]);
$client->errors->get($errorId);                    // ErrorDetail with its connection
$client->metrics->get('24h');                      // 15m | 1h | 24h | 7d
$client->diagnostics->get();                       // signaling / sfu / turn health
```

## Webhooks

Every delivery carries three headers:

- `swalvo-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
- `swalvo-event-id`
- `swalvo-event-type`

Each also arrives as an identical legacy `raven-*` twin for integrations written before the rename. The
`Webhook::SWALVO_*_HEADER` constants name the new headers; `Webhook::SIGNATURE_HEADER`,
`EVENT_ID_HEADER` and `EVENT_TYPE_HEADER` keep the legacy `raven-*` names.

`Swalvo\Webhook` verifies the signature. It compares in constant time (`hash_equals`) and rejects a
timestamp more than 300 s away from now, which blocks replays. Always verify the **raw** body.

```php
use Swalvo\SwalvoException;
use Swalvo\Webhook;

$webhook = new Webhook(getenv('SWALVO_WEBHOOK_SECRET'));

$rawBody = file_get_contents('php://input');
$signature = $_SERVER['HTTP_SWALVO_SIGNATURE'] ?? $_SERVER['HTTP_RAVEN_SIGNATURE'] ?? null;
$eventId = $_SERVER['HTTP_SWALVO_EVENT_ID'] ?? null;             // Webhook::SWALVO_EVENT_ID_HEADER, for idempotency
$eventType = $_SERVER['HTTP_SWALVO_EVENT_TYPE'] ?? null;         // Webhook::SWALVO_EVENT_TYPE_HEADER

try {
    $event = $webhook->constructEvent($rawBody, $signature);    // verified and json-decoded
} catch (SwalvoException $e) {                                  // RAVEN_WEBHOOK_SIGNATURE_INVALID
    http_response_code(400);
    exit;
}

// Or just the boolean check:
$webhook->verify($rawBody, $signature);
// Laravel: $webhook->verify($request->getContent(), $request->header('swalvo-signature') ?? $request->header('raven-signature'));
```

`new Webhook($secret, toleranceSeconds: 300)` changes the tolerance. `Webhook::sign($body, $secret, $t)`
produces a header exactly as the API does, which helps when you test your own receiver.

## Errors

Every failure is a `Swalvo\SwalvoException`:

```php
use Swalvo\SwalvoException;

try {
    $client->rooms->get('room_missing');
} catch (SwalvoException $e) {
    $e->errorCode;  // 'RAVEN_ROOM_NOT_FOUND' (also $e->getErrorCode())
    $e->statusCode; // 404, or null for a network or config error (also getCode(), 0 when null)
    $e->getMessage();
    $e->requestId;  // x-request-id, for bug reports
    $e->details;    // the decoded error body
}
```

| Code | When |
|---|---|
| *the API's own code* | Any error response with a JSON body, passed through untouched (`RAVEN_ROOM_NOT_FOUND`, `RAVEN_CAPACITY_EXCEEDED`, ...) |
| `RAVEN_AUTH_ERROR` / `RAVEN_PERMISSION_DENIED` / `RAVEN_NOT_FOUND` / `RAVEN_RATE_LIMITED` / `RAVEN_INTERNAL_ERROR` / `VALIDATION_ERROR` | A 401/403/404/429/5xx/other response whose body isn't JSON, for example a proxy's HTML page |
| `RAVEN_TIMEOUT` | No response within `timeout` (after retries) |
| `RAVEN_NETWORK_ERROR` | DNS, connection refused, TLS and similar failures (after retries) |
| `RAVEN_INVALID_CONFIG` | Missing `apiKey`, or no `baseUrl` in production |
| `VALIDATION_ERROR` | Caught locally before sending: a missing required parameter, an empty id, or invalid moderation input |

Error codes are listed in [docs/error-codes.md](../../docs/error-codes.md).

## Keeping the key secret

- **Not stored as a property.** The API key isn't a property of any object. It lives in a class-private
  `WeakMap`, so `var_dump`, `print_r`, `var_export`, `(array)` casts and `json_encode` of the client
  can't reach it. `__debugInfo` prints `[REDACTED]`, and `serialize($client)` throws.
- **Redacted in requests.** The `Request` passed to a transport redacts `Authorization` when it's dumped,
  including when it appears as an argument in a stack trace.
- **Scrubbed from errors.** Error messages and details are scrubbed of the key, in case a server or proxy
  ever echoes it back.
- **Hidden from constructor traces.** Constructor parameters are marked `#[\SensitiveParameter]`, so a
  config error's stack trace shows `SensitiveParameterValue` instead of the key. This needs PHP 8.2+; on
  8.1 the attribute is ignored. Production `php.ini` also sets `zend.exception_ignore_args=On`, which
  hides trace arguments altogether.

## Custom transports

Implement `Swalvo\Http\TransportInterface::send(Request): Response`. Return a `Response` for every HTTP
status, and throw `Swalvo\Http\TransportException` (with `timeout: true` for timeouts) when no response
arrived. The HTTP client handles retries, JSON and error mapping.

## Development

PHP doesn't need to be installed on the host; everything runs in Docker.

```bash
docker run --rm -v "$PWD":/app -w /app composer:2 install
docker run --rm -v "$PWD":/app -w /app php:8.3-cli vendor/bin/phpunit
```

The unit suite runs in two ways:

- **Stub transport.** Every resource method is checked for verb, path, query and body.
- **Real transport.** The ext-curl transport runs against a `php -S` server on 127.0.0.1
  (`tests/Support/router.php`). These tests cover retries, timeouts, error decoding, secret redaction and
  the webhook verifier.

The integration test is opt-in and talks to a real API that you point it at:

```bash
docker run --rm -e SWALVO_IT_BASE_URL=https://api.example.test -e SWALVO_IT_API_KEY=rvk_... \
  -v "$PWD":/app -w /app php:8.3-cli vendor/bin/phpunit --testsuite integration
```

It creates a room, mints a token, creates, starts and ends a live stream, and mints a viewer token.

## License

MIT
