# @swalvo/server

Livqeno's **backend** SDK — mint short-lived RTC and chat tokens, manage
rooms and live streams, and read connection/error diagnostics.

Part of [Livqeno](https://github.com/atulsinghhhh/swalvo-sdks), open-source real-time communication infrastructure.

> **Never import this in a browser.** It holds a permanent project API key.
> The browser gets a short-lived token that *this* SDK mints.

## Install

```bash
npm install @swalvo/server
```

## Use

Identity comes from **your** session — never from the request body, or any
caller can claim to be anyone.

```ts
import { Swalvo } from '@swalvo/server';

const swalvo = new Swalvo({
  apiKey: process.env.SWALVO_API_KEY!,
  baseUrl: process.env.SWALVO_API_URL!, // https://api.livqeno.com
});

const grant = await swalvo.tokens.create({ room: roomId, identity: 'user-42' });
// grant = { token, endpoint, iceServers, telemetryUrl, expiresAt, ... }
```

Hand `grant` to your frontend, which passes it to `@swalvo/rtc`.

Moderate a live call, change a participant's metadata, or send a data
message from the server:

```ts
await swalvo.rooms.muteParticipant(roomId, 'alice', { kind: 'audio', muted: true });
await swalvo.rooms.updateParticipantPermissions(roomId, 'alice', { publish: false });
await swalvo.rooms.updateParticipant(roomId, 'alice', { attributes: { hand: 'raised' } });
await swalvo.rooms.sendData(roomId, 'meeting ends in 5 min', { topic: 'system' });
await swalvo.rooms.removeParticipant(roomId, 'alice');
```

Verify a webhook delivery (pass the raw body):

```ts
import { verifyWebhook } from '@swalvo/server';

// Pass the request headers: `swalvo-signature` is checked first, then the
// legacy `raven-signature` header (same value) as a fallback.
const event = verifyWebhook(rawBody, req.headers, process.env.SWALVO_WEBHOOK_SECRET!);
```

## Errors

```ts
import { SwalvoError, isSwalvoError } from '@swalvo/server';
```

Every failure carries the API's error code and HTTP status, so you branch
on the cause rather than parse a message. Codes are listed in
[docs/error-codes.md](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/error-codes.md).

## Documentation

- [TypeScript backend SDK reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/server/typescript.md)
- [Server SDK security model](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/security/server-sdk.md)
- Runnable example: [`examples/node-server`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/examples/node-server)

Python backend? See [Livqeno's Python SDK](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/sdks/python). It is not on PyPI
yet — it will publish as `swalvo-sdk`.

## License

MIT
