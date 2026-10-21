import Foundation

// Swalvo's signaling wire protocol, as the client sees it.
//
// Mirrors docs/rtc/signaling.md and the Phase 1/2/5 contracts, and the web
// SDK's `packages/sdk/src/internal/signaling/protocol.ts`. Written out by
// hand so the SDK carries no dependency on the server.
//
// Every message is one JSON text frame with a `type` field. The decoder is
// tolerant in the way the protocol's Versioning section demands: unknown
// fields are ignored, and an unknown `type` decodes to `.unknown` rather
// than failing, so an additive server change never breaks this client.

// MARK: - Shared payloads

/// One ICE candidate, either direction. Only `candidate` is required.
public struct ICECandidatePayload: Codable, Equatable, Sendable {
    public var candidate: String
    public var sdpMid: String?
    public var sdpMLineIndex: Int?
    public var usernameFragment: String?

    public init(candidate: String, sdpMid: String? = nil, sdpMLineIndex: Int? = nil, usernameFragment: String? = nil) {
        self.candidate = candidate
        self.sdpMid = sdpMid
        self.sdpMLineIndex = sdpMLineIndex
        self.usernameFragment = usernameFragment
    }
}

/// What a published track is *of*. Declared with `track.publish`.
///
/// - Important: New cases are added in minor releases as the protocol
///   grows. When you `switch` over this exhaustively, end with
///   `@unknown default:` so a new case is a compiler warning, not a build
///   failure. (A plain `default:` also compiles but hides new cases.)
public enum TrackSource: String, Codable, Sendable, CaseIterable {
    case camera
    case microphone
    case screenShare
    /// Phase 7 §3: the audio of a screen share (a tab, the system, or an
    /// iOS broadcast extension's app audio). Published and unpublished with
    /// the screen share; never counted as an active speaker.
    case screenShareAudio

    /// Whether this source carries audio.
    public var isAudio: Bool { self == .microphone || self == .screenShareAudio }
}

/// A simulcast layer a subscriber may ask for. `off` pauses the video
/// without tearing the subscription down (phase 2 §4).
public enum SubscriptionLayer: String, Codable, Sendable, CaseIterable {
    case low, medium, high, auto, off
}

/// A session's live permissions (`participant.permissions_updated`, phase 1 §1.4).
public struct ParticipantPermissions: Codable, Equatable, Sendable {
    public var subscribe: Bool
    public var publish: Bool
    public var publishAudio: Bool
    public var publishVideo: Bool
    /// Screen-share, independent of `publishVideo` (agora-parity audit,
    /// phase 2). Granting camera video never implies this, and vice versa.
    public var publishScreen: Bool
    public var publishData: Bool
    /// Phase 7 §2: may call `setMetadata` / `setAttributes` on itself. Nil
    /// when the server did not say (the token's `perms` then decides).
    public var updateOwnMetadata: Bool?

    public init(subscribe: Bool, publish: Bool, publishAudio: Bool, publishVideo: Bool, publishScreen: Bool = false,
                publishData: Bool, updateOwnMetadata: Bool? = nil) {
        self.subscribe = subscribe
        self.publish = publish
        self.publishAudio = publishAudio
        self.publishVideo = publishVideo
        self.publishScreen = publishScreen
        self.publishData = publishData
        self.updateOwnMetadata = updateOwnMetadata
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        subscribe = try c.decodeIfPresent(Bool.self, forKey: .subscribe) ?? false
        publish = try c.decodeIfPresent(Bool.self, forKey: .publish) ?? false
        publishAudio = try c.decodeIfPresent(Bool.self, forKey: .publishAudio) ?? false
        publishVideo = try c.decodeIfPresent(Bool.self, forKey: .publishVideo) ?? false
        // Absent from an older server (or a pre-phase-2 token): false, same
        // as every other sub-flag here decodes a missing value.
        publishScreen = try c.decodeIfPresent(Bool.self, forKey: .publishScreen) ?? false
        publishData = try c.decodeIfPresent(Bool.self, forKey: .publishData) ?? false
        updateOwnMetadata = try c.decodeIfPresent(Bool.self, forKey: .updateOwnMetadata)
    }

