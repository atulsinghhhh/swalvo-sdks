import Foundation
import LiveKitWebRTC
import Testing
@testable import SwalvoRTC

// MARK: - Fakes for the native frame-cryptor layer

final class FakeNativeKeyProvider: E2EENativeKeyProvider, @unchecked Sendable {
    enum Call: Equatable {
        case setShared(Data, Int)
        case setKey(Data, Int, String)
        case ratchetShared(Int)
        case ratchetKey(String, Int)
    }
    private let lock = NSLock()
    private var _calls: [Call] = []
    var calls: [Call] {
        lock.lock(); defer { lock.unlock() }
        return _calls
    }
    private func record(_ call: Call) { lock.lock(); _calls.append(call); lock.unlock() }

    func setSharedKey(_ material: Data, index: Int) { record(.setShared(material, index)) }
    func setKey(_ material: Data, index: Int, participantId: String) { record(.setKey(material, index, participantId)) }
    func ratchetSharedKey(index: Int) -> Data? { record(.ratchetShared(index)); return nil }
    func ratchetKey(participantId: String, index: Int) -> Data? { record(.ratchetKey(participantId, index)); return nil }
}

@MainActor
final class FakeCryptor: E2EENativeCryptor {
    let participantId: String
    let isSender: Bool
    let target: AnyObject
    var isEnabled = false
    var keyIndex = 0
    let onState: @Sendable (String, E2EECryptorState) -> Void

    init(participantId: String, isSender: Bool, target: AnyObject, onState: @escaping @Sendable (String, E2EECryptorState) -> Void) {
        self.participantId = participantId
        self.isSender = isSender
        self.target = target
        self.onState = onState
    }

    /// What libwebrtc's delegate callback would do.
    func fire(_ state: E2EECryptorState) { onState(participantId, state) }
}

@MainActor
final class FakeCryptorBackend: E2EECryptorBackend {
    var providerOptions: [E2EENativeKeyProviderOptions] = []
    var keyProvider = FakeNativeKeyProvider()
    var cryptors: [FakeCryptor] = []

    func makeKeyProvider(_ options: E2EENativeKeyProviderOptions) -> E2EENativeKeyProvider {
        providerOptions.append(options)
        return keyProvider
    }

    func makeCryptor(sender: AnyObject, participantId: String, keyProvider: E2EENativeKeyProvider,
                     onState: @escaping @Sendable (String, E2EECryptorState) -> Void) -> E2EENativeCryptor? {
        #expect(keyProvider === self.keyProvider)
        let cryptor = FakeCryptor(participantId: participantId, isSender: true, target: sender, onState: onState)
        cryptors.append(cryptor)
        return cryptor
    }

    func makeCryptor(receiver: AnyObject, participantId: String, keyProvider: E2EENativeKeyProvider,
                     onState: @escaping @Sendable (String, E2EECryptorState) -> Void) -> E2EENativeCryptor? {
        #expect(keyProvider === self.keyProvider)
        let cryptor = FakeCryptor(participantId: participantId, isSender: false, target: receiver, onState: onState)
        cryptors.append(cryptor)
        return cryptor
    }

    var senderCryptors: [FakeCryptor] { cryptors.filter(\.isSender) }
    var receiverCryptors: [FakeCryptor] { cryptors.filter { !$0.isSender } }
}

// MARK: - Key provider configuration and key mirroring

@MainActor
@Suite(.serialized) final class E2EEFrameEncryptionTests {
    private let material = Data((0..<32).map { UInt8($0) })
    private let other = Data((0..<32).map { UInt8(255 - $0) })

    @Test func testNativeOptionsMatchTheContract() {
        let options = E2EENativeKeyProviderOptions.swalvo(sharedKeyMode: true, ratchetWindow: 8, failureTolerance: -1, keyRingSize: 16)
        #expect(options.ratchetSalt == Data("LivqenoRatchet".utf8))
        #expect(options.ratchetWindowSize == 8)
        #expect(options.sharedKeyMode)
        #expect(options.uncryptedMagicBytes == nil, "every frame in an E2EE room is encrypted")
        #expect(options.failureTolerance == -1)
        #expect(options.keyRingSize == 16)
        #expect(options.discardFrameWhenCryptorNotReady, "plaintext never leaves a sender without a key")
        #expect(options.useHKDF, "libwebrtc must derive keys as E2EEKeyDerivation does")
    }

    @Test func testProviderDefaultsFeedTheNativeOptions() {
        let backend = FakeCryptorBackend()
        let keys = E2EEKeyProvider()
        let encryption = E2EEFrameEncryption(keys: keys, backend: backend, localIdentity: "alice", logger: RTCLogger())
        #expect(backend.providerOptions == [.swalvo(sharedKeyMode: true, ratchetWindow: 8, failureTolerance: -1, keyRingSize: 16)])
        encryption.dispose()

        let custom = E2EEKeyProvider(ratchetWindow: 4, sharedKeyMode: false, failureTolerance: 10, keyRingSize: 32)
        let backend2 = FakeCryptorBackend()
        E2EEFrameEncryption(keys: custom, backend: backend2, localIdentity: "alice", logger: RTCLogger()).dispose()
        #expect(backend2.providerOptions == [.swalvo(sharedKeyMode: false, ratchetWindow: 4, failureTolerance: 10, keyRingSize: 32)])
    }

