#if os(iOS) && canImport(CallKit)
import AVFoundation
import CallKit
import Foundation

/// A thin `CXProvider` wrapper that ties a system call to a Swalvo room.
///
/// CallKit gives you the native incoming-call screen, lock-screen controls,
/// audio-session activation and interruption handling (a cellular call
/// arriving mid-call). Swalvo itself knows nothing about calls ringing —
/// your backend/VoIP push decides that — so this helper only does the
/// CallKit half:
///
/// ```swift
/// let callKit = CallKitManager(configuration: .init(localizedName: "Acme"))
/// callKit.onAnswer = { uuid in try await room.connect(token: t, endpoint: e) }
/// callKit.onEnd = { _ in await room.leave() }
/// callKit.onMute = { _, muted in await room.localParticipant.tracks.first { $0.source == .microphone }?.setMuted(muted) }
/// callKit.reportIncomingCall(uuid: UUID(), handle: "Alice", hasVideo: true)
/// ```
///
/// Incoming VoIP pushes (PushKit) must report a call to CallKit
/// immediately, or iOS terminates the app; wire `reportIncomingCall` into
/// your `PKPushRegistryDelegate`.
@MainActor
public final class CallKitManager: NSObject {
    public struct Configuration {
        public var localizedName: String
        public var supportsVideo = true
        public var maximumCallGroups = 1
        public var maximumCallsPerCallGroup = 1
        public var iconTemplateImageData: Data?
        public var ringtoneSound: String?
        public var includesCallsInRecents = true

        public init(localizedName: String) {
            self.localizedName = localizedName
        }
    }

    public let provider: CXProvider
    public let callController = CXCallController()

    /// The user answered (system UI). Connect the room here.
    public var onAnswer: ((UUID) async throws -> Void)?
    /// The call is starting (outgoing). Connect the room here.
    public var onStart: ((UUID) async throws -> Void)?
    /// The call ended (either side). Leave the room here.
    public var onEnd: ((UUID) async -> Void)?
    /// The user toggled mute in the system UI.
    public var onMute: ((UUID, Bool) async -> Void)?
    /// The user put the call on hold, or a cellular call took over.
    public var onHold: ((UUID, Bool) async -> Void)?

    public init(configuration: Configuration) {
        let config = CXProviderConfiguration()
        config.supportsVideo = configuration.supportsVideo
        config.maximumCallGroups = configuration.maximumCallGroups
        config.maximumCallsPerCallGroup = configuration.maximumCallsPerCallGroup
        config.supportedHandleTypes = [.generic]
        config.iconTemplateImageData = configuration.iconTemplateImageData
        config.ringtoneSound = configuration.ringtoneSound
        config.includesCallsInRecents = configuration.includesCallsInRecents
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
        // CallKit activates the audio session; WebRTC must wait for it.
        AudioSessionConfigurator.useManualAudio(true)
    }

    /// Shows the system incoming-call UI.
    public func reportIncomingCall(uuid: UUID, handle: String, hasVideo: Bool) async throws {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: handle)
        update.hasVideo = hasVideo
        update.localizedCallerName = handle
        try await provider.reportNewIncomingCall(with: uuid, update: update)
    }

    /// Starts an outgoing call through CallKit (it then calls `onStart`).
    public func startCall(uuid: UUID, handle: String, hasVideo: Bool) async throws {
        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: handle))
        action.isVideo = hasVideo
        try await callController.request(CXTransaction(action: action))
    }

    public func endCall(uuid: UUID) async throws {
        try await callController.request(CXTransaction(action: CXEndCallAction(call: uuid)))
    }

    public func setMuted(uuid: UUID, muted: Bool) async throws {
        try await callController.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted)))
    }

    /// Tells CallKit the outgoing call connected (updates the system UI timer).
    public func reportConnected(uuid: UUID) {
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    /// Tells CallKit the call ended for a reason other than the user (the
    /// room disconnected: removed, room closed, failure).
    public func reportEnded(uuid: UUID, reason: DisconnectReason) {
        let mapped: CXCallEndedReason
        switch reason {
        case .clientInitiated, .removed, .roomClosed: mapped = .remoteEnded
        case .replaced: mapped = .answeredElsewhere
        case .tokenExpired, .tokenRevoked, .connectionFailed: mapped = .failed
        }
        provider.reportCall(with: uuid, endedAt: Date(), reason: mapped)
    }
}

extension CallKitManager: CXProviderDelegate {
    nonisolated public func providerDidReset(_ provider: CXProvider) {}

    nonisolated public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor in
            do {
                try AudioSessionConfigurator.configureForCall(mode: .videoChat, active: false)
                try await self.onAnswer?(action.callUUID)
                action.fulfill()
            } catch {
                action.fail()
            }
        }
    }

    nonisolated public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor in
            do {
                try AudioSessionConfigurator.configureForCall(mode: .videoChat, active: false)
                self.provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
                try await self.onStart?(action.callUUID)
                action.fulfill()
            } catch {
                action.fail()
            }
        }
    }

    nonisolated public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            await self.onEnd?(action.callUUID)
            action.fulfill()
        }
    }

    nonisolated public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in
            await self.onMute?(action.callUUID, action.isMuted)
            action.fulfill()
        }
    }

    nonisolated public func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        Task { @MainActor in
            await self.onHold?(action.callUUID, action.isOnHold)
            action.fulfill()
        }
    }

    nonisolated public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in AudioSessionConfigurator.didActivate(audioSession) }
    }

    nonisolated public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor in AudioSessionConfigurator.didDeactivate(audioSession) }
    }
}
#endif
