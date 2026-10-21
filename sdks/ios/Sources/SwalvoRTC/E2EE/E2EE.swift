import CommonCrypto
import CryptoKit
import Foundation

/// Per-participant end-to-end encryption state (phase 5 §3.2).
public enum E2EEState: String, Sendable {
    case ok
    case missingKey = "missing_key"
    case encryptFailed = "encrypt_failed"
    case decryptFailed = "decrypt_failed"
}

/// The Swalvo E2EE key schedule (phase 5 §3, binding for every platform;
/// byte-for-byte the web SDK's `packages/sdk/src/e2ee/crypto.ts`, checked
/// against docs/architecture/e2ee-vectors.json):
///
/// ```
/// material₀ = PBKDF2-HMAC-SHA256(utf8(passphrase), utf8("LivqenoE2EE:" + roomId), 100000, 32 bytes)
///          or the raw bytes an app hands setKey()
/// aesKey    = HKDF-SHA256(ikm = material, salt = utf8("LivqenoRatchet"), info = 128 zero bytes, 16 bytes)
/// material' = HKDF-SHA256(ikm = material, salt = utf8("LivqenoRatchet"), info = 128 zero bytes, 32 bytes)  // ratchet
/// ```
///
/// The HKDF step is what libwebrtc's frame cryptor does with
/// `ratchetSalt = "LivqenoRatchet"` and HKDF key derivation, so a WebRTC
/// build with `RTCFrameCryptor` is handed `material` and arrives at the
/// same AES key.
public enum E2EEKeyDerivation {
    public static let pbkdf2Iterations = 100_000
    public static let materialLength = 32
    public static let aesKeyLength = 16
    // legacy: KDF labels kept byte-for-byte; changing them breaks E2EE across versions.
    public static let passphraseSaltPrefix = "LivqenoE2EE:"
    public static let ratchetSalt = "LivqenoRatchet"
    /// libwebrtc's HKDF `info`: 128 zero bytes.
    static let hkdfInfo = Data(count: 128)

    /// Shared-passphrase mode: passphrase → 32 bytes of key material.
    public static func material(passphrase: String, roomId: String, iterations: Int = pbkdf2Iterations) -> Data {
        pbkdf2SHA256(password: Data(passphrase.utf8), salt: Data((passphraseSaltPrefix + roomId).utf8),
                     iterations: iterations, length: materialLength)
    }

    /// The 16 AES-128 key bytes for a piece of material.
    public static func aesKey(material: Data) -> Data {
        hkdf(material, length: aesKeyLength)
    }

    /// One ratchet step: the next 32 bytes of material.
    public static func ratchet(material: Data) -> Data {
        hkdf(material, length: materialLength)
    }

    static func hkdf(_ material: Data, length: Int) -> Data {
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: material),
                                         salt: Data(ratchetSalt.utf8), info: hkdfInfo, outputByteCount: length)
        return key.withUnsafeBytes { Data($0) }
    }

    static func pbkdf2SHA256(password: Data, salt: Data, iterations: Int, length: Int) -> Data {
        var out = Data(count: length)
        let status = out.withUnsafeMutableBytes { outPtr in
            password.withUnsafeBytes { pwPtr in
                salt.withUnsafeBytes { saltPtr in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        pwPtr.baseAddress?.assumingMemoryBound(to: CChar.self), password.count,
                        saltPtr.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
                        outPtr.baseAddress?.assumingMemoryBound(to: UInt8.self), length)
                }
            }
        }
        precondition(status == kCCSuccess, "PBKDF2 failed: \(status)")
        return out
    }
}

/// Key material for one key index, with its derived AES key.
public struct E2EEKeySet: Equatable, Sendable {
    public let material: Data
    public let aesKey: Data

    public init(material: Data) {
        self.material = material
        self.aesKey = E2EEKeyDerivation.aesKey(material: material)
    }