    /// Whether these permissions allow publishing a track of `source`.
    public func allows(_ source: TrackSource) -> Bool {
        guard publish else { return false }
        switch source {
        case .microphone, .screenShareAudio: return publishAudio
        case .camera: return publishVideo
        case .screenShare: return publishScreen
        }
    }
}

/// A track as the server describes it, in `room.joined`, `participant.joined`
/// and `track.published`.
public struct ServerTrack: Codable, Equatable, Sendable {
    public var trackId: String
    /// `audio` or `video`.
    public var kind: String
    /// `camera`, `microphone` or `screenShare`; kept as a string so a new
    /// source never fails decoding.
    public var source: String
    public var muted: Bool
    public var simulcast: Bool
    public var layers: [String]?

    public init(trackId: String, kind: String, source: String, muted: Bool = false, simulcast: Bool = false, layers: [String]? = nil) {
        self.trackId = trackId
        self.kind = kind
        self.source = source
        self.muted = muted
        self.simulcast = simulcast
        self.layers = layers
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        trackId = try c.decode(String.self, forKey: .trackId)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "unknown"
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "unknown"
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
        simulcast = try c.decodeIfPresent(Bool.self, forKey: .simulcast) ?? false
        layers = try c.decodeIfPresent([String].self, forKey: .layers)
    }
}

public struct ServerParticipant: Codable, Equatable, Sendable {
    public var id: String
    public var tracks: [ServerTrack]
    /// Phase 7 §2. Nil when the server sent none (an older server).
    public var metadata: String?
    public var attributes: [String: String]?

    public init(id: String, tracks: [ServerTrack] = [], metadata: String? = nil, attributes: [String: String]? = nil) {
        self.id = id
        self.tracks = tracks
        self.metadata = metadata
        self.attributes = attributes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tracks = try c.decodeIfPresent([ServerTrack].self, forKey: .tracks) ?? []
        metadata = try? c.decodeIfPresent(String.self, forKey: .metadata)
        attributes = (try? c.decodeIfPresent([String: String?].self, forKey: .attributes))?.compactMapValues { $0 }
    }
}

/// `participant.updated` (phase 7 §2): a participant's metadata and
/// attributes as they are now. A field the frame leaves out is unchanged.
public struct ParticipantUpdate: Equatable, Sendable {
    public var participantId: String
    /// Whether the frame carried `metadata` at all (`null` clears it).
    public var includesMetadata: Bool
    public var metadata: String?
    /// Nil when the frame left `attributes` out.
    public var attributes: [String: String]?

    public init(participantId: String, metadata: String?, attributes: [String: String]?, includesMetadata: Bool = true) {
        self.participantId = participantId
        self.metadata = metadata
        self.attributes = attributes
        self.includesMetadata = includesMetadata
    }
}