    @Test func testKeyModeIsInferredFromTheKeysPresentAtStart() {
        let keys = E2EEKeyProvider()
        keys.setKey(participantId: "bob", key: material)
        let backend = FakeCryptorBackend()
        E2EEFrameEncryption(keys: keys, backend: backend, localIdentity: "alice", logger: RTCLogger()).dispose()
        #expect(backend.providerOptions.first?.sharedKeyMode == false, "a participant key means per-participant mode")

        let passphrase = E2EEKeyProvider()
        passphrase.setSharedPassphrase("pw", roomId: "room_1")
        let backend2 = FakeCryptorBackend()
        E2EEFrameEncryption(keys: passphrase, backend: backend2, localIdentity: "alice", logger: RTCLogger()).dispose()
        #expect(backend2.providerOptions.first?.sharedKeyMode == true)
    }

    @Test func testPassphraseMaterialIsHandedToTheNativeProvider() {
        let keys = E2EEKeyProvider()
        keys.setSharedPassphrase("correct horse battery staple", roomId: "room_rid")
        let backend = FakeCryptorBackend()
        let encryption = E2EEFrameEncryption(keys: keys, backend: backend, localIdentity: "alice", logger: RTCLogger())
        let expected = E2EEKeyDerivation.material(passphrase: "correct horse battery staple", roomId: "room_rid")
        #expect(backend.keyProvider.calls == [.setShared(expected, 0)], "PBKDF2 material, not the AES key: libwebrtc runs the HKDF")
        encryption.dispose()
    }

    @Test func testLaterKeyChangesAreMirroredInOrder() {
        let keys = E2EEKeyProvider(sharedKeyMode: false)
        keys.setKey(participantId: "alice", key: other, keyIndex: 1)
        keys.setKey(participantId: "alice", key: material, keyIndex: 0)
        let backend = FakeCryptorBackend()
        let encryption = E2EEFrameEncryption(keys: keys, backend: backend, localIdentity: "alice", logger: RTCLogger())
        #expect(backend.keyProvider.calls == [.setKey(other, 1, "alice"), .setKey(material, 0, "alice")],
                "snapshot: the current index is set last")