    public func ratcheted() -> E2EEKeySet {
        E2EEKeySet(material: E2EEKeyDerivation.ratchet(material: material))
    }
}

/// Holds E2EE keys: a shared ring (passphrase mode) and/or one ring per
/// participant (per-participant mode). Thread-safe. Keys never leave the
/// device; the server never sees them.
///
/// In an E2EE room the SDK mirrors every key set here into libwebrtc's
/// frame-cryptor key provider (`LKRTCFrameCryptorKeyProvider`), which
/// encrypts and decrypts the media. That native provider works in one mode
/// for its whole life: shared-key (every participant uses the shared ring)
/// or per-participant. Pass `sharedKeyMode` to choose; left nil, the mode is
/// decided when encryption starts: per-participant if a participant key has
/// been set by then, shared otherwise.
public final class E2EEKeyProvider: @unchecked Sendable {
    /// Forward ratchets a receiver tries before giving up on a frame.
    public let ratchetWindow: Int
    /// Explicit key mode for the native provider; nil = decided at start (see above).
    public let sharedKeyMode: Bool?
    /// Consecutive decrypt failures tolerated before `decrypt_failed` is
    /// reported; -1 reports every one (the contract's setting).
    public let failureTolerance: Int
    /// Key indexes kept per participant (the contract's 16).
    public let keyRingSize: Int

    private let lock = NSLock()
    private var shared: [UInt8: E2EEKeySet] = [:]
    private var sharedIndex: UInt8 = 0
    private var perParticipant: [String: [UInt8: E2EEKeySet]] = [:]
    private var currentIndex: [String: UInt8] = [:]
    private var observers: [UUID: @Sendable (E2EEKeyChange) -> Void] = [:]

    public init(ratchetWindow: Int = 8, sharedKeyMode: Bool? = nil, failureTolerance: Int = -1, keyRingSize: Int = 16) {
        self.ratchetWindow = ratchetWindow
        self.sharedKeyMode = sharedKeyMode
        self.failureTolerance = failureTolerance
        self.keyRingSize = keyRingSize
    }

    /// Shared-passphrase mode: derives the room's material and makes it current.
    public func setSharedPassphrase(_ passphrase: String, roomId: String, keyIndex: UInt8 = 0) {
        setSharedKey(E2EEKeyDerivation.material(passphrase: passphrase, roomId: roomId), keyIndex: keyIndex)
    }

    /// Shared mode with raw material.
    public func setSharedKey(_ material: Data, keyIndex: UInt8 = 0) {
        lock.lock()
        shared[keyIndex] = E2EEKeySet(material: material)
        sharedIndex = keyIndex
        let observers = Array(self.observers.values)
        lock.unlock()
        observers.forEach { $0(.sharedKey(material: material, index: keyIndex)) }
    }

    /// Per-participant mode: material the app distributed over its own channel.
    public func setKey(participantId: String, key material: Data, keyIndex: UInt8 = 0) {
        lock.lock()
        perParticipant[participantId, default: [:]][keyIndex] = E2EEKeySet(material: material)
        currentIndex[participantId] = keyIndex
        let observers = Array(self.observers.values)
        lock.unlock()
        observers.forEach { $0(.participantKey(participantId: participantId, material: material, index: keyIndex)) }
    }

    /// Ratchets a participant's current key, or the shared key when
    /// `participantId` is nil or has no key of its own. Returns the new set.
    @discardableResult
    public func ratchetKey(participantId: String? = nil) -> E2EEKeySet? {
        lock.lock()
        let change: E2EEKeyChange
        let next: E2EEKeySet
        if let participantId, let index = currentIndex[participantId], let set = perParticipant[participantId]?[index] {
            next = set.ratcheted()
            perParticipant[participantId]?[index] = next
            change = .ratcheted(participantId: participantId, index: index)
        } else if let set = shared[sharedIndex] {
            next = set.ratcheted()
            shared[sharedIndex] = next
            change = .ratcheted(participantId: nil, index: sharedIndex)
        } else {
            lock.unlock()
            return nil
        }
        let observers = Array(self.observers.values)
        lock.unlock()
        observers.forEach { $0(change) }
        return next
    }