/// A signaling error code. A struct rather than an enum so a code this SDK
/// does not know yet still decodes.
public struct SignalingErrorCode: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
    public var description: String { rawValue }

    public static let invalidToken: SignalingErrorCode = "INVALID_TOKEN"
    public static let tokenExpired: SignalingErrorCode = "TOKEN_EXPIRED"
    public static let tokenRevoked: SignalingErrorCode = "TOKEN_REVOKED"
    public static let tokenInvalid: SignalingErrorCode = "TOKEN_INVALID"
    public static let unauthorized: SignalingErrorCode = "UNAUTHORIZED"
    public static let permissionDenied: SignalingErrorCode = "PERMISSION_DENIED"
    public static let originNotAllowed: SignalingErrorCode = "ORIGIN_NOT_ALLOWED"
    public static let roomNotFound: SignalingErrorCode = "ROOM_NOT_FOUND"
    public static let roomFull: SignalingErrorCode = "ROOM_FULL"
    public static let roomClosed: SignalingErrorCode = "ROOM_CLOSED"
    public static let usageLimitExceeded: SignalingErrorCode = "USAGE_LIMIT_EXCEEDED"
    public static let notInRoom: SignalingErrorCode = "NOT_IN_ROOM"
    public static let noRTCCapacity: SignalingErrorCode = "NO_RTC_CAPACITY"
    public static let rtcServerUnreachable: SignalingErrorCode = "RTC_SERVER_UNREACHABLE"
    public static let negotiationGlare: SignalingErrorCode = "NEGOTIATION_GLARE"
    public static let negotiationFailed: SignalingErrorCode = "NEGOTIATION_FAILED"
    public static let invalidMessage: SignalingErrorCode = "INVALID_MESSAGE"
    public static let invalidMessageType: SignalingErrorCode = "INVALID_MESSAGE_TYPE"
    public static let rateLimited: SignalingErrorCode = "RATE_LIMITED"

    /// Codes where reconnecting with the same credential cannot help
    /// (mirrors the web SDK's `FATAL_ERROR_CODES`).
    public static let fatal: Set<SignalingErrorCode> = [
        .invalidToken, .tokenExpired, .tokenRevoked, .unauthorized, .roomNotFound,
        .permissionDenied, .originNotAllowed, .usageLimitExceeded,
    ]

    public var isFatal: Bool { Self.fatal.contains(self) }
}

/// Why the server ended a session (`room.left.reason`, phase 1 §1.5).
public struct ServerLeaveReason: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }

    public static let removed: ServerLeaveReason = "REMOVED"
    public static let roomClosed: ServerLeaveReason = "ROOM_CLOSED"
    public static let tokenExpired: ServerLeaveReason = "TOKEN_EXPIRED"
    public static let tokenRevoked: ServerLeaveReason = "TOKEN_REVOKED"
}

/// The SFU's connection-quality score (phase 2 §3).
public enum ConnectionQuality: String, Codable, Sendable, CaseIterable {
    case excellent, good, poor, lost
    /// Not scored yet, or a server that does not score. Never on the wire.
    case unknown
}

/// The forwarding state of one subscription (phase 2 §4).
public enum TrackSubscriptionState: String, Codable, Sendable, CaseIterable {
    case active
    case pausedBandwidth = "paused_bandwidth"
    case pausedClient = "paused_client"
}

/// Close codes the client acts on (docs/rtc/signaling.md, "Close codes").
public enum CloseCode {
    public static let normal = 1000
    public static let abnormal = 1006
    /// API instance restarting: reconnect now (0-2 s jitter) with resume.
    public static let serviceRestart = 1012
    /// Authentication failed. Refresh the token, then reconnect.
    public static let authFailed = 4001
    /// Replaced by a newer connection for the same identity. Do nothing.
    public static let replaced = 4002
    /// Removed, or the room closed. Never reconnect.
    public static let removed = 4003
    /// The SFU node went away. Reconnect and rejoin; no resume.
    public static let nodeLost = 4004
    /// Connection-level rate limit. Back off.
    public static let rateLimited = 4029
}

// MARK: - Client → server

public struct RoomJoinMessage: Codable, Equatable, Sendable {
    public struct Resume: Codable, Equatable, Sendable {
        public var token: String
        public init(token: String) { self.token = token }
    }

    public var roomId: String?
    public var region: String?
    public var resume: Resume?
    /// Sent only as `false` (phase 2 §4); absent means the server default.
    public var autoSubscribe: Bool?

    public init(roomId: String? = nil, region: String? = nil, resume: Resume? = nil, autoSubscribe: Bool? = nil) {
        self.roomId = roomId
        self.region = region
        self.resume = resume
        self.autoSubscribe = autoSubscribe
    }
}

