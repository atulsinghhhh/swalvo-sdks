import Foundation
import LiveKitWebRTC

// Media-path E2EE (phase 5 §3): libwebrtc's frame cryptor, as shipped in
// LiveKit's WebRTC build, on every sender and receiver of an E2EE room.
//
// The native side is reached through three small protocols so the wiring
// (configuration, key mirroring, attach/release, state mapping) is tested
// with fakes; `LiveKitCryptorBackend` is the only code touching the
// Objective-C classes, and it needs a device or a live call to exercise.

/// How the native key provider is created. The values are the contract's
/// (phase 5 §3.1 as built), the same as the Flutter and Android SDKs.
struct E2EENativeKeyProviderOptions: Equatable, Sendable {
    /// utf8("LivqenoRatchet"): the HKDF salt for the AES key and each ratchet.
    var ratchetSalt: Data
    var ratchetWindowSize: Int
    /// Shared-passphrase mode (every participant uses the shared ring).
    var sharedKeyMode: Bool
    /// None: every frame in an E2EE room is encrypted.
    var uncryptedMagicBytes: Data?
    var failureTolerance: Int
    var keyRingSize: Int
    /// Never let a frame through in the clear while a cryptor has no key.
    var discardFrameWhenCryptorNotReady: Bool
    /// HKDF, so libwebrtc derives the AES key from material exactly as
    /// `E2EEKeyDerivation.aesKey` does (not libwebrtc's PBKDF2 default).
    var useHKDF: Bool

    static func swalvo(sharedKeyMode: Bool, ratchetWindow: Int, failureTolerance: Int, keyRingSize: Int) -> Self {
        E2EENativeKeyProviderOptions(ratchetSalt: Data(E2EEKeyDerivation.ratchetSalt.utf8), ratchetWindowSize: ratchetWindow,
                                     sharedKeyMode: sharedKeyMode, uncryptedMagicBytes: nil,
                                     failureTolerance: failureTolerance, keyRingSize: keyRingSize,
                                     discardFrameWhenCryptorNotReady: true, useHKDF: true)
    }
}

/// libwebrtc's `RTCFrameCryptorState`, platform-neutral.
enum E2EECryptorState: Sendable {
    case new, ok, encryptionFailed, decryptionFailed, missingKey, keyRatcheted, internalError

    /// The public state; nil for `new`. A ratchet the receiver followed is
    /// a successful decrypt.
    func publicState(local: Bool) -> E2EEState? {
        switch self {
        case .new: return nil
        case .ok, .keyRatcheted: return .ok
        case .encryptionFailed: return .encryptFailed
        case .decryptionFailed: return .decryptFailed
        case .missingKey: return .missingKey
        case .internalError: return local ? .encryptFailed : .decryptFailed
        }
    }
}

/// libwebrtc's frame-cryptor key provider. Thread-safe natively.
protocol E2EENativeKeyProvider: AnyObject, Sendable {
    func setSharedKey(_ material: Data, index: Int)
    func setKey(_ material: Data, index: Int, participantId: String)
    @discardableResult func ratchetSharedKey(index: Int) -> Data?
    @discardableResult func ratchetKey(participantId: String, index: Int) -> Data?
}

/// One frame cryptor on one sender or receiver.
@MainActor
protocol E2EENativeCryptor: AnyObject {
    var isEnabled: Bool { get set }
    var keyIndex: Int { get set }
}

/// Creates the native objects. `sender`/`receiver` are the engine's
/// `RTCRtpSender`/`RTCRtpReceiver`, typed loosely so fakes need no WebRTC.
@MainActor
protocol E2EECryptorBackend: AnyObject {
    func makeKeyProvider(_ options: E2EENativeKeyProviderOptions) -> E2EENativeKeyProvider
    func makeCryptor(sender: AnyObject, participantId: String, keyProvider: E2EENativeKeyProvider,
                     onState: @escaping @Sendable (String, E2EECryptorState) -> Void) -> E2EENativeCryptor?
    func makeCryptor(receiver: AnyObject, participantId: String, keyProvider: E2EENativeKeyProvider,
                     onState: @escaping @Sendable (String, E2EECryptorState) -> Void) -> E2EENativeCryptor?
}