    /// The key set and index to encrypt with for `participantId`.
    public func currentKey(participantId: String) -> (set: E2EEKeySet, index: UInt8)? {
        lock.lock(); defer { lock.unlock() }
        if let index = currentIndex[participantId], let set = perParticipant[participantId]?[index] { return (set, index) }
        if let set = shared[sharedIndex] { return (set, sharedIndex) }
        return nil
    }

    public func keySet(participantId: String, index: UInt8) -> E2EEKeySet? {
        lock.lock(); defer { lock.unlock() }
        return perParticipant[participantId]?[index] ?? shared[index]
    }

    /// Adopts a key found by ratcheting forward on the receive side.
    func adopt(_ set: E2EEKeySet, participantId: String, index: UInt8) {
        lock.lock(); defer { lock.unlock() }
        if perParticipant[participantId]?[index] != nil {
            perParticipant[participantId]?[index] = set
        } else {
            shared[index] = set
        }
    }

    public var hasAnyKey: Bool {
        lock.lock(); defer { lock.unlock() }
        return !shared.isEmpty || !perParticipant.isEmpty
    }

    /// The keys as they stand, plus every later change, with nothing lost in
    /// between: the snapshot is taken and the observer added under one lock.
    func observe(_ handler: @escaping @Sendable (E2EEKeyChange) -> Void) -> (token: UUID, snapshot: E2EEKeySnapshot) {
        lock.lock(); defer { lock.unlock() }
        let token = UUID()
        observers[token] = handler
        var participants: [(participantId: String, index: UInt8, material: Data)] = []
        for (id, ring) in perParticipant {
            // The current index last, so it ends up current natively too.
            let current = currentIndex[id]
            for (index, set) in ring.sorted(by: { $0.key < $1.key }) where index != current {
                participants.append((id, index, set.material))
            }
            if let current, let set = ring[current] { participants.append((id, current, set.material)) }
        }
        var sharedKeys = shared.filter { $0.key != sharedIndex }.sorted { $0.key < $1.key }.map { (index: $0.key, material: $0.value.material) }
        if let set = shared[sharedIndex] { sharedKeys.append((sharedIndex, set.material)) }
        return (token, E2EEKeySnapshot(shared: sharedKeys, participants: participants))
    }

    func removeObserver(_ token: UUID) {
        lock.lock(); defer { lock.unlock() }
        observers.removeValue(forKey: token)
    }
}

/// A key change, as mirrored into the native frame-cryptor key provider.
enum E2EEKeyChange: Equatable, Sendable {
    case sharedKey(material: Data, index: UInt8)
    case participantKey(participantId: String, material: Data, index: UInt8)
    /// `participantId` nil: the shared key at `index` was ratcheted.
    case ratcheted(participantId: String?, index: UInt8)
}

/// Every key an `E2EEKeyProvider` holds, current index of each ring last.
struct E2EEKeySnapshot: Sendable {
    var shared: [(index: UInt8, material: Data)]
    var participants: [(participantId: String, index: UInt8, material: Data)]
}

/// The codec of an encoded frame, which decides how many leading bytes stay
/// in the clear so the SFU can still read keyframes and layers.
public enum E2EECodec: String, Sendable {
    case vp8, vp9, av1, h264, opus
}

/// The Swalvo (LiveKit/libwebrtc-compatible) E2EE frame format:
///
///     [ clear header ][ AES-GCM-128 ciphertext ][ 16-byte tag ][ 12-byte IV ][ 0x0C ][ keyIndex ]
///
/// AAD = the clear header. IV = ssrc(4) ‖ timestamp(4) ‖ (timestamp −
/// sendCount mod 0xFFFF)(4), big-endian. For H.264 everything after the
/// header is RBSP-escaped so it can never contain a start code.
///
/// Pure Swift (CryptoKit), byte-compatible with the web SDK; verified
/// against docs/architecture/e2ee-vectors.json.
public enum E2EEFrameCodec {
    public static let ivLength = 12
    public static let tagLength = 16
    static let trailerLength = 2

