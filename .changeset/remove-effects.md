---
"@swalvo/rtc": minor
"@swalvo/react": minor
"@swalvo/react-native": minor
---

**Breaking:** remove the Swalvo Effects integration (camera filters and presets). The Effects product has been discontinued and `@swalvo/effects` is no longer published or depended on.

- `@swalvo/rtc`: `LocalTrack.attachEffects()` and `LocalTrack.detachEffects()` are removed, along with the `@swalvo/effects` dependency. Every other track, room and publishing behavior is unchanged.
- `@swalvo/react`: `useCameraEffects()` and `UseCameraEffectsResult` are removed, as are the re-exports `createEffectsPipeline`, `effectFilters`, `effectPresets`, `isEffectsError`, `EFFECT_SECURITY_LIMITS` and the types `ColorOpParams`, `EffectInstance`, `EffectsError`, `EffectsErrorCode`, `EffectsPipeline`, `FilterConfig`, `Preset`. `@swalvo/effects` is no longer an optional peer dependency.
- `@swalvo/react-native`: the re-exports `createEffectsPipeline`, `filters`, `presets`, `beauty`, `isEffectsError`, `EFFECT_SECURITY_LIMITS`, `EFFECTS_NATIVE_ENGINE_STATUS` and the types `ColorOpParams`, `EffectInstance`, `EffectsError`, `EffectsErrorCode`, `EffectsPipeline`, `EffectsEngineStatus`, `FilterConfig`, `Preset` are removed, and `@swalvo/effects` is no longer a peer dependency. The native effects engine never shipped, so no video behavior changes.

Migration: delete any calls to these APIs and uninstall `@swalvo/effects`. Nothing replaces them.
