// SampleHandler.swift — Swalvo screen share from a Broadcast Upload Extension.
//
// Copy into a new "Broadcast Upload Extension" target in Xcode (File > New >
// Target), add the SwalvoRTC package to that target, and put the app and
// the extension in the same App Group. See README.md next to this file.
//
// How it works: the extension joins the room as its own participant (for
// example identity "alice#screen") and publishes one `screenShare` track fed
// by ReplayKit's sample buffers, plus (with `shareAppAudio`) one
// `screenShareAudio` track fed by ReplayKit's `.audioApp` buffers. The app hands it a token through the App
// Group, because an extension cannot call your app's code. Mint that token
// with publish-only rights (subscribe: false): the extension then never
// receives media, which keeps it inside the 50 MB extension memory limit.

import CoreMedia
import SwalvoRTC
import ReplayKit

/// Keys the app writes into the shared App Group `UserDefaults` before the
/// user starts the broadcast. Keep these in sync with `ScreenShareHandoff`
/// in the README.
enum ScreenShareHandoff {
    /// TODO: your App Group identifier.
    static let appGroup = "group.com.example.yourapp"
    // legacy: App Group defaults keys kept so apps built from the earlier template keep working.
    static let tokenKey = "livqeno.screenShare.token"
    static let endpointKey = "livqeno.screenShare.endpoint"
    /// JSON array of `{ urls, username?, credential? }`, from the mint response.
    static let iceServersKey = "livqeno.screenShare.iceServers"
    /// Publish the device's app audio as `screenShareAudio` (phase 7 §3).
    /// The extension's token then needs `publishAudio` as well.
    static let shareAppAudio = true
}

final class SampleHandler: RPBroadcastSampleHandler {
    private var room: Room?
    private var capturer: BufferVideoCapturer?
    private var audioCapturer: BroadcastAudioCapturer?

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        let defaults = UserDefaults(suiteName: ScreenShareHandoff.appGroup)
        guard let token = defaults?.string(forKey: ScreenShareHandoff.tokenKey),
              let endpoint = defaults?.string(forKey: ScreenShareHandoff.endpointKey)
        else {
            finish("Open the app and start screen sharing from there first.")
            return
        }
        var options = RoomOptions()
        if let data = defaults?.data(forKey: ScreenShareHandoff.iceServersKey),
           let servers = try? JSONDecoder().decode([ICEServer].self, from: data) {
            options.iceServers = servers
        }
        // The extension only sends. Nothing to subscribe to or adapt.
        options.autoSubscribe = false
        options.adaptiveStream = false

        Task { @MainActor in
            do {
                // Before connecting: the audio track swaps this process's
                // WebRTC audio device for one fed by `.audioApp` buffers.
                let audio = ScreenShareHandoff.shareAppAudio ? try LocalMedia.createBroadcastAudioTrack() : nil
                let room = Room(options: options)
                try await room.connect(token: token, endpoint: endpoint)
                let (track, capturer) = LocalMedia.createBufferTrack(source: .screenShare)
                try await room.publish(track)
                if let (audioTrack, audioCapturer) = audio {
                    try await room.publish(audioTrack)
                    self.audioCapturer = audioCapturer
                }
                self.room = room
                self.capturer = capturer
                // End the broadcast if the room ends (removed, closed, failed).
                Task { @MainActor in
                    for await event in room.events() {
                        if case let .disconnected(reason) = event, reason != .clientInitiated {
                            self.finish("Screen sharing ended (\(reason.rawValue)).")
                        }
                    }
                }
            } catch {
                self.finish("Could not start screen sharing: \(error)")
            }
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        if sampleBufferType == .audioApp {
            audioCapturer?.capture(sampleBuffer: sampleBuffer)
            return
        }
        guard sampleBufferType == .video, let capturer else { return }
        let orientation = (CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString,
                                           attachmentModeOut: nil) as? NSNumber)?.uint32Value ?? 1
        capturer.capture(sampleBuffer: sampleBuffer,
                         rotation: BufferVideoCapturer.rotation(forReplayKitOrientation: orientation))
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        let room = self.room
        Task { @MainActor in await room?.leave() }
    }

    private func finish(_ message: String) {
        let error = NSError(domain: "SwalvoScreenShare", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        finishBroadcastWithError(error)
    }
}
