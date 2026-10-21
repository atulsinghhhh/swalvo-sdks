import Foundation

/// Options for `room.sendData(_:options:)` (phase 7 §1.6).
///
/// With the defaults, and against a server that does not advertise
/// `data.v2`, the bytes on the wire are exactly what `sendData(_:)` always
/// sent: a legacy broadcast on the reliable channel.
public struct DataPublishOptions: Equatable, Sendable {
    /// A label receivers get with the message (`dataReceived(..., topic:)`).
    /// At most 255 bytes of UTF-8.
    public var topic: String?
    /// Only these identities receive the message. Empty or nil broadcasts
    /// to the room. At most 64; unknown identities are skipped by the SFU.
    public var destinationIdentities: [String]?
    /// `true` (the default): ordered and retransmitted, up to 64 KiB.
    /// `false`: the `raven-data-lossy` channel — unordered, never
    /// retransmitted, at most 1,200 bytes. For cursors and game state.
    public var reliable: Bool

    public init(topic: String? = nil, destinationIdentities: [String]? = nil, reliable: Bool = true) {
        self.topic = topic
        self.destinationIdentities = destinationIdentities
        self.reliable = reliable
    }
}

/// Which data channel a message used (`dataThrottled`, phase 7 §1.4).
public enum DataChannelKind: String, Codable, Sendable, CaseIterable {
    case reliable, lossy
}

/// A data message as it arrived, after the SFU's delivery header is removed.
struct DecodedDataMessage: Equatable {
    var payload: Data
    /// The SFU-stamped sender. `""` means the server; nil means a legacy
    /// message with no attribution at all.
    var senderIdentity: String?
    /// nil for legacy messages.
    var topic: String?
    var isLegacy: Bool { senderIdentity == nil }
}

/// The data message v2 envelope (docs/architecture/phase7-contracts.md
/// §1.2-1.3). Byte-for-byte checked against
/// docs/architecture/data-envelope-vectors.json on every platform.
enum DataEnvelope {
    static let magic: UInt8 = 0x52
    static let clientVersion: UInt8 = 0x02
    static let deliveryVersion: UInt8 = 0x03

    static let maxTopicBytes = 255
    static let maxDestinations = 64
    static let maxIdentityBytes = 255
    static let maxReliablePayloadBytes = 65_536
    static let maxLossyPayloadBytes = 1_200

    /// Client → SFU:
    /// `0x52 0x02 | flags | topicLen | topic | destCount | (idLen | id)* | payload`.
    static func encode(payload: Data, topic: String?, destinationIdentities: [String]?) throws -> Data {
        let topicBytes = Array((topic ?? "").utf8)
        guard topicBytes.count <= maxTopicBytes else {
            throw RTCError(.invalidArgument, "Data topic is \(topicBytes.count) bytes of UTF-8, over the \(maxTopicBytes)-byte limit")
        }
        let destinations = destinationIdentities ?? []
        guard destinations.count <= maxDestinations else {
            throw RTCError(.invalidArgument, "Data messages go to at most \(maxDestinations) destination identities, not \(destinations.count)")
        }
        var out = Data([magic, clientVersion, 0x00, UInt8(topicBytes.count)])
        out.append(contentsOf: topicBytes)
        out.append(UInt8(destinations.count))
        for identity in destinations {
            let bytes = Array(identity.utf8)
            guard !bytes.isEmpty else {
                throw RTCError(.invalidArgument, "A destination identity cannot be empty")
            }
            guard bytes.count <= maxIdentityBytes else {
                throw RTCError(.invalidArgument, "Destination identity is \(bytes.count) bytes of UTF-8, over the \(maxIdentityBytes)-byte limit")
            }
            out.append(UInt8(bytes.count))
            out.append(contentsOf: bytes)
        }
        out.append(payload)
        return out
    }

    /// SFU → client: `0x52 0x03 | senderLen | sender | topicLen | topic | payload`.
    /// Anything else — including a truncated frame or invalid UTF-8 — is a
    /// legacy message, delivered whole.
    static func decode(_ data: Data) -> DecodedDataMessage {
        let bytes = [UInt8](data)
        let legacy = DecodedDataMessage(payload: data, senderIdentity: nil, topic: nil)
        guard bytes.count >= 3, bytes[0] == magic, bytes[1] == deliveryVersion else { return legacy }
        var index = 2
        func readString() -> String? {
            guard index < bytes.count else { return nil }
            let length = Int(bytes[index])
            index += 1
            guard index + length <= bytes.count else { return nil }
            let slice = bytes[index..<(index + length)]
            index += length
            // Strict: String(bytes:encoding:) returns nil on invalid UTF-8.
            return String(bytes: slice, encoding: .utf8)
        }
        guard let sender = readString(), let topic = readString() else { return legacy }
        return DecodedDataMessage(payload: Data(bytes[index...]), senderIdentity: sender, topic: topic)
    }
}

// MARK: - Participant metadata (phase 7 §2)

/// Limits on `metadata` and `attributes`, checked before anything is sent.
enum ParticipantMetadataLimits {
    static let maxMetadataBytes = 4_096
    static let maxAttributes = 32
    static let maxAttributeKeyLength = 64
    static let maxAttributeValueBytes = 1_024

    static func validate(metadata: String) throws {
        let size = metadata.utf8.count
        guard size <= maxMetadataBytes else {
            throw RTCError(.invalidArgument, "Participant metadata is \(size) bytes, over the \(maxMetadataBytes)-byte limit")
        }
    }

    static func validate(attributes: [String: String]) throws {
        guard attributes.count <= maxAttributes else {
            throw RTCError(.invalidArgument, "A participant has at most \(maxAttributes) attributes, not \(attributes.count)")
        }
        for (key, value) in attributes {
            guard !key.isEmpty, key.count <= maxAttributeKeyLength else {
                throw RTCError(.invalidArgument, "Attribute keys are 1-\(maxAttributeKeyLength) characters; \"\(key.prefix(80))\" is not")
            }
            guard value.utf8.count <= maxAttributeValueBytes else {
                throw RTCError(.invalidArgument, "Attribute \"\(key)\" is \(value.utf8.count) bytes, over the \(maxAttributeValueBytes)-byte limit")
            }
        }
    }
}
