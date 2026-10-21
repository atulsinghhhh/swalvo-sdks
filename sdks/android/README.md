# Livqeno RTC for Android

Native Kotlin SDK for Livqeno video and audio calls. It speaks the
same signaling protocol as the web, React Native and Flutter SDKs
([`docs/rtc/signaling.md`](../../docs/rtc/signaling.md)) and uses the same
event names, so a call can mix all of them.

- Kotlin, coroutines and `Flow` for events
- `minSdk 24`, built against the highest installed platform (API 37)
- WebRTC from [`io.github.webrtc-sdk:android`](https://central.sonatype.com/artifact/io.github.webrtc-sdk/android)
- Camera (Camera2) with simulcast (low / medium / high), microphone,
  MediaProjection screen share
- Session resume, token refresh, server mute / removal / permission changes
- Active speakers, connection quality, subscription state, dynacast
  (`publisher.layers`), layer `off` for hidden videos
- Data messages v2: topics, targeted sends, a lossy channel and sender
  identity, matching
  [`docs/architecture/data-envelope-vectors.json`](../../docs/architecture/data-envelope-vectors.json)
- Participant metadata and attributes, screen-share audio (API 29+)
- End-to-end encryption via libwebrtc's FrameCryptor, matching
  [`docs/architecture/e2ee-vectors.json`](../../docs/architecture/e2ee-vectors.json)
- Helpers: audio routing, a call foreground service, a self-managed
  Telecom `ConnectionService`

## Install

The module is `:swalvo-rtc` in this Gradle project. Until it is published
to Maven, include it from source:

```kotlin
// settings.gradle.kts of your app
includeBuild("path/to/sdks/android") {
    dependencySubstitution {
        substitute(module("io.swalvo:swalvo-rtc")).using(project(":swalvo-rtc"))
    }
}

// app/build.gradle.kts
dependencies {
    implementation("io.swalvo:swalvo-rtc:0.1.0")
}
```

or build the AAR with `./gradlew :swalvo-rtc:assembleRelease` and use
`swalvo-rtc/build/outputs/aar/swalvo-rtc-release.aar` (then add its
dependencies, `io.github.webrtc-sdk:android`, OkHttp, kotlinx-coroutines and
kotlinx-serialization-json, yourself).

## Permissions

The SDK's manifest merges in `INTERNET`, `ACCESS_NETWORK_STATE`,
`MODIFY_AUDIO_SETTINGS`, and what its call service's foreground-service
types need from Android 14 (targetSdk 34): `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_CAMERA / _MICROPHONE / _MEDIA_PROJECTION / _PHONE_CALL`,
plus each type's prerequisite: `CAMERA`, `RECORD_AUDIO` and
`MANAGE_OWN_CALLS`.

`CAMERA` and `RECORD_AUDIO` are runtime permissions: being declared does not
grant them, so request them before publishing. Add the other runtime ones
to **your** manifest:

```xml
<!-- Android 12+: Bluetooth headsets with AudioRouter -->
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<!-- Android 13+: the call notification -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

`enableCamera()` / `enableMicrophone()` throw `RtcException` with
`CAMERA_PERMISSION_DENIED` / `MICROPHONE_PERMISSION_DENIED` if the
permission is missing.

## Quickstart

Your backend mints the token (with the TypeScript or Python server SDK);
the app fetches `token`, `endpoint` and `iceServers` from your own endpoint
and never sees an API key.

```kotlin
val client = SwalvoClient(
    applicationContext,
    SwalvoClientOptions(refreshToken = { myBackend.fetchRtcToken(roomId) }),
)

lifecycleScope.launch {
    val room = client.connect(
        token = grant.token,
        endpoint = grant.endpoint,                       // wss://…/v1/rtc
        iceServers = grant.iceServers.map { IceServer(it.urls, it.username, it.credential) },
    )

    launch {
        room.events.collect { event ->
            when (event) {
                is RoomEvent.TrackSubscribed -> if (event.track.mediaKind == MediaKind.VIDEO) {
                    event.track.addSink(tileFor(event.participant).renderer)
                }
                is RoomEvent.TrackUnsubscribed -> event.track.removeSink(tileFor(event.participant).renderer)
                is RoomEvent.ParticipantLeft -> removeTile(event.participant)
                is RoomEvent.ActiveSpeakersChanged -> highlight(event.speakers.firstOrNull())
                is RoomEvent.Disconnected -> showEnded(event.reason)   // never auto-rejoin after REMOVED / ROOM_CLOSED
                else -> Unit
            }
        }
    }

    room.enableMicrophone()
    room.enableCamera()
}
```

Render video with `org.webrtc.SurfaceViewRenderer`, initialised with the
SDK's EGL context:

```kotlin
renderer.init(client.eglBaseContext, null)
localCameraTrack.addSink(renderer)
```

Everyone already in the room when `connect` returns is in
`room.remoteParticipants`; events report changes after that.

### Events

`room.events` is a `SharedFlow<RoomEvent>` with the web SDK's event names:
`ConnectionStateChanged`, `Connected`, `Disconnected(reason)`,
`Reconnecting`, `Reconnected`, `Warning`, `ParticipantJoined`,
`ParticipantLeft`, `TrackPublished`, `TrackUnpublished`, `TrackSubscribed`,
`TrackUnsubscribed`, `TrackMuted`, `TrackUnmuted`, `ActiveSpeakersChanged`,
`ConnectionQualityChanged`, `TrackSubscriptionStateChanged`,
`LocalTrackPublished`, `LocalTrackUnpublished`, `LocalTrackMutedByServer`,
`PermissionsChanged`, `ParticipantMetadataChanged`, `DataReceived`,
`DataThrottled`, `Error`, plus `E2eeStateChanged`.
Each participant also has `events` (`IsSpeakingChanged`,
`ConnectionQualityChanged`, `MetadataChanged`) and `StateFlow`s for
`isSpeaking`, `audioLevel`, `connectionQuality`, `metadata` and
`attributes`.

### Data messages

```kotlin
room.sendData("hi")                                               // reliable broadcast, as always
room.sendData(bytes, DataPublishOptions(topic = "chat"))
room.sendData(bytes, DataPublishOptions(destinationIdentities = listOf("alice")))
room.sendData(cursor, DataPublishOptions(topic = "cursor", reliable = false)) // lossy, up to 1,200 bytes

room.events.filterIsInstance<RoomEvent.DataReceived>().collect { e ->
    // e.participant: the sender (stamped by the SFU), or null for a server message
    // e.topic: null when the sender gave none
}
```

The reliable channel takes up to 64 KiB per message, the lossy one 1,200
bytes. Topics are at most 255 bytes of UTF-8, and a message goes to at most
64 identities. Topics, targeting and the lossy channel need a server that
advertises `data.v2` (`room.supportsDataV2`); against an older server
`reliable = false` falls back to the reliable channel with a warning. Over
the SFU's rate limit messages are dropped and the room emits
`RoomEvent.DataThrottled(channel)`. **Data messages are not end-to-end
encrypted, even in an E2EE room.**

### Metadata and attributes

```kotlin
room.localParticipant.setMetadata("""{"role":"host"}""")
room.localParticipant.setAttributes(mapOf("hand" to "raised"))
participant.metadata; participant.attributes
```

Initial values come from the token (`metadata` / `attributes` at mint).
Updating your own needs a token minted with `perms.updateOwnMetadata = true`
(else `RtcException(PERMISSION_DENIED)`); limits are 4 KiB of metadata and
32 attributes (64-character keys, 1 KiB values), checked before sending
(`INVALID_ARGUMENT`). Changes are not applied optimistically: they arrive,
for everyone including you, as `RoomEvent.ParticipantMetadataChanged`.

### Saving bandwidth

```kotlin
track.setVisible(false)        // tile scrolled away: layer "off" after 500 ms
track.setEnabled(false)        // app pause: layer "off" now
track.setLayer(VideoLayer.LOW) // pin a simulcast layer
```

`SwalvoClientOptions(autoSubscribe = false)` starts every remote video
paused until you show, enable or pin it. Audio always flows. Your own
camera's unused simulcast layers are switched off automatically when the
SFU says nobody is watching them (`publisher.layers`).

## Calls in the background: the foreground service

Android stops camera and microphone capture once your activity leaves the
screen unless a foreground service is running. Start the SDK's service when
the call starts and stop it when it ends:

```kotlin
SwalvoCallService.start(context, SwalvoCallService.Config(
    title = "Call with Ada", camera = true, microphone = true,
))
// …
room.leave()
SwalvoCallService.stop(context)
```

**Screen share:** on Android 14+ the service must already be running with
`screenShare = true` before you create the projection:

```kotlin
val projection = getSystemService(MediaProjectionManager::class.java)
launcher.launch(projection.createScreenCaptureIntent())      // ActivityResultLauncher
// in the result callback:
SwalvoCallService.start(context, SwalvoCallService.Config(microphone = true, screenShare = true))
room.enableScreenShare(result.data!!)
```

**Screen-share audio** (`ScreenShareOptions(captureAudio = true)`) uses
Android's AudioPlaybackCapture: Android 10 (API 29) and later only, it needs
`RECORD_AUDIO`, and it only hears apps that allow capture (media, games;
never calls). Below API 29 the option is ignored with a warning. libwebrtc
has a single recording path, so:

- microphone **off**: the shared audio is published as its own
  `TrackKind.SCREEN_SHARE_AUDIO` track (the microphone is still opened
  underneath, so the system's microphone indicator shows);
- microphone **on**: the shared audio is mixed into the microphone track.
  Muting the microphone mutes it too, and the platform's voice processing
  may still touch it.

Turning the microphone on or off during a share switches between the two.
The audio stops with the screen share, however that ends.

## Audio routing

```kotlin
val audio = AudioRouter(context)
audio.start()                         // communication mode + focus; Bluetooth > headset > speaker
audio.selectRoute(AudioRoute.EARPIECE)
audio.availableRoutes()               // [SPEAKER, EARPIECE, BLUETOOTH, …]
audio.stop()
```

## Telecom (ConnectionService)

`SwalvoConnectionService` and `SwalvoCallManager` register a self-managed
phone account so the system knows a call is in progress (Bluetooth / car
controls, other calls put on hold). Declare the service in your manifest
(the SDK already merges in `MANAGE_OWN_CALLS`); the class KDoc has the
snippet.

## End-to-end encryption

For rooms created with `e2ee: true`. Keys never reach the server.

```kotlin
val client = SwalvoClient(context, SwalvoClientOptions(e2ee = E2eeOptions(passphrase = "shared secret")))
```

or per-participant keys distributed by your app:

```kotlin
val client = SwalvoClient(context, SwalvoClientOptions(e2ee = E2eeOptions()))
room.e2ee!!.setKey(participantId, material32Bytes, keyIndex = 1)
```

The SDK refuses to publish into an E2EE room without E2EE configured, and
reports `RoomEvent.E2eeStateChanged(participant, DECRYPT_FAILED / MISSING_KEY / …)`.
The key schedule (PBKDF2 → HKDF with the `LivqenoRatchet` salt) and the frame
format match the web SDK byte for byte; `E2eeVectorsTest` checks it against
`docs/architecture/e2ee-vectors.json`.

## Building and testing

```bash
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties   # or set ANDROID_HOME
./gradlew :swalvo-rtc:assembleRelease :swalvo-rtc:testDebugUnitTest
```

JVM unit tests cover the wire protocol (JSON fixtures for every message),
the signaling state machine against a fake WebSocket (join, resume
true/false, 1012, 4001 + refresh, 4002, 4003, 4004, backoff, token refresh),
room event mapping against a fake media engine (including metadata and
data attribution), the data envelope vectors and the E2EE vectors.
Instrumented tests in `src/androidTest` need a device or emulator
(`./gradlew :swalvo-rtc:connectedDebugAndroidTest`).

## Layout

```
swalvo-rtc/src/main/kotlin/io/swalvo/rtc/
  SwalvoClient.kt, Room.kt, Participant.kt, Track.kt, RoomEvent.kt, Options.kt, Types.kt
  internal/protocol/   @Serializable client/server messages
  internal/signaling/  SignalingClient (reconnect, resume, refresh), OkHttp transport
  internal/engine/     RoomController (pure event mapping), PeerConnectionEngine (libwebrtc)
  internal/media/      PeerConnectionFactory, Camera2 / mic / MediaProjection capture, screen-audio mixer
  internal/data/       data messages v2 envelope codec
  e2ee/                key schedule + frame codec (pure Kotlin), FrameCryptor wiring
  audio/               AudioRouter
  call/                SwalvoCallService, SwalvoConnectionService
```
