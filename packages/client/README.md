# @swalvo/live

Livqeno for the browser, with RTC and chat behind one object.

Part of [Livqeno](https://github.com/atulsinghhhh/swalvo-sdks), open-source real-time communication infrastructure.

This is a **facade, not a third implementation**: `swalvo.rtc` is a real
`RTCClient` from [`@swalvo/rtc`](https://www.npmjs.com/package/@swalvo/rtc)
and `swalvo.chat` is a real `ChatClient` from
[`@swalvo/chat`](https://www.npmjs.com/package/@swalvo/chat). Every
method, event and type documented for those packages applies here
unchanged, because they *are* those objects.

> **Only want calls?** Use `@swalvo/rtc` directly — it pulls in no
> messaging code. This package is for apps that want both planes without
> wiring two clients, and it mirrors the shape `@swalvo/react-native`
> gives mobile, so the same mental model works on both.

## Install

```bash
npm install @swalvo/live
```

## Use

RTC and chat credentials are independent, so supply whichever planes your
app actually uses:

```ts
import { Swalvo } from '@swalvo/live';

new Swalvo({ token, endpoint });                        // calls only
new Swalvo({ chatToken, chatApiUrl });                  // messaging only
new Swalvo({ token, endpoint, chatToken, chatApiUrl }); // both
```

```ts
const swalvo = new Swalvo({ token, endpoint, chatToken, chatApiUrl });

const room = await swalvo.join('room_123');
await room.enableCamera();

await swalvo.chat!.connect({ room: 'room_123' });
await swalvo.chat!.sendMessage({ text: 'Hello' });
```

Every value comes from your backend's token-mint response — none should be
hand-constructed.

### Live streaming

`swalvo.live` is available on every instance regardless of the credentials
the instance was built with: host, co-host and viewer tokens are minted
per stream, per role, by your backend.

```ts
const stream = await swalvo.live.join(credentials);
if (stream.isHost) await stream.room.enableCamera();
```

## Exports

`Swalvo`, `createSwalvo`, `LiveStream`, `joinLiveStream`, plus re-exported
`Room`, `RTCClient`, `ChatClient`, `ChatMessage`, `RTCError` types for
convenience.

## Documentation

- [Browser SDK reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk.md) · [Chat SDK](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/chat.md)
- Runnable example: [`examples/rtc-chat`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/examples/rtc-chat)

## License

MIT
