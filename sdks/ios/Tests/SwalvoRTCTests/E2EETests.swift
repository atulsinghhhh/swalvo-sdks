import Foundation
import Testing
@testable import SwalvoRTC

/// The E2EE key schedule and frame format against
/// docs/architecture/e2ee-vectors.json (produced by the web SDK).
@Suite(.serialized) final class E2EETests {
    private struct Vectors: Decodable {
        struct Passphrase: Decodable { let passphrase, roomId, material, aesKey: String }
        struct Step: Decodable { let material, aesKey: String }
        struct Ratchet: Decodable { let from: String; let steps: [Step] }
        struct RawKey: Decodable { let material, aesKey: String }
        struct Frame: Decodable {
            let name, codec: String
            let isKeyFrame: Bool
            let keyIndex: UInt8
            let ssrc, timestamp, sendCount: UInt32
            let plaintext: String
            let unencryptedBytes: Int
            let iv, encrypted: String
        }
        struct Frames: Decodable { let keyMaterial: String; let cases: [Frame] }
        let passphrase: Passphrase
        let ratchet: Ratchet
        let rawKey: RawKey
        let frames: Frames
    }

    /// The bundled copy, plus the live repo copy when present (catches drift).
    private func vectorSources() throws -> [(String, Vectors)] {
        var sources: [(String, Vectors)] = []
        if let url = Bundle.module.url(forResource: "e2ee-vectors", withExtension: "json", subdirectory: "Fixtures") {
            sources.append(("bundled", try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))))
        }
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("docs/architecture/e2ee-vectors.json")
        if let data = try? Data(contentsOf: repo) {
            sources.append(("repo", try JSONDecoder().decode(Vectors.self, from: data)))
        }
        #expect(!sources.isEmpty, "no E2EE vectors available")
        return sources
    }

    @Test func testPassphraseDerivation() throws {
        for (source, v) in try vectorSources() {
            let material = E2EEKeyDerivation.material(passphrase: v.passphrase.passphrase, roomId: v.passphrase.roomId)
            #expect((material.hex) == (v.passphrase.material), "\(source)")
            #expect((E2EEKeyDerivation.aesKey(material: material).hex) == (v.passphrase.aesKey), "\(source)")
        }
    }

    @Test func testRatchet() throws {
        for (source, v) in try vectorSources() {
            var set = E2EEKeySet(material: Data(hex: v.ratchet.from))
            for step in v.ratchet.steps {
                set = set.ratcheted()
                #expect((set.material.hex) == (step.material), "\(source)")
                #expect((set.aesKey.hex) == (step.aesKey), "\(source)")
            }
        }
    }

    @Test func testRawKey() throws {
        for (source, v) in try vectorSources() {
            #expect((E2EEKeyDerivation.aesKey(material: Data(hex: v.rawKey.material)).hex) == (v.rawKey.aesKey), "\(source)")
        }
    }

    @Test func testFramesEncryptByteForByte() throws {
        for (source, v) in try vectorSources() {
            let keySet = E2EEKeySet(material: Data(hex: v.frames.keyMaterial))
            for frame in v.frames.cases {
                let codec = try #require(E2EECodec(rawValue: frame.codec))
                let plaintext = Data(hex: frame.plaintext)
                #expect((E2EEFrameCodec.unencryptedBytes(plaintext, codec: codec, isKeyFrame: frame.isKeyFrame)) == (frame.unencryptedBytes), "\(source) \(frame.name) clear bytes")
                let iv = E2EEFrameCodec.makeIV(ssrc: frame.ssrc, timestamp: frame.timestamp, sendCount: frame.sendCount)
                #expect((iv.hex) == (frame.iv), "\(source) \(frame.name) iv")
                let encrypted = try E2EEFrameCodec.encrypt(frame: plaintext, codec: codec, isKeyFrame: frame.isKeyFrame,
                                                           keySet: keySet, keyIndex: frame.keyIndex, iv: iv)
                #expect((encrypted.hex) == (frame.encrypted), "\(source) \(frame.name) ciphertext")
            }
        }
    }

    @Test func testFramesDecrypt() throws {
        for (source, v) in try vectorSources() {
            let keys = E2EEKeyProvider()
            let material = Data(hex: v.frames.keyMaterial)
            for index: UInt8 in 0...2 { keys.setKey(participantId: "bob", key: material, keyIndex: index) }
            for frame in v.frames.cases {
                let codec = try #require(E2EECodec(rawValue: frame.codec))
                let (plain, state) = E2EEFrameCodec.decrypt(frame: Data(hex: frame.encrypted), codec: codec,
                                                            isKeyFrame: frame.isKeyFrame, participantId: "bob", keys: keys)
                #expect((state) == (.ok), "\(source) \(frame.name)")
                #expect((plain?.hex) == (frame.plaintext), "\(source) \(frame.name)")
            }
        }
    }

    @Test func testReceiverRatchetsForwardWithinWindow() throws {
        let material = Data(repeating: 7, count: 32)
        let sender = E2EEKeySet(material: material).ratcheted().ratcheted().ratcheted()
        let frame = Data([0xfc] + Array(repeating: UInt8(9), count: 40))
        let iv = E2EEFrameCodec.makeIV(ssrc: 1, timestamp: 2, sendCount: 3)
        let encrypted = try E2EEFrameCodec.encrypt(frame: frame, codec: .opus, isKeyFrame: false, keySet: sender, keyIndex: 0, iv: iv)

        let keys = E2EEKeyProvider(ratchetWindow: 8)
        keys.setKey(participantId: "bob", key: material)
        let (plain, state) = E2EEFrameCodec.decrypt(frame: encrypted, codec: .opus, isKeyFrame: false, participantId: "bob", keys: keys)
        #expect((state) == (.ok))
        #expect((plain) == (frame))
        #expect((keys.keySet(participantId: "bob", index: 0)) == (sender), "the ratcheted key is adopted")

        let narrow = E2EEKeyProvider(ratchetWindow: 2)
        narrow.setKey(participantId: "bob", key: material)
        #expect((E2EEFrameCodec.decrypt(frame: encrypted, codec: .opus, isKeyFrame: false, participantId: "bob", keys: narrow).state) == (.decryptFailed))
    }

    @Test func testMissingKeyAndTamperedFrame() throws {
        let keySet = E2EEKeySet(material: Data(repeating: 1, count: 32))
        let frame = Data(Array(repeating: UInt8(5), count: 30))
        var encrypted = try E2EEFrameCodec.encrypt(frame: frame, codec: .vp8, isKeyFrame: false, keySet: keySet, keyIndex: 0,
                                                   iv: E2EEFrameCodec.makeIV(ssrc: 1, timestamp: 1, sendCount: 0))
        let empty = E2EEKeyProvider()
        #expect((E2EEFrameCodec.decrypt(frame: encrypted, codec: .vp8, isKeyFrame: false, participantId: "x", keys: empty).state) == (.missingKey))

        let keys = E2EEKeyProvider(ratchetWindow: 1)
        keys.setSharedKey(keySet.material)
        encrypted[5] ^= 0xFF // a ciphertext byte
        #expect((E2EEFrameCodec.decrypt(frame: encrypted, codec: .vp8, isKeyFrame: false, participantId: "x", keys: keys).state) == (.decryptFailed))
    }

    @Test func testH264EscapingRoundTrip() throws {
        // A payload full of zero runs exercises RBSP escaping. (The IV is
        // read before unescaping, as in libwebrtc, so a realistic non-zero
        // ssrc/timestamp is used; an all-zero IV would itself be escaped.)
        let header: [UInt8] = [0, 0, 0, 1, 0x65, 0x88]
        let frame = Data(header + Array(repeating: UInt8(0), count: 64))
        let keySet = E2EEKeySet(material: Data(repeating: 3, count: 32))
        let encrypted = try E2EEFrameCodec.encrypt(frame: frame, codec: .h264, isKeyFrame: true, keySet: keySet, keyIndex: 4,
                                                   iv: E2EEFrameCodec.makeIV(ssrc: 0x1122_3344, timestamp: 90_000, sendCount: 5))
        let body = [UInt8](encrypted.dropFirst(header.count))
        for i in 0..<(max(0, body.count - 2)) where body[i] == 0 && body[i + 1] == 0 {
            #expect((body[i + 2]) > (0x02), "no start code may appear in the escaped body")
        }
        let keys = E2EEKeyProvider()
        keys.setSharedKey(keySet.material, keyIndex: 4)
        #expect((E2EEFrameCodec.decrypt(frame: encrypted, codec: .h264, isKeyFrame: true, participantId: "p", keys: keys).plaintext) == (frame))
    }
}

extension Data {
    init(hex: String) {
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        self.init(bytes)
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