public enum ClientMessage: Equatable, Sendable {
    case roomJoin(RoomJoinMessage)
    case roomLeave
    case tokenRefresh(token: String)
    case sdpAnswer(sdp: String)
    case sdpOffer(sdp: String)
    case iceCandidate(ICECandidatePayload)
    case trackPublish(trackId: String, source: TrackSource)
    case trackMute(trackId: String, muted: Bool)
    case subscriptionUpdate(publisherId: String, trackId: String, layer: SubscriptionLayer)
    /// Phase 7 §2: change this participant's own metadata and/or attributes.
    case participantUpdate(metadata: String?, attributes: [String: String]?)
    case ping

    public var type: String {
        switch self {
        case .roomJoin: return "room.join"
        case .roomLeave: return "room.leave"
        case .tokenRefresh: return "token.refresh"
        case .sdpAnswer: return "sdp.answer"
        case .sdpOffer: return "sdp.offer"
        case .iceCandidate: return "ice.candidate"
        case .trackPublish: return "track.publish"
        case .trackMute: return "track.mute"
        case .subscriptionUpdate: return "subscription.update"
        case .participantUpdate: return "participant.update"
        case .ping: return "ping"
        }
    }
}

extension ClientMessage: Codable {
    private enum Keys: String, CodingKey {
        case type, token, sdp, trackId, source, muted, publisherId, layer, metadata, attributes
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(type, forKey: .type)
        switch self {
        case let .roomJoin(join):
            try join.encode(to: encoder)
        case .roomLeave, .ping:
            break
        case let .tokenRefresh(token):
            try c.encode(token, forKey: .token)
        case let .sdpAnswer(sdp), let .sdpOffer(sdp):
            try c.encode(sdp, forKey: .sdp)
        case let .iceCandidate(candidate):
            try candidate.encode(to: encoder)
        case let .trackPublish(trackId, source):
            try c.encode(trackId, forKey: .trackId)
            try c.encode(source, forKey: .source)
        case let .trackMute(trackId, muted):
            try c.encode(trackId, forKey: .trackId)
            try c.encode(muted, forKey: .muted)
        case let .subscriptionUpdate(publisherId, trackId, layer):
            try c.encode(publisherId, forKey: .publisherId)
            try c.encode(trackId, forKey: .trackId)
            try c.encode(layer, forKey: .layer)
        case let .participantUpdate(metadata, attributes):
            try c.encodeIfPresent(metadata, forKey: .metadata)
            try c.encodeIfPresent(attributes, forKey: .attributes)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "room.join": self = .roomJoin(try RoomJoinMessage(from: decoder))
        case "room.leave": self = .roomLeave
        case "token.refresh": self = .tokenRefresh(token: try c.decode(String.self, forKey: .token))
        case "sdp.answer": self = .sdpAnswer(sdp: try c.decode(String.self, forKey: .sdp))
        case "sdp.offer": self = .sdpOffer(sdp: try c.decode(String.self, forKey: .sdp))
        case "ice.candidate": self = .iceCandidate(try ICECandidatePayload(from: decoder))
        case "track.publish":
            self = .trackPublish(trackId: try c.decode(String.self, forKey: .trackId),
                                 source: try c.decode(TrackSource.self, forKey: .source))
        case "track.mute":
            self = .trackMute(trackId: try c.decode(String.self, forKey: .trackId),
                              muted: try c.decode(Bool.self, forKey: .muted))
        case "subscription.update":
            self = .subscriptionUpdate(publisherId: try c.decode(String.self, forKey: .publisherId),
                                       trackId: try c.decode(String.self, forKey: .trackId),
                                       layer: try c.decode(SubscriptionLayer.self, forKey: .layer))
        case "participant.update":
            self = .participantUpdate(metadata: try c.decodeIfPresent(String.self, forKey: .metadata),
                                      attributes: try c.decodeIfPresent([String: String].self, forKey: .attributes))
        case "ping": self = .ping
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown client message type \(type)")
        }
    }
}