        keys.setKey(participantId: "bob", key: other, keyIndex: 2)
        keys.ratchetKey(participantId: "bob")
        keys.setSharedKey(material, keyIndex: 3)
        keys.ratchetKey()
        #expect(Array(backend.keyProvider.calls.dropFirst(2)) == [
            .setKey(other, 2, "bob"), .ratchetKey("bob", 2), .setShared(material, 3), .ratchetShared(3),
        ])

        encryption.dispose()
        keys.setSharedKey(other, keyIndex: 4)
        #expect(backend.keyProvider.calls.count == 6, "a disposed controller stops mirroring")
    }

    // MARK: Cryptors

    @Test func testSenderAndReceiverCryptorsAreAESGCMEnabledAndKeyed() async {
        let keys = E2EEKeyProvider()
        keys.setSharedKey(material, keyIndex: 2)
        let backend = FakeCryptorBackend()
        let encryption = E2EEFrameEncryption(keys: keys, backend: backend, localIdentity: "alice", logger: RTCLogger())
        let sender = NSObject(), receiver = NSObject()
        _ = encryption.attachSender(sender)
        _ = encryption.attachSender(sender)
        _ = encryption.attachReceiver(receiver, participantId: "bob")
        #expect(backend.cryptors.count == 2, "one cryptor per sender/receiver")
        let senderCryptor = backend.senderCryptors[0], receiverCryptor = backend.receiverCryptors[0]
        #expect(senderCryptor.participantId == "alice" && senderCryptor.isEnabled && senderCryptor.keyIndex == 2)
        #expect(receiverCryptor.participantId == "bob" && receiverCryptor.isEnabled)

        // A new current key moves the senders to its index.
        keys.setSharedKey(other, keyIndex: 5)
        await waitUntil { @MainActor in senderCryptor.keyIndex == 5 }

        encryption.release(receiver)
        #expect(!receiverCryptor.isEnabled && encryption.cryptorCount == 1)
        encryption.resetConnection()
        #expect(!senderCryptor.isEnabled && encryption.cryptorCount == 0)
        encryption.dispose()
    }

    @Test func testCryptorStatesMapToPublicStates() {
        #expect(E2EECryptorState.new.publicState(local: true) == nil)
        #expect(E2EECryptorState.ok.publicState(local: false) == .ok)
        #expect(E2EECryptorState.keyRatcheted.publicState(local: false) == .ok)
        #expect(E2EECryptorState.missingKey.publicState(local: true) == .missingKey)
        #expect(E2EECryptorState.encryptionFailed.publicState(local: true) == .encryptFailed)
        #expect(E2EECryptorState.decryptionFailed.publicState(local: false) == .decryptFailed)
        #expect(E2EECryptorState.internalError.publicState(local: true) == .encryptFailed)
        #expect(E2EECryptorState.internalError.publicState(local: false) == .decryptFailed)
    }

    // MARK: Native (LiveKit libwebrtc) — runs headless: no media involved

    /// libwebrtc's key provider, configured as the SDK configures it, ratchets
    /// exactly as docs/architecture/e2ee-vectors.json says.
    @Test func testLiveKitKeyProviderRatchetsLikeTheVectors() throws {
        struct Vectors: Decodable {
            struct Step: Decodable { let material: String }
            struct Ratchet: Decodable { let from: String; let steps: [Step] }
            let ratchet: Ratchet
        }
        let url = try #require(Bundle.module.url(forResource: "e2ee-vectors", withExtension: "json", subdirectory: "Fixtures"))
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        let options = E2EENativeKeyProviderOptions.swalvo(sharedKeyMode: true, ratchetWindow: 8, failureTolerance: -1, keyRingSize: 16)
        let native = RTCFrameCryptorKeyProvider(
            ratchetSalt: options.ratchetSalt, ratchetWindowSize: Int32(options.ratchetWindowSize),
            sharedKeyMode: options.sharedKeyMode, uncryptedMagicBytes: options.uncryptedMagicBytes,
            failureTolerance: Int32(options.failureTolerance), keyRingSize: Int32(options.keyRingSize),
            discardFrameWhenCryptorNotReady: options.discardFrameWhenCryptorNotReady,
            keyDerivationAlgorithm: .HKDF)
        native.setSharedKey(Data(hex: vectors.ratchet.from), with: 0)
        #expect(native.exportSharedKey(0).hex == vectors.ratchet.from)
        for step in vectors.ratchet.steps {
            #expect(native.ratchetSharedKey(0).hex == step.material)
        }

        native.setKey(Data(hex: vectors.ratchet.from), with: 3, forParticipant: "bob")
        #expect(native.ratchetKey("bob", with: 3).hex == vectors.ratchet.steps[0].material)
    }

    /// The production backend builds real cryptors on a real sender and receiver.
    @Test func testLiveKitBackendAttachesToRealSendersAndReceivers() throws {
        let factory = WebRTCFactory.shared
        let backend = LiveKitCryptorBackend(factory: factory)
        let keys = E2EEKeyProvider()
        keys.setSharedPassphrase("pw", roomId: "room_1")
        let encryption = E2EEFrameEncryption(keys: keys, backend: backend, localIdentity: "alice", logger: RTCLogger())
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        let pc = try #require(factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: nil))
        let initOptions = RTCRtpTransceiverInit()
        initOptions.direction = .sendRecv
        // libwebrtc's cryptor needs a track on the sender.
        let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let mic = factory.audioTrack(with: source, trackId: "alice-mic")
        let transceiver = try #require(pc.addTransceiver(with: mic, init: initOptions))
        let senderCryptor = try #require(encryption.attachSender(transceiver.sender))
        #expect(senderCryptor.isEnabled)
        #expect(senderCryptor.keyIndex == 0)
        let receiverCryptor = try #require(encryption.attachReceiver(transceiver.receiver, participantId: "bob"))
        #expect(receiverCryptor.isEnabled)
        #expect(encryption.cryptorCount == 2)
        encryption.dispose()
        pc.close()
    }

    /// The real engine puts a cryptor on a published sender before its offer.
    @Test func testEngineEncryptsPublishedSenders() async throws {
        let factory = WebRTCFactory.shared
        let keys = E2EEKeyProvider()
        keys.setSharedKey(Data(repeating: 1, count: 32))
        let encryption = E2EEFrameEncryption(keys: keys, backend: LiveKitCryptorBackend(factory: factory),
                                             localIdentity: "alice", logger: RTCLogger())
        let engine = PeerConnectionEngine(logger: RTCLogger())
        var signals: [ClientMessage] = []
        engine.sendSignal = { signals.append($0) }
        engine.resetPeerConnection(iceServers: [])
        engine.frameEncryption = encryption
        let mic = factory.audioTrack(with: factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)),
                                     trackId: "alice-mic")
        try await engine.publish(EnginePublication(trackId: "alice-mic", source: .microphone, track: mic, simulcast: false))
        #expect(encryption.cryptorCount == 1)
        #expect(signals.first == .trackPublish(trackId: "alice-mic", source: .microphone))

        // A fresh PeerConnection (rejoin): the publication is re-attached with a new cryptor.
        engine.resetPeerConnection(iceServers: [])
        #expect(encryption.cryptorCount == 1)

        await engine.unpublish(trackId: "alice-mic")
        #expect(encryption.cryptorCount == 0)
        engine.close()
        #expect(engine.frameEncryption == nil)
    }
}
