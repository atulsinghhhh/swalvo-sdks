import Foundation

/// One live caption segment, `transcription.segment` (phase6-contracts §4.1).
///
/// Interim segments share a `segmentId` and replace each other; the
/// segment with `isFinal == true` closes that id. A final with empty
/// `text` means the provider withdrew the interim: clear it and show
/// nothing. An AI agent's own speech arrives as segments too, with
/// `participantId` set to the agent's identity.
public struct TranscriptionSegment: Codable, Equatable, Sendable {
    /// Nil for an agent's own speech when no transcription is running.
    public var transcriptionId: String?
    /// Set when the segment is an AI agent's own speech.
    public var agentId: String?
    /// Who was speaking.
    public var participantId: String
    public var segmentId: String
    public var text: String
    /// JSON `final`.
    public var isFinal: Bool
    public var language: String
    /// Relative to the transcription's start.
    public var startMs: Int
    public var endMs: Int

    public init(transcriptionId: String?, agentId: String? = nil, participantId: String, segmentId: String, text: String,
                isFinal: Bool, language: String, startMs: Int, endMs: Int) {
        self.transcriptionId = transcriptionId
        self.agentId = agentId
        self.participantId = participantId
        self.segmentId = segmentId
        self.text = text
        self.isFinal = isFinal
        self.language = language
        self.startMs = startMs
        self.endMs = endMs
    }

    private enum CodingKeys: String, CodingKey {
        case transcriptionId, agentId, participantId, segmentId, text, language, startMs, endMs
        case isFinal = "final"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        transcriptionId = try c.decodeIfPresent(String.self, forKey: .transcriptionId)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        participantId = try c.decode(String.self, forKey: .participantId)
        segmentId = try c.decode(String.self, forKey: .segmentId)
        text = try c.decode(String.self, forKey: .text)
        isFinal = try c.decode(Bool.self, forKey: .isFinal)
        language = try c.decodeIfPresent(String.self, forKey: .language) ?? ""
        startMs = Self.milliseconds(c, .startMs)
        endMs = Self.milliseconds(c, .endMs)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let transcriptionId { try c.encode(transcriptionId, forKey: .transcriptionId) } else { try c.encodeNil(forKey: .transcriptionId) }
        try c.encodeIfPresent(agentId, forKey: .agentId)
        try c.encode(participantId, forKey: .participantId)
        try c.encode(segmentId, forKey: .segmentId)
        try c.encode(text, forKey: .text)
        try c.encode(isFinal, forKey: .isFinal)
        try c.encode(language, forKey: .language)
        try c.encode(startMs, forKey: .startMs)
        try c.encode(endMs, forKey: .endMs)
    }

    private static func milliseconds(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Int {
        if let value = try? c.decode(Int.self, forKey: key) { return value }
        if let value = try? c.decode(Double.self, forKey: key), value.isFinite { return Int(value) }
        return 0
    }
}

/// A transcription's status (phase6-contracts §4.3).
public enum TranscriptionStatus: String, Codable, Sendable {
    case starting = "STARTING"
    case active = "ACTIVE"
    case stopping = "STOPPING"
    case ended = "ENDED"
    case failed = "FAILED"
}

/// `transcription.state` (phase6-contracts §4.3): the room's transcription
/// changed status.
public struct TranscriptionState: Codable, Equatable, Sendable {
    public var transcriptionId: String
    public var status: TranscriptionStatus
    public var language: String

    public init(transcriptionId: String, status: TranscriptionStatus, language: String) {
        self.transcriptionId = transcriptionId
        self.status = status
        self.language = language
    }

    private enum CodingKeys: String, CodingKey { case transcriptionId, status, language }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        transcriptionId = try c.decode(String.self, forKey: .transcriptionId)
        status = try c.decode(TranscriptionStatus.self, forKey: .status)
        language = try c.decodeIfPresent(String.self, forKey: .language) ?? ""
    }
}

/// An AI voice agent's live state (phase6-contracts §4.2).
public enum AgentState: String, Codable, Sendable {
    case listening, thinking, speaking, ended
}

/// `agent.state` as it arrives on the wire (phase6-contracts §4.2).
public struct AgentStateUpdate: Codable, Equatable, Sendable {
    public var agentId: String
    /// The agent's participant identity (`agent-…`).
    public var participantId: String
    public var state: AgentState

    public init(agentId: String, participantId: String, state: AgentState) {
        self.agentId = agentId
        self.participantId = participantId
        self.state = state
    }
}

/// Identity prefixes of the Phase 6 bots (phase6-contracts §1).
enum AIIdentity {
    static let agentPrefix = "agent-"
    static let transcriberPrefix = "transcriber-"
}