    /// Bytes left unencrypted at the start of a frame (phase 5 §3.2 table).
    public static func unencryptedBytes(_ frame: Data, codec: E2EECodec, isKeyFrame: Bool) -> Int {
        switch codec {
        case .opus: return min(1, frame.count)
        case .vp8: return min(isKeyFrame ? 10 : 3, frame.count)
        case .h264: return h264UnencryptedBytes([UInt8](frame))
        case .vp9, .av1: return 0
        }
    }

    /// Offsets of the first byte after each Annex-B start code.
    static func naluIndices(_ data: [UInt8]) -> [Int] {
        var indices: [Int] = []
        var i = 0
        while i + 3 <= data.count {
            if data[i] == 0, data[i + 1] == 0, data[i + 2] == 1 {
                indices.append(i + 3)
                i += 3
            } else {
                i += 1
            }
        }
        return indices
    }

    /// Up to and including the byte after the first slice NALU's header, so
    /// SPS/PPS/SEI stay readable and the SFU can still see an IDR. 0 when no
    /// slice is found, matching libwebrtc.
    static func h264UnencryptedBytes(_ data: [UInt8]) -> Int {
        for index in naluIndices(data) where index < data.count {
            let type = data[index] & 0x1F
            if type == 1 || type == 5 { return min(index + 2, data.count) }
        }
        return 0
    }

