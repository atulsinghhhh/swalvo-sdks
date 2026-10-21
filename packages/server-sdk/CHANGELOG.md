# @swalvo/server

## Unreleased

### Major Changes

- Renamed from `@ravenkash/server` to `@swalvo/server` as part of the Raven/Livqeno → Swalvo rebrand. The client class is now `Swalvo` (`new Swalvo({ apiKey, baseUrl })`), with `SwalvoError`, `isSwalvoError`, `SwalvoErrorOptions` and `SwalvoClientOptions`. `Raven`, `RavenError`, `isRavenError`, `RavenErrorOptions` and `RavenClientOptions` remain exported as deprecated aliases of the same values. `error.name` now reads `SwalvoError`; `RAVEN_*` error codes are unchanged.
- `verifyWebhook` now also accepts the request headers object (Node, Express or Fetch `Headers`) and reads `swalvo-signature`, falling back to the legacy `raven-signature` header. Passing the header value as a string still works. New exports: `SWALVO_SIGNATURE_HEADER`, `LEGACY_WEBHOOK_SIGNATURE_HEADER`, `WEBHOOK_SIGNATURE_HEADERS`; `WEBHOOK_SIGNATURE_HEADER` is deprecated and still `raven-signature`.
- Requests now send `User-Agent: Swalvo-Server-SDK/<version> (node)` (was `Raven-Server-SDK`).

