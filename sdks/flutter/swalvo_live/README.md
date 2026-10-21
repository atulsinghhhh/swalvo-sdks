# swalvo_live

Swalvo Live Streaming for Flutter — join a stream as a host, co-host or
viewer, with the room and the live chat that come with it.

Part of [Swalvo](https://swalvo.com), managed real-time communication infrastructure.

Composes [`swalvo_rtc`](https://pub.dev/packages/swalvo_rtc) and
[`swalvo_chat`](https://pub.dev/packages/swalvo_chat); it adds no media or
messaging stack of its own. `stream.room` is an ordinary `SwalvoRoom` and
`stream.chat` is an ordinary `SwalvoChat`, so every API on both packages
works here unchanged.

## Requirements

- Dart SDK **>= 3.6.0**
- Flutter **>= 3.27.0**

## Install

```yaml
dependencies:
  swalvo_live: ^0.2.1
```

### Migrating from `raven_live`

This package was previously published as `raven_live`. Replace the
dependency with `swalvo_live` and the import with
`package:swalvo_live/swalvo_live.dart`. The `Raven*` type names (`RavenLiveStream`,
…) still compile as deprecated aliases of the `Swalvo*` ones until 1.0;
error code strings (`RAVEN_*`) and the wire protocol are unchanged.

## Use

Host, co-host and viewer credentials are minted per stream, per role, by
your backend.

```dart
import 'package:swalvo_live/swalvo_live.dart';

final stream = await SwalvoLiveStream.join(credentials);

if (stream.isHost) {
  await stream.room.enableCamera();
  await stream.room.enableMicrophone();
}
```

## Documentation

- [Flutter SDK reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/flutter.md)
- Runnable example: [`examples/flutter-rtc-chat`](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/examples/flutter-rtc-chat)

## License

MIT