/// Applies `E2EEKeyChange`s to the native provider. Not actor-bound: the
/// change is applied on the caller's thread, in order, as it happens.
final class E2EENativeKeyMirror: Sendable {
    let native: E2EENativeKeyProvider

    init(native: E2EENativeKeyProvider) {
        self.native = native
    }

    func load(_ snapshot: E2EEKeySnapshot) {
        for key in snapshot.shared { native.setSharedKey(key.material, index: Int(key.index)) }
        for key in snapshot.participants {
            native.setKey(key.material, index: Int(key.index), participantId: key.participantId)
        }
    }

    func apply(_ change: E2EEKeyChange) {
        switch change {
        case let .sharedKey(material, index):
            native.setSharedKey(material, index: Int(index))
        case let .participantKey(participantId, material, index):
            native.setKey(material, index: Int(index), participantId: participantId)
        case let .ratcheted(participantId, index):
            if let participantId {
                native.ratchetKey(participantId: participantId, index: Int(index))
            } else {
                native.ratchetSharedKey(index: Int(index))
            }
        }
    }
}

/// Frame encryption for one room: the native key provider, kept in step
/// with the room's `E2EEKeyProvider`, and a cryptor per sender and
/// receiver. Created only when the room is E2EE and keys are configured.
@MainActor
final class E2EEFrameEncryption {
    let keys: E2EEKeyProvider
    let options: E2EENativeKeyProviderOptions
    var localIdentity: String
    /// (participantId, local, state), deduplicated by the room.
    var onState: ((String, Bool, E2EEState) -> Void)?

    private let backend: E2EECryptorBackend
    private let mirror: E2EENativeKeyMirror
    private var observation: UUID?
    private var senderCryptors: [ObjectIdentifier: E2EENativeCryptor] = [:]
    private var receiverCryptors: [ObjectIdentifier: (participantId: String, cryptor: E2EENativeCryptor)] = [:]
    private let logger: RTCLogger

    init(keys: E2EEKeyProvider, backend: E2EECryptorBackend, localIdentity: String, logger: RTCLogger) {
        self.keys = keys
        self.backend = backend
        self.localIdentity = localIdentity
        self.logger = logger
        let mirrorBox = MirrorBox()
        let (token, snapshot) = keys.observe { change in mirrorBox.apply(change) }
        let shared = keys.sharedKeyMode ?? snapshot.participants.isEmpty
        options = .swalvo(sharedKeyMode: shared, ratchetWindow: keys.ratchetWindow,
                           failureTolerance: keys.failureTolerance, keyRingSize: keys.keyRingSize)
        mirror = E2EENativeKeyMirror(native: backend.makeKeyProvider(options))
        // Changes made between observe() and here queue in the box and are
        // applied after the snapshot, so order is preserved.
        mirror.load(snapshot)
        observation = token
        mirrorBox.attach(mirror) { [weak self] in
            Task { @MainActor in self?.syncSenderKeyIndex() }
        }
        if keys.sharedKeyMode == nil, shared {
            logger.debug("e2ee: shared-key mode (no participant keys were set before encryption started)")
        }
    }

    var cryptorCount: Int { senderCryptors.count + receiverCryptors.count }

    /// The key index the local participant encrypts with.
    var senderKeyIndex: Int { Int(keys.currentKey(participantId: localIdentity)?.index ?? 0) }

    /// Encrypts everything `sender` sends, from its first frame.
    func attachSender(_ sender: AnyObject) -> E2EENativeCryptor? {
        let id = ObjectIdentifier(sender)
        if let existing = senderCryptors[id] { return existing }
        guard let cryptor = backend.makeCryptor(sender: sender, participantId: localIdentity, keyProvider: mirror.native,
                                                onState: stateHandler(local: true)) else {
            logger.error("e2ee: could not create a frame cryptor for a sender")
            return nil
        }
        cryptor.keyIndex = senderKeyIndex
        cryptor.isEnabled = true
        senderCryptors[id] = cryptor
        return cryptor
    }

