# Swalvo Server SDK for Java

Swalvo's **backend** SDK for the JVM. Use it to mint short-lived RTC and chat tokens, manage rooms
and live streams (hosts, viewers, the stage, restreams, ingest and HLS playback), read connection
and error diagnostics, and verify webhooks.

Part of [Swalvo](https://github.com/atulsinghhhh/swalvo-sdks), open-source real-time communication infrastructure.
It mirrors the [TypeScript server SDK](../../packages/server-sdk) resource for resource.

> **Never ship this in a client.** It holds a permanent project API key. Browsers and apps get
> a short-lived token that *this* SDK mints.

- Java 17+
- Uses `java.net.http.HttpClient`. Its only runtime dependency is `jackson-databind`.
- Instances are immutable and thread-safe. Build one client and share it.

## Install

The SDK is not on Maven Central yet. Build it from this directory with `mvn install`, then add:

```xml
<dependency>
  <groupId>com.swalvo</groupId>
  <artifactId>swalvo-server</artifactId>
  <version>0.1.0</version>
</dependency>
```

Gradle: `implementation("com.swalvo:swalvo-server:0.1.0")`.

## Quickstart

Identity comes from **your** session, never from the request body. If you take it from the body, any caller can claim to be anyone.

```java
import com.swalvo.server.Swalvo;
import com.swalvo.server.model.*;

Swalvo swalvo = Swalvo.builder()
        .apiKey(System.getenv("SWALVO_API_KEY"))
        .baseUrl(System.getenv("SWALVO_API_URL"))   // https://api.swalvo.com
        .build();

Room room = swalvo.rooms().create(CreateRoomParams.builder().name("standup").getOrCreate(true).build());

IssuedToken grant = swalvo.tokens().create(CreateTokenParams.builder()
        .room(room.id())
        .identity("user-42")
        .build());
// grant.token(), grant.endpoint(), grant.iceServers(), grant.telemetryUrl(), grant.expiresAt()
```

Return `grant` to your frontend, which passes it to `@swalvo/rtc`.

### Configuration

| Builder method | Default | Notes |
| --- | --- | --- |
| `apiKey(String)` | required | Never read from the environment implicitly. |
| `baseUrl(String)` | `http://localhost:4100` | Required in production (see below). Trailing `/` is trimmed. |
| `timeout(Duration)` | 10 s | Per attempt. Nothing hangs forever. |
| `maxRetries(int)` | 2 | Retries network errors, timeouts and 429/502/503/504. Backoff is exponential from 300 ms (300, 600, ...). |
| `httpClient(HttpClient)` | built-in | For proxies or executors. Don't let it follow redirects. |

**Production base URL.** If you omit `baseUrl`, the SDK falls back to a local dev stack that doesn't
exist in production. So `build()` throws `RAVEN_INVALID_CONFIG` when there's no `baseUrl` and the
environment is production: the `swalvo.env` system property, or the `SWALVO_ENV` or `NODE_ENV`
environment variable, equals `production`.

## Resources

Every call is synchronous and returns a record, or `void`. Path parameters are percent-encoded for you.

### Projects

```java
Project project = swalvo.projects().get();          // GET /v1/project — the key's one project
```

### Tokens

```java
IssuedToken t = swalvo.tokens().create(CreateTokenParams.builder()
        .room(roomId).identity("user-42")
        .permissions(TokenPermissions.builder().subscribe(true).publishAudio(true).build())
        .expiresIn(3600)            // seconds, 30–21600; sent as ttlSeconds
        .metadata("{\"plan\":\"pro\"}")
        .build());
```

### Rooms

```java
List<Room> rooms = swalvo.rooms().list();
Room room       = swalvo.rooms().get(roomId);
Room created    = swalvo.rooms().create("lobby");
Room vault      = swalvo.rooms().create(CreateRoomParams.builder().name("vault").e2ee(true).getOrCreate(true).build());
swalvo.rooms().delete(roomId);                       // soft-close (status CLOSED), never a hard delete

// Live participants as the SFU sees them. Empty Optional = SFU unreachable (≠ an empty room).
Optional<List<LiveParticipantInfo>> live = swalvo.rooms().participants().list(roomId);
Optional<LiveParticipantInfo> alice      = swalvo.rooms().participants().get(roomId, "alice");
```

### Moderation

Act on a participant who is connected right now. `roomId` is the room's id or its name.

```java
// Disconnect every live session of the identity. Doesn't revoke their token, so revoke it too
// if they must stay out.
swalvo.rooms().participants().remove(roomId, "alice");         // POST .../participants/:identity/remove

// Mute one track, or every track of one kind. Set exactly one of trackId and kind; muted(false) unmutes.
swalvo.rooms().participants().mute(roomId, "alice",
        MuteParticipantParams.builder().kind(TrackKind.AUDIO).muted(true).build());  // POST .../mute
swalvo.rooms().participants().mute(roomId, "alice",
        MuteParticipantParams.builder().trackId("TR_abc123").muted(false).build());

// Change live permissions in place. Only the fields you set are sent (false included); the rest
// stay as they are. Returns the merged permissions.
ParticipantPermissions perms = swalvo.rooms().participants().updatePermissions(roomId, "alice",
        UpdateParticipantPermissionsParams.builder().publish(false).build());     // PATCH .../permissions
perms.subscribe();                                               // true
```

`MuteParticipantParams.builder().build()` throws `IllegalArgumentException` for both or neither of
`trackId` and `kind`, or with no `muted`; `UpdateParticipantPermissionsParams` throws it with no field set.
Nothing is sent. A participant who isn't connected is a `SwalvoException` with code
`RAVEN_PARTICIPANT_NOT_CONNECTED` (404); a `trackId` that isn't theirs is `RAVEN_TRACK_NOT_FOUND` (404).

### Chat

```java
IssuedChatToken chatToken = swalvo.chat().createToken(CreateChatTokenParams.builder()
        .userId("user-42").conversations("conv_123").scopes(ChatScope.READ, ChatScope.SEND).expiresIn(3600).build());

ChatConversation conv = swalvo.chat().createConversation(CreateConversationParams.builder()
        .name("support").type(ChatConversationType.CHANNEL)
        .addMember("user-42", ChatMemberRole.MEMBER)      // a conversation with no members is unusable
        .getOrCreate(true).build());

swalvo.chat().listConversations(ListConversationsParams.builder().userId("user-42").build());
swalvo.chat().getConversation("support");              // conv_ id, name, or attached room id
swalvo.chat().addMember("support", ChatMemberParams.of("user-7", ChatMemberRole.MODERATOR));
swalvo.chat().listMembers("support");
swalvo.chat().removeMember("support", "user-7");

swalvo.chat().sendMessage("support", SendChatMessageParams.builder()
        .senderId("system").type(ChatMessageType.SYSTEM).text("Welcome!").clientMessageId("idem-1").build());

ChatMessagePage page = swalvo.chat().listMessages("support", ListChatMessagesParams.builder().limit(50).build());
if (page.hasMore()) {
    swalvo.chat().listMessages("support", ListChatMessagesParams.builder().before(page.nextCursor()).build());
}
swalvo.chat().deleteMessage(messageId);                // soft delete
```

### Live streams

`swalvo.live()` returns the same object as `swalvo.liveStreams()`.

```java
LiveStream stream = swalvo.liveStreams().create(CreateLiveStreamParams.builder()
        .title("Launch Q&A").hostIdentity("host-1")
        .deliveryMode(DeliveryMode.BROADCAST)            // or RTC_ONLY (default)
        .edgeScaling(true)
        .build());

swalvo.liveStreams().list(ListLiveStreamsParams.withStatus(LiveStreamStatus.LIVE));
swalvo.liveStreams().get(stream.id());                 // includes viewerCount and delivery
swalvo.liveStreams().update(stream.id(), UpdateLiveStreamParams.builder().title("New title").build());
swalvo.liveStreams().start(stream.id());               // CREATED → LIVE
swalvo.liveStreams().end(stream.id());                 // → ENDED (terminal)

// Hosts: the only route to publish access. Call from your backend after your own auth check.
IssuedStreamCredential host = swalvo.liveStreams().addHost(stream.id(), AddHostParams.of("cohost-1"));
swalvo.liveStreams().removeHost(stream.id(), "cohost-1");

// Viewers are always subscribe-only.
IssuedStreamCredential viewer = swalvo.liveStreams().createViewerToken(stream.id(), "viewer-9");
// With acceptPlayback, a BROADCAST stream returns chat + HLS playback instead of a 409:
IssuedStreamCredential hls = swalvo.liveStreams().createViewerToken(
        stream.id(), "viewer-9", ViewerTokenOptions.acceptingPlayback());
hls.playback().url();       // HLS manifest (may 404 briefly while starting)
hls.playback().llhlsUrl();  // low-latency HLS, preferred when present
hls.playback().status();

// The stream's delivery view: mode, status, playbackUrl, llhlsPlaybackUrl, recordingUrl
LiveStreamDelivery delivery = swalvo.liveStreams().getPlayback(stream.id());

swalvo.liveStreams().leave(stream.id(), "viewer-9");   // clean-leave signal for live_stream.viewer_left
```

**Stage** (invite viewers up, promote them to co-host, and demote them):

```java
swalvo.liveStreams().stage().invite(stream.id(), "viewer-9");
IssuedStreamCredential onStage = swalvo.liveStreams().stage().promote(stream.id(), "viewer-9");
swalvo.liveStreams().stage().promote(stream.id(), "viewer-9", LiveStreamHostRole.HOST);
swalvo.liveStreams().stage().demote(stream.id(), "viewer-9");
```

**Restreams** (RTMP out to YouTube, Twitch and others, up to 5 destinations). A destination's stream key is write-only:

```java
RestreamView yt = swalvo.liveStreams().restreams().create(stream.id(),
        CreateRestreamParams.of("rtmps://a.rtmp.youtube.com/live2", youtubeKey, "YouTube"));
swalvo.liveStreams().restreams().list(stream.id());
swalvo.liveStreams().restreams().update(stream.id(), yt.id(), UpdateRestreamParams.builder().enabled(false).build());
swalvo.liveStreams().restreams().delete(stream.id(), yt.id());
```

**Ingress** (WHIP or RTMP in, from OBS, vMix, ffmpeg or a hardware encoder). The stream key appears only in the `create()` and `reset()` responses, so store it then:

```java
IngressWithKey ingest = swalvo.liveStreams().ingress().create(stream.id(),
        CreateIngressParams.builder().protocol(IngressProtocol.RTMP).reconnectWindowSec(60).build());
ingest.rtmpUrl(); ingest.streamKey();                   // toString() redacts the key
swalvo.liveStreams().ingress().get(stream.id());       // status + observed input, never the key
swalvo.liveStreams().ingress().reset(stream.id());     // rotates the key, disconnects the encoder
swalvo.liveStreams().ingress().delete(stream.id());
```

### Connections, errors, metrics, diagnostics

```java
swalvo.connections().list(ListConnectionsParams.builder().roomId(roomId).state(ConnectionSummaryState.FAILED).limit(25).build());
ConnectionDetail conn = swalvo.connections().get("conn_abc");   // + events and errors

swalvo.errors().list(ListErrorsParams.builder().category(ErrorCategory.ICE_ERROR).limit(10).build());
ErrorDetail err = swalvo.errors().get("err_abc");                // + its connection

MetricsOverview m = swalvo.metrics().get(MetricsRange.LAST_24_HOURS);   // 15m, 1h, 24h, 7d
ProjectDiagnostics d = swalvo.diagnostics().get();               // signaling/sfu/turn health
```

Enum fields decode an unknown value from a newer API as `UNRECOGNIZED`, so they don't throw.
Unknown JSON fields are ignored.

## Webhooks

Every delivery is signed. `swalvo-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
Deliveries also carry identical legacy `raven-*` twins of every `swalvo-*` header; the unprefixed
`SIGNATURE_HEADER`, `EVENT_ID_HEADER` and `EVENT_TYPE_HEADER` constants keep those legacy names.
Verify it against the **raw** body bytes, before you parse any JSON. The verifier compares in
constant time and rejects timestamps more than 300 s off.

```java
import com.swalvo.server.webhooks.WebhookVerifier;

byte[] raw = request.getInputStream().readAllBytes();
String signature = WebhookVerifier.signatureHeader(request::getHeader);   // swalvo-signature, else raven-signature
if (!WebhookVerifier.verify(raw, signature, System.getenv("SWALVO_WEBHOOK_SECRET"))) {
    response.setStatus(400);
    return;
}
String eventId   = request.getHeader(WebhookVerifier.SWALVO_EVENT_ID_HEADER);    // "swalvo-event-id": dedupe on it
String eventType = request.getHeader(WebhookVerifier.SWALVO_EVENT_TYPE_HEADER);  // "swalvo-event-type"
```

There are also overloads that take an explicit `nowSeconds` and tolerance. `WebhookVerifier.sign(body, secret, t)`
produces a header exactly the way Swalvo does, which helps when you test your endpoint.

## Errors

The SDK throws one unchecked exception type, `SwalvoException`:

| Accessor | Meaning |
| --- | --- |
| `getCode()` | The API's error code, e.g. `RAVEN_ROOM_NOT_FOUND`. Never null. |
| `getStatusCode()` | The HTTP status, or `null` for config, timeout and network errors. |
| `getMessage()` | A human-readable message. Array messages are joined with `; `. |
| `getRequestId()` | `x-request-id`, for bug reports. |
| `getDetails()` | The parsed error body (`Map`/`List`/...), or `null`. |

```java
try {
    swalvo.rooms().get(roomId);
} catch (SwalvoException e) {
    switch (e.getCode()) {
        case "RAVEN_ROOM_NOT_FOUND" -> ...;
        case "RAVEN_RATE_LIMITED"   -> ...;
        default -> throw e;
    }
}
```

The SDK produces these codes itself: `RAVEN_INVALID_CONFIG`, `RAVEN_TIMEOUT` and `RAVEN_NETWORK_ERROR`.
`RAVEN_INVALID_RESPONSE` means a 2xx body didn't decode. If a proxy strips the JSON body, the code is
derived from the status: 401 → `RAVEN_AUTH_ERROR`, 403 → `RAVEN_PERMISSION_DENIED`,
404 → `RAVEN_NOT_FOUND`, 429 → `RAVEN_RATE_LIMITED`, 5xx → `RAVEN_INTERNAL_ERROR`, and anything
else → `VALIDATION_ERROR`. The full list is in [docs/error-codes.md](../../docs/error-codes.md).

**Secrets.** The API key never appears in `toString()` on the client, its builder or its resources, or in
any exception. If a server ever echoes the key back, it is replaced with `[REDACTED]` in the
exception's message and details. `IngressWithKey` and `CreateRestreamParams` also leave stream keys
out of their `toString()`.

## Development

Build and test in Docker. You don't need a local Maven:

```bash
docker run --rm -v "$PWD":/w -w /w -v swalvo-m2:/root/.m2 maven:3.9-eclipse-temurin-17 mvn -q -B verify
```

The unit tests run against a local `com.sun.net.httpserver.HttpServer` and never call a real API.
`SwalvoIntegrationTest` is opt-in. It runs only when both `SWALVO_IT_BASE_URL` and `SWALVO_IT_API_KEY`
are set, and it creates and then cleans up its own room and live stream.

## License

MIT
