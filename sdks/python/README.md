# swalvo

Swalvo's official **Python server SDK** — mint short-lived RTC and chat
tokens, manage rooms and live streams, and read connection/error
diagnostics from your own backend.

Swalvo is a managed real-time infrastructure platform: video, voice, chat
and live streaming for your app, without running WebRTC or WebSocket
servers yourself. Learn more: <https://swalvo.com>

> **Backend only.** This package holds a permanent project API key. It must
> never be imported into browser, mobile or any other client-side code. The
> browser talks to Swalvo with a short-lived token that *this* SDK mints.

## Requirements

- Python **3.10+**
- A Swalvo project API key

## Install

```bash
# Not on PyPI yet — see docs/releases.md.
pip install "git+https://github.com/atulsinghhhh/swalvo-sdks.git#subdirectory=sdks/python"
```

Once published: `pip install swalvo`. Import it as `swalvo` —
`from swalvo import Swalvo`.

> **Migrating from `livqeno-sdk` / `import raven`?** Install `swalvo` and
> change `raven` to `swalvo` in your imports. The old `raven` package and
> the `Raven`, `AsyncRaven` and `RavenError` names still work as deprecated
> aliases (importing `raven` emits a `DeprecationWarning`). Error `code`
> strings such as `RAVEN_NOT_FOUND` are unchanged.

## Mint a token

Identity comes from *your* session — never from the request body, or any
caller can claim to be anyone.

```python
import os
from swalvo import Swalvo, CreateTokenParams

swalvo = Swalvo(
    api_key=os.environ["SWALVO_API_KEY"],
    base_url=os.environ["SWALVO_API_URL"],  # https://api.swalvo.com
)

grant = swalvo.tokens.create(CreateTokenParams(room="room-1", identity="user-42"))

# grant is a TypedDict, keyed exactly as the API returns it:
#   grant["token"]        short-lived, safe to hand to a browser
#   grant["endpoint"]     Swalvo's signaling WebSocket
#   grant["iceServers"]   never hand-build STUN/TURN config
#   grant["expiresAt"]
```

Hand `grant` to your frontend, which passes it to `@swalvo/rtc`. See
[docs/sdk.md](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk.md).

## Async

Every resource has an async twin with the same shape.

```python
from swalvo import AsyncSwalvo, CreateTokenParams

async with AsyncSwalvo(
    api_key=os.environ["SWALVO_API_KEY"],
    base_url=os.environ["SWALVO_API_URL"],  # https://api.swalvo.com
) as swalvo:
    grant = await swalvo.tokens.create(CreateTokenParams(room="room-1", identity="user-42"))
```

## Resources

`tokens` · `rooms` · `projects` · `connections` · `errors` · `diagnostics`
· `metrics` · `chat` · `live_streams`

`rooms` also moderates a live call (`remove_participant`, `mute_participant`,
`update_participant_permissions`), changes a participant's metadata and
attributes (`update_participant`) and sends server data messages
(`send_data`). Verify webhook deliveries with
`swalvo.verify_webhook(raw_body, request.headers, secret)` — pass the
headers mapping (it reads `swalvo-signature`, falling back to the legacy
`raven-signature`) or a single header value.

## Errors

Every non-2xx response and every transport failure raises `SwalvoError`,
carrying the API's error code and HTTP status so you can branch on the
cause rather than parse a message. It is built only from the parsed error
body and response metadata, so it can never carry your API key.

```python
from swalvo import Swalvo, SwalvoError

try:
    swalvo.rooms.get("no-such-room")
except SwalvoError as err:
    print(err.code, err.status_code, err.request_id)
```

Codes are listed in
[docs/error-codes.md](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/error-codes.md).

## Documentation

- [Python server SDK reference](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/sdk/server/python.md)
- [Server SDK security model](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/docs/security/server-sdk.md)
- [Runnable example](https://github.com/atulsinghhhh/swalvo-sdks/tree/main/examples/python-server)

## Development

From `sdks/python/`:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

ruff format --check .    # formatting
ruff check .             # lint
mypy src                 # strict type check
pytest                   # tests
python -m build          # sdist + wheel
```

CI runs all of the above against Python 3.10–3.13 on every pull request
(`.github/workflows/ci.yml`).

## License

MIT — see [LICENSE](https://github.com/atulsinghhhh/swalvo-sdks/blob/main/LICENSE).
