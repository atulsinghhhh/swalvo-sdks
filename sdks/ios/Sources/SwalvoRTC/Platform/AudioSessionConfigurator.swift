#if os(iOS)
import AVFoundation
import Foundation
import LiveKitWebRTC

/// Configures `AVAudioSession` for calls, through WebRTC's `RTCAudioSession`
/// so WebRTC's audio unit and the app agree on the session's state.
///
/// Call `configureForCall()` before enabling the microphone. With CallKit,
/// let `CallKitManager` drive activation instead: CallKit owns activation
/// and hands it to you in `provider(_:didActivate:)`.
@MainActor
public enum AudioSessionConfigurator {
    public enum Mode: Sendable {
        /// Two-way call, earpiece by default (`.voiceChat`).
        case voiceChat
        /// Video call, speaker by default (`.videoChat`).
        case videoChat
        /// Listen-only (a live-stream viewer): plays through the speaker, no mic.
        case playback
    }

    /// Sets category, mode and options. `active: true` also activates.
    public static func configureForCall(mode: Mode = .videoChat, active: Bool = true) throws {
        let session = RTCAudioSession.sharedInstance()
        let config = RTCAudioSessionConfiguration.webRTC()
        switch mode {
        case .voiceChat:
            config.category = AVAudioSession.Category.playAndRecord.rawValue
            config.mode = AVAudioSession.Mode.voiceChat.rawValue
            config.categoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
        case .videoChat:
            config.category = AVAudioSession.Category.playAndRecord.rawValue
            config.mode = AVAudioSession.Mode.videoChat.rawValue
            config.categoryOptions = [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
        case .playback:
            config.category = AVAudioSession.Category.playback.rawValue
            config.mode = AVAudioSession.Mode.spokenAudio.rawValue
            config.categoryOptions = [.mixWithOthers]
        }
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        try session.setConfiguration(config, active: active)
    }

    /// Routes audio to the loudspeaker (`true`) or the default route.
    public static func setSpeakerOutput(_ speaker: Bool) throws {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        try session.overrideOutputAudioPort(speaker ? .speaker : .none)
    }

    /// For CallKit: WebRTC must not activate the session itself; CallKit
    /// does, and reports it through the provider delegate.
    public static func useManualAudio(_ manual: Bool) {
        let session = RTCAudioSession.sharedInstance()
        session.useManualAudio = manual
        session.isAudioEnabled = !manual
    }

    /// Call from `provider(_:didActivate:)`.
    public static func didActivate(_ audioSession: AVAudioSession) {
        let session = RTCAudioSession.sharedInstance()
        session.audioSessionDidActivate(audioSession)
        session.isAudioEnabled = true
    }

    /// Call from `provider(_:didDeactivate:)`.
    public static func didDeactivate(_ audioSession: AVAudioSession) {
        let session = RTCAudioSession.sharedInstance()
        session.audioSessionDidDeactivate(audioSession)
        session.isAudioEnabled = false
    }

    public static func deactivate() throws {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        try session.setActive(false)
    }
}
#endif
