# Broadcast Upload Extension template (whole-device screen share)

`room.enableScreenShare()` shares **your app only**, and only while it is in
the foreground (ReplayKit in-app capture). To share the whole screen — other
apps, the home screen — iOS requires a **Broadcast Upload Extension**: a
separate process that ReplayKit feeds with frames after the user picks your
app in the system broadcast picker.

## Setup

1. **Add the target.** Xcode → File → New → Target → *Broadcast Upload
   Extension*. Untick "Include UI Extension" unless you want a setup UI.
2. **Add the package** to the new target (target → General → Frameworks and
   Libraries → `+` → SwalvoRTC).
3. **Replace** the generated `SampleHandler.swift` with the one in this folder.
4. **App Group.** Add the same App Group capability (for example
   `group.com.example.yourapp`) to the app *and* the extension, and set
   `ScreenShareHandoff.appGroup` in `SampleHandler.swift`.
5. **Hand off a token from the app** before showing the picker. Ask your
   backend for a second RTC token for the same room, with its own identity
   (for example `alice#screen`) and **publish-only** rights
   (`subscribe: false`) so the extension never downloads media:

   ```swift
   let defaults = UserDefaults(suiteName: "group.com.example.yourapp")!
   defaults.set(grant.token, forKey: "livqeno.screenShare.token")
   defaults.set(grant.endpoint, forKey: "livqeno.screenShare.endpoint")
   defaults.set(try JSONEncoder().encode(grant.iceServers), forKey: "livqeno.screenShare.iceServers")
   ```

6. **Show the picker** from the app:

   ```swift
   import ReplayKit
   let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 60, height: 60))
   picker.preferredExtension = "com.example.yourapp.ScreenShare" // the extension's bundle id
   picker.showsMicrophoneButton = false
   view.addSubview(picker)
   ```

The rest of the room sees a participant `alice#screen` publishing a
`screenShare` track (and, with app audio on, a `screenShareAudio` track) — `trackSubscribed` with `track.kind == .screenShare`.
Pair the two identities in your UI by the prefix you chose.

## Limits

- **Memory: 50 MB.** iOS kills a broadcast extension above it. A publish-only
  token, no subscriptions and a single non-simulcast layer (screen shares are
  never simulcast) keep SwalvoRTC well inside it; avoid adding other heavy
  dependencies to the extension.
- **No camera, no `AVAudioSession` work** in the extension.
- **App audio (`screenShareAudio`).** With `ScreenShareHandoff.shareAppAudio`
  on (the default; change it to `false` in the template to share video
  only), the template publishes ReplayKit's `.audioApp` buffers as a second
  track, source `screenShareAudio` (mixed to mono, 48 kHz). The extension's
  token needs `publishAudio`. `LocalMedia.createBroadcastAudioTrack()`
  replaces the extension process's WebRTC audio device, so call it before
  `room.connect` and never in your app. `.audioMic` buffers are ignored;
  the app's own microphone track carries the user's voice. Receivers get an
  ordinary audio track (`track.kind == .screenShareAudio`), which the SFU
  never counts as an active speaker. Not verifiable with `swift test`;
  check it on a device.
- **Testing needs a device and Xcode.** The simulator has no broadcast picker
  that captures the screen. `swift test` on macOS does not exercise this
  template.