// MARK: - Server → client

public struct RoomJoinedMessage: Codable, Equatable, Sendable {
    public var roomId: String
    public var participants: [ServerParticipant]
    /// The node's *name*, for diagnostics. Never its address.
    public var rtcServer: String?
    public var region: String?
    /// Phase 5 §1.5.
    public var clientRegion: String?
    /// Opaque. Keep the latest; it lets a reconnect resume this session.
    public var resumeToken: String?
    /// Present only when the join asked to resume.
    public var resumed: Bool?
    /// Phase 5 §3.1: the room requires end-to-end encryption.
    public var e2ee: Bool?
    /// Phase 7: what the server supports, e.g. `"data.v2"`. Nil from older servers.
    public var capabilities: [String]?

    public init(roomId: String, participants: [ServerParticipant] = [], rtcServer: String? = nil, region: String? = nil,
                clientRegion: String? = nil, resumeToken: String? = nil, resumed: Bool? = nil, e2ee: Bool? = nil,
                capabilities: [String]? = nil) {
        self.roomId = roomId
        self.participants = participants
        self.rtcServer = rtcServer
        self.region = region
        self.clientRegion = clientRegion
        self.resumeToken = resumeToken
        self.resumed = resumed
        self.e2ee = e2ee
        self.capabilities = capabilities
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        roomId = try c.decodeIfPresent(String.self, forKey: .roomId) ?? ""
        participants = try c.decodeIfPresent([ServerParticipant].self, forKey: .participants) ?? []
        rtcServer = try c.decodeIfPresent(String.self, forKey: .rtcServer)
        region = try c.decodeIfPresent(String.self, forKey: .region)
        clientRegion = try c.decodeIfPresent(String.self, forKey: .clientRegion)
        resumeToken = try c.decodeIfPresent(String.self, forKey: .resumeToken)
        resumed = try c.decodeIfPresent(Bool.self, forKey: .resumed)
        e2ee = try c.decodeIfPresent(Bool.self, forKey: .e2ee)
        capabilities = try? c.decodeIfPresent([String].self, forKey: .capabilities)
    }
}

public struct SpeakerEntry: Codable, Equatable, Sendable {
    public var participantId: String
    /// 0..1, clamped on decode.
    public var level: Double

    public init(participantId: String, level: Double) {
        self.participantId = participantId
        self.level = level
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        participantId = try c.decode(String.self, forKey: .participantId)
        let raw = try c.decodeIfPresent(Double.self, forKey: .level) ?? 0
        level = raw.isFinite ? min(1, max(0, raw)) : 0
    }
}

public struct QualityUpdate: Codable, Equatable, Sendable {
    public var participantId: String
    public var quality: ConnectionQuality
    public init(participantId: String, quality: ConnectionQuality) {
        self.participantId = participantId
        self.quality = quality
    }
}

public struct LayerActivity: Codable, Equatable, Sendable {
    public var rid: String
    public var active: Bool
    public init(rid: String, active: Bool) {
        self.rid = rid
        self.active = active
    }
}

public struct SubscriptionStateMessage: Codable, Equatable, Sendable {
    public var publisherId: String
    public var trackId: String
    public var state: TrackSubscriptionState
    /// The layer being forwarded (`low`/`medium`/`high`), when active.
    public var layer: String?

    public init(publisherId: String, trackId: String, state: TrackSubscriptionState, layer: String? = nil) {
        self.publisherId = publisherId
        self.trackId = trackId
        self.state = state
        self.layer = layer
    }
}

