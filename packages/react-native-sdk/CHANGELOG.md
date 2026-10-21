# @swalvo/react-native

## Unreleased

### Major Changes

- Renamed from `@ravenkash/react-native` to `@swalvo/react-native` as part of the Raven/Livqeno → Swalvo rebrand. The client class is now `Swalvo`, with `SwalvoConfig`, `SwalvoAppState`, `SwalvoChatHandle`, `SwalvoLiveStream` (+`SwalvoLiveStreamOptions`), `SwalvoVideoView` (+`SwalvoVideoViewProps`), `SwalvoAudioOutput`, `SwalvoPermissionError` / `SwalvoPermissionKind` / `SwalvoPermissionStatus` / `isSwalvoPermissionError`, `useSwalvoError` and `bootstrapSwalvoNative`. Every `Raven*` name remains exported as a deprecated alias of the same value, so `instanceof` checks keep working; `error.name` now reads `SwalvoPermissionError`. The `livqeno` key in live-stream stage-event metadata is a wire contract and is unchanged.

