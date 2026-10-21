import Foundation

/// The room's connection state. Same values as the web SDK.
public enum ConnectionState: String, Sendable {
    case disconnected, connecting, connected, reconnecting, failed
}

/// Every event a `Room` emits. Names and payloads mirror the web SDK's
/// `RoomEventMap` (apps/docs/content/rtc/events.mdx), plus
/// `e2eeStateChanged` from phase 5 §3.2.
///
/// - Important: New cases are added in minor releases as the protocol
///   grows. When you `switch` over this exhaustively, end with
///   `@unknown default:` so a new case is a compiler warning, not a build
///   failure. (A plain `default:` also compiles but hides new cases.)
public enum RoomEvent: Sendable {
    // Connection
    case connectionStateChanged(ConnectionState)
    case connected
    /// The room is no longer connected and the SDK will not reconnect it.
    /// Never rejoin automatically after `.removed` or `.roomClosed`.
    case disconnected(reason: DisconnectReason)
    case reconnecting
    case reconnected
    case warning(RTCWarning)
    case error(RTCError)

    // Participants
    case participantJoined(RemoteParticipant)
    case participantLeft(RemoteParticipant)

    // Remote tracks
    case trackPublished(kind: TrackKind, participant: RemoteParticipant)
    case trackUnpublished(kind: TrackKind, participant: RemoteParticipant)
    case trackSubscribed(track: RemoteTrack, participant: RemoteParticipant)
    case trackUnsubscribed(track: RemoteTrack, participant: RemoteParticipant)
    case trackMuted(kind: TrackKind, participant: RemoteParticipant)
    case trackUnmuted(kind: TrackKind, participant: RemoteParticipant)

    // Speaking, quality, paused video (phase 2)
    /// Loudest first, at most 8, you included; empty means silence.
    case activeSpeakersChanged([Participant])
    /// `participant` may be the local participant.
    case connectionQualityChanged(participant: Participant, quality: ConnectionQuality)
    /// Read `track.subscriptionState` and `track.layer`.
    case trackSubscriptionStateChanged(track: RemoteTrack, participant: RemoteParticipant)

    // Your own tracks
    case localTrackPublished(LocalTrack)
    case localTrackUnpublished(LocalTrack)
    /// The server muted one of your tracks; it is already muted locally.
    case localTrackMutedByServer(LocalTrack)
    /// The server changed what you may do. Withdrawn publish rights have
    /// already stopped those tracks (each gets `localTrackUnpublished`).
    case permissionsChanged(ParticipantPermissions)

    // Participant metadata (phase 7 §2)
    /// `participant.metadata` or `.attributes` changed (it may be you).
    /// Carries the values from before.
    case participantMetadataChanged(participant: Participant, previousMetadata: String?, previousAttributes: [String: String])

    // Data
    /// A data message. `participant` is the sender as the SFU stamped it;
    /// nil for a message from the server, or from a server without
    /// `data.v2`. For the topic, handle `dataMessageReceived` instead —
    /// every message emits both, so handle one of the two.
    case dataReceived(Data, participant: RemoteParticipant?)
    /// The same message as `dataReceived`, with its topic and sender
    /// identity (phase 7 §1.6).
    case dataMessageReceived(DataMessage)
    /// The SFU dropped some of your data messages on `channel` for going
    /// over the rate limit (phase 7 §1.4: 100 msg/s and 1 MiB/s reliable,
    /// 300 msg/s lossy). Slow down.
    case dataThrottled(channel: DataChannelKind)

    // E2EE (phase 5 §3.2)
    case e2eeStateChanged(participant: Participant, state: E2EEState)

    // Transcription and AI agents (phase 6 §4)
    /// A live caption segment. Interim segments share `segmentId` and
    /// replace each other; the final one closes it. A final with empty
    /// `text` means "clear the interim". Agent speech arrives here too.
    case transcriptionSegment(TranscriptionSegment)
    /// The room's transcription changed status.
    case transcriptionStateChanged(TranscriptionState)
    /// An AI agent is listening, thinking, speaking, or has ended. Also
    /// readable as `participant.agentState`.
    case agentStateChanged(participant: Participant, state: AgentState)

    /// The web SDK's event name, for logging and cross-platform parity.
    public var name: String {
        switch self {
        case .connectionStateChanged: return "connectionStateChanged"
        case .connected: return "connected"
        case .disconnected: return "disconnected"
        case .reconnecting: return "reconnecting"
        case .reconnected: return "reconnected"
        case .warning: return "warning"
        case .error: return "error"
        case .participantJoined: return "participantJoined"
        case .participantLeft: return "participantLeft"
        case .trackPublished: return "trackPublished"
        case .trackUnpublished: return "trackUnpublished"
        case .trackSubscribed: return "trackSubscribed"
        case .trackUnsubscribed: return "trackUnsubscribed"
        case .trackMuted: return "trackMuted"
        case .trackUnmuted: return "trackUnmuted"
        case .activeSpeakersChanged: return "activeSpeakersChanged"
        case .connectionQualityChanged: return "connectionQualityChanged"
        case .trackSubscriptionStateChanged: return "trackSubscriptionStateChanged"
        case .localTrackPublished: return "localTrackPublished"
        case .localTrackUnpublished: return "localTrackUnpublished"
        case .localTrackMutedByServer: return "localTrackMutedByServer"
        case .permissionsChanged: return "permissionsChanged"
        case .participantMetadataChanged: return "participantMetadataChanged"
        case .dataReceived: return "dataReceived"
        case .dataMessageReceived: return "dataMessageReceived"
        case .dataThrottled: return "dataThrottled"
        case .e2eeStateChanged: return "e2eeStateChanged"
        case .transcriptionSegment: return "transcriptionSegment"
        case .transcriptionStateChanged: return "transcriptionStateChanged"
        case .agentStateChanged: return "agentStateChanged"
        }
    }
}

/// A received data message (phase 7 §1.3).
public struct DataMessage: Sendable {
    public let payload: Data
    /// The sender. Nil for a server message (`senderIdentity == ""`), a
    /// legacy message (`senderIdentity == nil`), or a sender who already left.
    public let participant: RemoteParticipant?
    /// The SFU-stamped sender identity: `""` is the server, nil a legacy
    /// message with no attribution.
    public let senderIdentity: String?
    /// The sender's topic; nil when it set none.
    public let topic: String?
}

/// Delegate-style alternative to `room.events()`. Called on the main actor.
@MainActor
public protocol RoomDelegate: AnyObject {
    func room(_ room: Room, didEmit event: RoomEvent)
}

/// A diagnostic snapshot that is safe to paste into a bug report.
public struct ConnectionDiagnostics: Sendable {
    public var connectionState: ConnectionState
    public var iceConnectionState: String?
    public var signalingState: String?
    /// What the SFU makes of this connection (`connection.state`).
    public var remoteIceConnectionState: String?
    public var remotePeerConnectionState: String?
    public var rtcServer: String?
    public var region: String?
    public var reconnectCount: Int
    public var sdkVersion: String
    public var platform: String
}