public enum ServerMessage: Equatable, Sendable {
    case roomJoined(RoomJoinedMessage)
    case roomLeft(roomId: String?, reason: ServerLeaveReason?)
    case roomResumeToken(String)
    case participantJoined(ServerParticipant)
    case participantLeft(ServerParticipant)
    case trackPublished(participantId: String, track: ServerTrack)
    case trackUnpublished(participantId: String, trackId: String)
    case trackMuted(participantId: String, trackId: String, byServer: Bool)
    case trackUnmuted(participantId: String, trackId: String, byServer: Bool)
    case sdpOffer(sdp: String)
    case sdpAnswer(sdp: String)
    case iceCandidate(ICECandidatePayload)
    case connectionState(iceState: String, peerState: String)
    case error(code: SignalingErrorCode, message: String)
    case pong
    case tokenExpiring(expiresAt: String)
    case tokenRefreshed(expiresAt: String)
    case permissionsUpdated(ParticipantPermissions)
    case speakersChanged([SpeakerEntry])
    case qualityChanged([QualityUpdate])
    case subscriptionState(SubscriptionStateMessage)
    case publisherLayers(trackId: String, layers: [LayerActivity])
    /// Phase 7 §2: a participant's metadata or attributes changed.
    case participantUpdated(ParticipantUpdate)
    /// Phase 7 §1.4: the SFU dropped some of this participant's data
    /// messages for going over the rate limit.
    case dataThrottled(channel: DataChannelKind)
    /// Phase 6 §4.1: a live caption segment (interim or final).
    case transcriptionSegment(TranscriptionSegment)
    /// Phase 6 §4.3: the room's transcription changed status.
    case transcriptionState(TranscriptionState)
    /// Phase 6 §4.2: an AI agent's live state.
    case agentState(AgentStateUpdate)
    /// A message type this SDK does not know. Ignored, per the protocol's
    /// versioning rule.
    case unknown(type: String)

    public var type: String {
        switch self {
        case .roomJoined: return "room.joined"
        case .roomLeft: return "room.left"
        case .roomResumeToken: return "room.resume_token"
        case .participantJoined: return "participant.joined"
        case .participantLeft: return "participant.left"
        case .trackPublished: return "track.published"
        case .trackUnpublished: return "track.unpublished"
        case .trackMuted: return "track.muted"
        case .trackUnmuted: return "track.unmuted"
        case .sdpOffer: return "sdp.offer"
        case .sdpAnswer: return "sdp.answer"
        case .iceCandidate: return "ice.candidate"
        case .connectionState: return "connection.state"
        case .error: return "error"
        case .pong: return "pong"
        case .tokenExpiring: return "token.expiring"
        case .tokenRefreshed: return "token.refreshed"
        case .permissionsUpdated: return "participant.permissions_updated"
        case .speakersChanged: return "speakers.changed"
        case .qualityChanged: return "quality.changed"
        case .subscriptionState: return "subscription.state"
        case .publisherLayers: return "publisher.layers"
        case .participantUpdated: return "participant.updated"
        case .dataThrottled: return "data.throttled"
        case .transcriptionSegment: return "transcription.segment"
        case .transcriptionState: return "transcription.state"
        case .agentState: return "agent.state"
        case let .unknown(type): return type
        }
    }
}

extension ServerMessage: Codable {
    private enum Keys: String, CodingKey {
        case type, roomId, reason, resumeToken, participant, participantId, track, trackId, byServer, sdp
        case iceState, peerState, code, message, expiresAt, permissions, speakers, updates, layers
        case metadata, attributes, channel
    }