    /// Decrypts what `receiver` receives from `participantId`.
    func attachReceiver(_ receiver: AnyObject, participantId: String) -> E2EENativeCryptor? {
        let id = ObjectIdentifier(receiver)
        if let existing = receiverCryptors[id] { return existing.cryptor }
        guard let cryptor = backend.makeCryptor(receiver: receiver, participantId: participantId, keyProvider: mirror.native,
                                                onState: stateHandler(local: false)) else {
            logger.error("e2ee: could not create a frame cryptor for \(participantId)")
            return nil
        }
        cryptor.isEnabled = true
        receiverCryptors[id] = (participantId, cryptor)
        return cryptor
    }

    func hasCryptor(for object: AnyObject) -> Bool {
        let id = ObjectIdentifier(object)
        return senderCryptors[id] != nil || receiverCryptors[id] != nil
    }

    /// The sender or receiver is gone; its cryptor goes with it.
    func release(_ object: AnyObject) {
        let id = ObjectIdentifier(object)
        senderCryptors.removeValue(forKey: id)?.isEnabled = false
        receiverCryptors.removeValue(forKey: id)?.cryptor.isEnabled = false
    }

    /// The PeerConnection was replaced: every cryptor belonged to it.
    func resetConnection() {
        senderCryptors.values.forEach { $0.isEnabled = false }
        receiverCryptors.values.forEach { $0.cryptor.isEnabled = false }
        senderCryptors = [:]
        receiverCryptors = [:]
    }

    func dispose() {
        resetConnection()
        if let observation { keys.removeObserver(observation) }
        observation = nil
    }

    /// A new current key for us (or the shared ring): senders follow it.
    func syncSenderKeyIndex() {
        let index = senderKeyIndex
        for cryptor in senderCryptors.values where cryptor.keyIndex != index {
            cryptor.keyIndex = index
        }
    }

    private func stateHandler(local: Bool) -> @Sendable (String, E2EECryptorState) -> Void {
        { [weak self] participantId, state in
            guard let mapped = state.publicState(local: local) else { return }
            Task { @MainActor in self?.onState?(participantId, local, mapped) }
        }
    }
}

/// Holds key changes that race the native provider's creation, then
/// forwards them. Thread-safe.
private final class MirrorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var mirror: E2EENativeKeyMirror?
    private var queued: [E2EEKeyChange] = []
    private var onKeyChange: (@Sendable () -> Void)?

    func attach(_ mirror: E2EENativeKeyMirror, onKeyChange: @escaping @Sendable () -> Void) {
        lock.lock()
        self.mirror = mirror
        self.onKeyChange = onKeyChange
        let queued = self.queued
        self.queued = []
        for change in queued { mirror.apply(change) }
        lock.unlock()
    }

    func apply(_ change: E2EEKeyChange) {
        lock.lock()
        if let mirror {
            mirror.apply(change)
        } else {
            queued.append(change)
        }
        let notify = onKeyChange
        lock.unlock()
        // Shared keys and our own keys move the sender index; a ratchet keeps it.
        switch change {
        case .sharedKey, .participantKey: notify?()
        case .ratcheted: break
        }
    }
}

// MARK: - LiveKit's libwebrtc

/// The production backend: `LKRTCFrameCryptorKeyProvider` and
/// `LKRTCFrameCryptor` (AES-GCM) from LiveKit's WebRTC build.
@MainActor
final class LiveKitCryptorBackend: E2EECryptorBackend {
    private let factory: RTCPeerConnectionFactory

    init(factory: RTCPeerConnectionFactory) {
        self.factory = factory
    }