    /// Strips emulation prevention bytes (00 00 03 → 00 00).
    static func parseRbsp(_ data: [UInt8]) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(data.count)
        var i = 0
        while i < data.count {
            if data.count - i >= 3, data[i] == 0, data[i + 1] == 0, data[i + 2] == 3 {
                out.append(0); out.append(0)
                i += 3
            } else {
                out.append(data[i])
                i += 1
            }
        }
        return out
    }

    /// Inserts emulation prevention bytes after two zeros followed by a byte ≤ 3.
    static func writeRbsp(_ data: [UInt8]) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(data.count + data.count / 64)
        var zeros = 0
        for byte in data {
            if byte <= 3 && zeros >= 2 {
                out.append(3)
                zeros = 0
            }
            out.append(byte)
            zeros = byte == 0 ? zeros + 1 : 0
        }
        return out
    }

    static func needsRbspUnescaping(_ data: [UInt8]) -> Bool {
        var i = 0
        while i + 3 < data.count {
            if data[i] == 0, data[i + 1] == 0, data[i + 2] == 3 { return true }
            i += 1
        }
        return false
    }

    /// `ssrc ‖ timestamp ‖ (timestamp − sendCount mod 0xFFFF)`, big-endian.
    public static func makeIV(ssrc: UInt32, timestamp: UInt32, sendCount: UInt32) -> Data {
        let counter = timestamp &- (sendCount % 0xFFFF)
        var iv = Data(capacity: ivLength)
        for value in [ssrc, timestamp, counter] {
            withUnsafeBytes(of: value.bigEndian) { iv.append(contentsOf: $0) }
        }
        return iv
    }

    public static func encrypt(frame: Data, codec: E2EECodec, isKeyFrame: Bool, keySet: E2EEKeySet, keyIndex: UInt8,
                               iv: Data) throws -> Data {
        let headerLength = unencryptedBytes(frame, codec: codec, isKeyFrame: isKeyFrame)
        let header = frame.prefix(headerLength)
        let sealed = try AES.GCM.seal(frame.dropFirst(headerLength), using: SymmetricKey(data: keySet.aesKey),
                                      nonce: AES.GCM.Nonce(data: iv), authenticating: header)
        var body = [UInt8](sealed.ciphertext) + [UInt8](sealed.tag) + [UInt8](iv)
        body.append(UInt8(iv.count))
        body.append(keyIndex)
        if codec == .h264 { body = writeRbsp(body) }
        return Data(header) + Data(body)
    }

    /// What can be read from a received frame before any key is involved.
    public struct ParsedFrame: Equatable, Sendable {
        public let header: Data
        public let iv: Data
        public let keyIndex: UInt8
        /// Ciphertext followed by the 16-byte tag, unescaped.
        public let payload: Data
    }

    public static func parse(frame: Data, codec: E2EECodec, isKeyFrame: Bool) -> ParsedFrame? {
        let data = [UInt8](frame)
        guard data.count >= trailerLength else { return nil }
        let ivLen = Int(data[data.count - 2])
        let keyIndex = data[data.count - 1]
        guard ivLen == ivLength else { return nil }
        let headerLength = unencryptedBytes(frame, codec: codec, isKeyFrame: isKeyFrame)
        guard data.count >= headerLength + ivLen + trailerLength + tagLength else { return nil }
        // The IV is read before unescaping, as libwebrtc does.
        let iv = Data(data[(data.count - trailerLength - ivLen)..<(data.count - trailerLength)])
        var rest = Array(data[headerLength...])
        if codec == .h264, needsRbspUnescaping(rest) { rest = parseRbsp(rest) }
        let payloadLength = rest.count - ivLen - trailerLength
        guard payloadLength >= tagLength else { return nil }
        return ParsedFrame(header: Data(data[0..<headerLength]), iv: iv, keyIndex: keyIndex,
                           payload: Data(rest[0..<payloadLength]))
    }

    /// Decrypts a parsed frame with one key. Throws when the tag does not verify.
    public static func decrypt(_ parsed: ParsedFrame, keySet: E2EEKeySet) throws -> Data {
        let ciphertext = parsed.payload.prefix(parsed.payload.count - tagLength)
        let tag = parsed.payload.suffix(tagLength)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: parsed.iv), ciphertext: ciphertext, tag: tag)
        return parsed.header + (try AES.GCM.open(box, using: SymmetricKey(data: keySet.aesKey), authenticating: parsed.header))
    }

    /// Decrypts with the participant's key for the frame's index, ratcheting
    /// forward up to the provider's window on failure (phase 5 §3.1). A key
    /// found by ratcheting is adopted.
    public static func decrypt(frame: Data, codec: E2EECodec, isKeyFrame: Bool, participantId: String,
                               keys: E2EEKeyProvider) -> (plaintext: Data?, state: E2EEState) {
        guard let parsed = parse(frame: frame, codec: codec, isKeyFrame: isKeyFrame) else { return (nil, .decryptFailed) }
        guard var candidate = keys.keySet(participantId: participantId, index: parsed.keyIndex) else { return (nil, .missingKey) }
        for attempt in 0...keys.ratchetWindow {
            if let plain = try? decrypt(parsed, keySet: candidate) {
                if attempt > 0 { keys.adopt(candidate, participantId: participantId, index: parsed.keyIndex) }
                return (plain, .ok)
            }
            candidate = candidate.ratcheted()
        }
        return (nil, .decryptFailed)
    }
}

/// Whether this build encrypts media frames.
///
/// The SDK links LiveKit's libwebrtc build (`LiveKitWebRTC`), which carries
/// libwebrtc's frame cryptor: in an E2EE room with a key provider
/// configured, every sender and receiver gets an AES-GCM `RTCFrameCryptor`
/// (see `E2EEFrameEncryption`). `E2EEFrameCodec` above is the same format
/// in pure Swift, kept for the shared vectors and for tooling.
public enum E2EESupport {
    /// True: this build wires libwebrtc's frame cryptor into the media path.
    public static let isFrameEncryptionAvailable = true
}
