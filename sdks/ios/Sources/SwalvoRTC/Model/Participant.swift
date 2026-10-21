import Foundation

/// Events a single participant emits, for a view that only cares about one
/// person. Room-level events carry the same information for everyone.
///
/// - Important: New cases are added in minor releases as the protocol
///   grows. When you `switch` over this exhaustively, end with
///   `@unknown default:` so a new case is a compiler warning, not a build
///   failure. (A plain `default:` also compiles but hides new cases.)
public enum ParticipantEvent: Sendable {
    /// Started or stopped speaking, by the SFU's measure.
    case isSpeakingChanged(Bool)
    /// The SFU's connection-quality score changed.
    case connectionQualityChanged(ConnectionQuality)
    /// Phase 5 §3.2: this participant's media decrypt/encrypt state changed.
    case e2eeStateChanged(E2EEState)
    /// Phase 7 §2: `metadata` or `attributes` changed. Carries the values
    /// from before; read the new ones off the participant.
    case metadataChanged(previousMetadata: String?, previousAttributes: [String: String])
    /// Phase 6 §4.2: this AI agent's state changed.
    case agentStateChanged(AgentState)
}

/// Fields the local user and remote participants share.
@MainActor
public class Participant {
    /// The RTC token's participant identity. Stable for the session.
    public internal(set) var identity: String
    /// Whether the SFU counts this participant as an active speaker.
    public private(set) var isSpeaking = false
    /// Smoothed level 0...1 as of the last speaker update; 0 when not speaking.
    public private(set) var audioLevel: Double = 0
    /// `unknown` until the server scores them (there is no snapshot on join).
    public private(set) var connectionQuality: ConnectionQuality = .unknown
    public internal(set) var e2eeState: E2EEState?
    /// Phase 7 §2: an opaque string (at most 4 KiB) the app attaches to a
    /// participant: through the token (`metadata` at mint), the server API,
    /// or `LocalParticipant.setMetadata`. Nil when none was set.
    public internal(set) var metadata: String?
    /// Phase 7 §2: string key/value pairs (at most 32 keys).
    public internal(set) var attributes: [String: String] = [:]
    /// Phase 6 §4.2: an AI agent's last known state; nil for everyone else
    /// and before the first `agent.state`.
    public internal(set) var agentState: AgentState?

    /// Phase 6 §1: an AI voice agent (identity prefix `agent-`).
    public var isAgent: Bool { identity.hasPrefix(AIIdentity.agentPrefix) }
    /// Phase 6 §1: the room's transcriber bot (identity prefix `transcriber-`).
    public var isTranscriber: Bool { identity.hasPrefix(AIIdentity.transcriberPrefix) }

    private let broadcaster = EventBroadcaster<ParticipantEvent>()

    init(identity: String) {
        self.identity = identity
    }

    /// A stream of this participant's own events.
    public func events() -> AsyncStream<ParticipantEvent> {
        broadcaster.stream()
    }

    /// Returns whether `isSpeaking` flipped.
    @discardableResult
    func setSpeaking(_ speaking: Bool, level: Double) -> Bool {
        audioLevel = speaking ? (level.isFinite ? min(1, max(0, level)) : 0) : 0
        guard isSpeaking != speaking else { return false }
        isSpeaking = speaking
        broadcaster.emit(.isSpeakingChanged(speaking))
        return true
    }

    /// Returns whether it changed.
    @discardableResult
    func setConnectionQuality(_ quality: ConnectionQuality) -> Bool {
        guard connectionQuality != quality else { return false }
        connectionQuality = quality
        broadcaster.emit(.connectionQualityChanged(quality))
        return true
    }

    @discardableResult
    func setE2EEState(_ state: E2EEState) -> Bool {
        guard e2eeState != state else { return false }
        e2eeState = state
        broadcaster.emit(.e2eeStateChanged(state))
        return true
    }

    /// Returns whether it changed.
    @discardableResult
    func setAgentState(_ state: AgentState) -> Bool {
        guard agentState != state else { return false }
        agentState = state
        broadcaster.emit(.agentStateChanged(state))
        return true
    }

    /// Applies new metadata/attributes (nil leaves a field as it is) and
    /// returns the previous values when anything changed.
    func applyMetadata(_ metadata: String??, attributes: [String: String]?) -> (metadata: String?, attributes: [String: String])? {
        let previous = (metadata: self.metadata, attributes: self.attributes)
        if let metadata { self.metadata = metadata }
        if let attributes { self.attributes = attributes }
        guard self.metadata != previous.metadata || self.attributes != previous.attributes else { return nil }
        broadcaster.emit(.metadataChanged(previousMetadata: previous.metadata, previousAttributes: previous.attributes))
        return previous
    }

    func finishEvents() {
        broadcaster.finish()
    }
}

@MainActor
public final class LocalParticipant: Participant {
    /// Tracks this participant has published, in publish order.
    public internal(set) var tracks: [LocalTrack] = []
    weak var room: Room?

    /// Replaces this participant's metadata for everyone in the room
    /// (`participant.update`, phase 7 §2). Needs a token minted with
    /// `perms.updateOwnMetadata`; throws `permissionDenied` otherwise, and
    /// `invalidArgument` over 4 KiB. `metadata` changes when the server
    /// confirms (`participantMetadataChanged`), not optimistically.
    public func setMetadata(_ metadata: String) async throws {
        guard let room else { throw RTCError(.notConnected, "Join the room before setting metadata") }
        try room.updateLocalParticipant(metadata: metadata, attributes: nil)
    }

    /// Sets the given attributes, leaving other keys as they are (the
    /// server merges). Same permission and confirmation rules as
    /// `setMetadata`; limits are 32 keys, 64-character keys, 1 KiB values.
    public func setAttributes(_ attributes: [String: String]) async throws {
        guard let room else { throw RTCError(.notConnected, "Join the room before setting attributes") }
        try room.updateLocalParticipant(metadata: nil, attributes: attributes)
    }
}

@MainActor
public final class RemoteParticipant: Participant {
    /// Tracks subscribed from this participant, in subscribe order.
    public internal(set) var tracks: [RemoteTrack] = []
    /// Tracks the server says this participant publishes, subscribed or not.
    public internal(set) var publishedTracks: [ServerTrack] = []
}