    func makeKeyProvider(_ options: E2EENativeKeyProviderOptions) -> E2EENativeKeyProvider {
        let native = RTCFrameCryptorKeyProvider(
            ratchetSalt: options.ratchetSalt,
            ratchetWindowSize: Int32(options.ratchetWindowSize),
            sharedKeyMode: options.sharedKeyMode,
            uncryptedMagicBytes: options.uncryptedMagicBytes,
            failureTolerance: Int32(options.failureTolerance),
            keyRingSize: Int32(options.keyRingSize),
            discardFrameWhenCryptorNotReady: options.discardFrameWhenCryptorNotReady,
            keyDerivationAlgorithm: options.useHKDF ? .HKDF : .PBKDF2)
        return LiveKitKeyProvider(native)
    }

    func makeCryptor(sender: AnyObject, participantId: String, keyProvider: E2EENativeKeyProvider,
                     onState: @escaping @Sendable (String, E2EECryptorState) -> Void) -> E2EENativeCryptor? {
        guard let sender = sender as? RTCRtpSender, let provider = keyProvider as? LiveKitKeyProvider,
              let cryptor = RTCFrameCryptor(factory: factory, rtpSender: sender, participantId: participantId,
                                            algorithm: .aesGcm, keyProvider: provider.native) else { return nil }
        return LiveKitCryptor(cryptor, onState: onState)
    }

    func makeCryptor(receiver: AnyObject, participantId: String, keyProvider: E2EENativeKeyProvider,
                     onState: @escaping @Sendable (String, E2EECryptorState) -> Void) -> E2EENativeCryptor? {
        guard let receiver = receiver as? RTCRtpReceiver, let provider = keyProvider as? LiveKitKeyProvider,
              let cryptor = RTCFrameCryptor(factory: factory, rtpReceiver: receiver, participantId: participantId,
                                            algorithm: .aesGcm, keyProvider: provider.native) else { return nil }
        return LiveKitCryptor(cryptor, onState: onState)
    }
}

private final class LiveKitKeyProvider: E2EENativeKeyProvider, @unchecked Sendable {
    let native: RTCFrameCryptorKeyProvider

    init(_ native: RTCFrameCryptorKeyProvider) {
        self.native = native
    }

    func setSharedKey(_ material: Data, index: Int) { native.setSharedKey(material, with: Int32(index)) }
    func setKey(_ material: Data, index: Int, participantId: String) {
        native.setKey(material, with: Int32(index), forParticipant: participantId)
    }
    func ratchetSharedKey(index: Int) -> Data? { native.ratchetSharedKey(Int32(index)) }
    func ratchetKey(participantId: String, index: Int) -> Data? { native.ratchetKey(participantId, with: Int32(index)) }
}

/// Owns a frame cryptor and is its delegate (the delegate is weak natively).
@MainActor
private final class LiveKitCryptor: NSObject, E2EENativeCryptor, RTCFrameCryptorDelegate {
    private let cryptor: RTCFrameCryptor
    private let onState: @Sendable (String, E2EECryptorState) -> Void

    init(_ cryptor: RTCFrameCryptor, onState: @escaping @Sendable (String, E2EECryptorState) -> Void) {
        self.cryptor = cryptor
        self.onState = onState
        super.init()
        cryptor.delegate = self
    }

    var isEnabled: Bool {
        get { cryptor.enabled }
        set { cryptor.enabled = newValue }
    }

    var keyIndex: Int {
        get { Int(cryptor.keyIndex) }
        set { cryptor.keyIndex = Int32(newValue) }
    }

    /// Called on a WebRTC thread.
    nonisolated func frameCryptor(_ frameCryptor: RTCFrameCryptor, didStateChangeWithParticipantId participantId: String,
                                  with stateChanged: RTCFrameCryptorState) {
        onState(participantId, Self.map(stateChanged))
    }

    nonisolated static func map(_ state: RTCFrameCryptorState) -> E2EECryptorState {
        switch state {
        case .new: return .new
        case .ok: return .ok
        case .encryptionFailed: return .encryptionFailed
        case .decryptionFailed: return .decryptionFailed
        case .missingKey: return .missingKey
        case .keyRatcheted: return .keyRatcheted
        case .internalError: return .internalError
        @unknown default: return .internalError
        }
    }
}