    /// Quality entries with a value this SDK does not know are dropped, not
    /// failed (phase 2 §0: the API drops them too).
    private struct LenientQuality: Decodable {
        let value: QualityUpdate?
        private enum K: String, CodingKey { case participantId, quality }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            guard let id = try? c.decode(String.self, forKey: .participantId),
                  let raw = try? c.decode(String.self, forKey: .quality),
                  let quality = ConnectionQuality(rawValue: raw), quality != .unknown
            else {
                value = nil
                return
            }
            value = QualityUpdate(participantId: id, quality: quality)
        }
    }

    private struct LenientLayer: Decodable {
        let value: LayerActivity?
        private enum K: String, CodingKey { case rid, active }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            guard let rid = try? c.decode(String.self, forKey: .rid),
                  let active = try? c.decode(Bool.self, forKey: .active)
            else {
                value = nil
                return
            }
            value = LayerActivity(rid: rid, active: active)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "room.joined":
            self = .roomJoined(try RoomJoinedMessage(from: decoder))
        case "room.left":
            self = .roomLeft(roomId: try c.decodeIfPresent(String.self, forKey: .roomId),
                             reason: try c.decodeIfPresent(ServerLeaveReason.self, forKey: .reason))
        case "room.resume_token":
            self = .roomResumeToken(try c.decode(String.self, forKey: .resumeToken))
        case "participant.joined":
            self = .participantJoined(try c.decode(ServerParticipant.self, forKey: .participant))
        case "participant.left":
            self = .participantLeft(try c.decode(ServerParticipant.self, forKey: .participant))
        case "track.published":
            self = .trackPublished(participantId: try c.decode(String.self, forKey: .participantId),
                                   track: try c.decode(ServerTrack.self, forKey: .track))
        case "track.unpublished":
            self = .trackUnpublished(participantId: try c.decode(String.self, forKey: .participantId),
                                     trackId: try c.decode(String.self, forKey: .trackId))
        case "track.muted", "track.unmuted":
            let pid = try c.decode(String.self, forKey: .participantId)
            let tid = try c.decode(String.self, forKey: .trackId)
            let byServer = try c.decodeIfPresent(Bool.self, forKey: .byServer) ?? false
            self = type == "track.muted"
                ? .trackMuted(participantId: pid, trackId: tid, byServer: byServer)
                : .trackUnmuted(participantId: pid, trackId: tid, byServer: byServer)
        case "sdp.offer":
            self = .sdpOffer(sdp: try c.decode(String.self, forKey: .sdp))
        case "sdp.answer":
            self = .sdpAnswer(sdp: try c.decode(String.self, forKey: .sdp))
        case "ice.candidate":
            self = .iceCandidate(try ICECandidatePayload(from: decoder))
        case "connection.state":
            self = .connectionState(iceState: try c.decodeIfPresent(String.self, forKey: .iceState) ?? "",
                                    peerState: try c.decodeIfPresent(String.self, forKey: .peerState) ?? "")
        case "error":
            self = .error(code: try c.decode(SignalingErrorCode.self, forKey: .code),
                          message: try c.decodeIfPresent(String.self, forKey: .message) ?? "")
        case "pong":
            self = .pong
        case "token.expiring":
            self = .tokenExpiring(expiresAt: try c.decode(String.self, forKey: .expiresAt))
        case "token.refreshed":
            self = .tokenRefreshed(expiresAt: try c.decode(String.self, forKey: .expiresAt))
        case "participant.permissions_updated":
            self = .permissionsUpdated(try c.decode(ParticipantPermissions.self, forKey: .permissions))
        case "speakers.changed":
            self = .speakersChanged(Array(try c.decode([SpeakerEntry].self, forKey: .speakers).prefix(8)))
        case "quality.changed":
            self = .qualityChanged(try c.decode([LenientQuality].self, forKey: .updates).compactMap(\.value))
        case "subscription.state":
            self = .subscriptionState(try SubscriptionStateMessage(from: decoder))
        case "publisher.layers":
            self = .publisherLayers(trackId: try c.decode(String.self, forKey: .trackId),
                                    layers: try c.decode([LenientLayer].self, forKey: .layers).compactMap(\.value))
        case "participant.updated":
            let includesMetadata = c.contains(.metadata)
            let metadata = includesMetadata ? try? c.decodeIfPresent(String.self, forKey: .metadata) : nil
            let attributes = (try? c.decodeIfPresent([String: String?].self, forKey: .attributes))?.compactMapValues { $0 }
            self = .participantUpdated(ParticipantUpdate(participantId: try c.decode(String.self, forKey: .participantId),
                                                         metadata: metadata, attributes: attributes,
                                                         includesMetadata: includesMetadata))
        case "data.throttled":
            let raw = try c.decodeIfPresent(String.self, forKey: .channel) ?? ""
            self = .dataThrottled(channel: DataChannelKind(rawValue: raw) ?? .reliable)
        // Phase 6: a malformed frame, or a status/state this SDK does not
        // know, is ignored like an unknown type rather than failing.
        case "transcription.segment":
            if let segment = try? TranscriptionSegment(from: decoder) { self = .transcriptionSegment(segment) } else { self = .unknown(type: type) }
        case "transcription.state":
            if let state = try? TranscriptionState(from: decoder) { self = .transcriptionState(state) } else { self = .unknown(type: type) }
        case "agent.state":
            if let update = try? AgentStateUpdate(from: decoder) { self = .agentState(update) } else { self = .unknown(type: type) }
        default:
            self = .unknown(type: type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(type, forKey: .type)
        switch self {
        case let .roomJoined(joined):
            try joined.encode(to: encoder)
        case let .roomLeft(roomId, reason):
            try c.encodeIfPresent(roomId, forKey: .roomId)
            try c.encodeIfPresent(reason, forKey: .reason)
        case let .roomResumeToken(token):
            try c.encode(token, forKey: .resumeToken)
        case let .participantJoined(p), let .participantLeft(p):
            try c.encode(p, forKey: .participant)
        case let .trackPublished(pid, track):
            try c.encode(pid, forKey: .participantId)
            try c.encode(track, forKey: .track)
        case let .trackUnpublished(pid, tid):
            try c.encode(pid, forKey: .participantId)
            try c.encode(tid, forKey: .trackId)
        case let .trackMuted(pid, tid, byServer), let .trackUnmuted(pid, tid, byServer):
            try c.encode(pid, forKey: .participantId)
            try c.encode(tid, forKey: .trackId)
            if byServer { try c.encode(true, forKey: .byServer) }
        case let .sdpOffer(sdp), let .sdpAnswer(sdp):
            try c.encode(sdp, forKey: .sdp)
        case let .iceCandidate(candidate):
            try candidate.encode(to: encoder)
        case let .connectionState(ice, peer):
            try c.encode(ice, forKey: .iceState)
            try c.encode(peer, forKey: .peerState)
        case let .error(code, message):
            try c.encode(code, forKey: .code)
            try c.encode(message, forKey: .message)
        case .pong, .unknown:
            break
        case let .tokenExpiring(at), let .tokenRefreshed(at):
            try c.encode(at, forKey: .expiresAt)
        case let .permissionsUpdated(p):
            try c.encode(p, forKey: .permissions)
        case let .speakersChanged(s):
            try c.encode(s, forKey: .speakers)
        case let .qualityChanged(u):
            try c.encode(u, forKey: .updates)
        case let .subscriptionState(s):
            try s.encode(to: encoder)
        case let .publisherLayers(tid, layers):
            try c.encode(tid, forKey: .trackId)
            try c.encode(layers, forKey: .layers)
        case let .participantUpdated(update):
            try c.encode(update.participantId, forKey: .participantId)
            if update.includesMetadata {
                if let metadata = update.metadata { try c.encode(metadata, forKey: .metadata) } else { try c.encodeNil(forKey: .metadata) }
            }
            try c.encodeIfPresent(update.attributes, forKey: .attributes)
        case let .dataThrottled(channel):
            try c.encode(channel, forKey: .channel)
        case let .transcriptionSegment(segment):
            try segment.encode(to: encoder)
        case let .transcriptionState(state):
            try state.encode(to: encoder)
        case let .agentState(update):
            try update.encode(to: encoder)
        }
    }
}

// MARK: - JSON helpers

enum SignalingCoder {
    static func encode(_ message: ClientMessage) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(message)
        return String(decoding: data, as: UTF8.self)
    }

    static func decode(_ text: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(text.utf8))
    }
}
