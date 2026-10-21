import Foundation
import LiveKitWebRTC

/// What the media engine reports to the room.
enum MediaEngineEvent {
    /// A remote track arrived. `trackId` is the msid track id the SFU
    /// stamped on it — the publisher's id — or the receiver's own id when
    /// the SDP carried none.
    case remoteTrackAdded(trackId: String, track: RTCMediaStreamTrack?)
    case remoteTrackRemoved(trackId: String)
    case connectionStateChanged(MediaConnectionState)
    case dataReceived(Data)
    /// The id the SFU will see for a publication differs from the one
    /// declared; `track.publish` has already been re-sent under `newId`.
    case publicationIdChanged(oldId: String, newId: String)
    case error(RTCError)
}

enum MediaConnectionState: String, Sendable {
    case new, connecting, connected, disconnected, failed, closed
}

/// One local publication, as the engine needs it.
struct EnginePublication {
    var trackId: String
    var source: TrackSource
    var track: RTCMediaStreamTrack?
    var simulcast: Bool
}

/// The PeerConnection side of a room: a single PeerConnection to the SFU.
///
/// A protocol so the `Room`'s event mapping can be tested with a fake,
/// with no WebRTC stack and no network.
@MainActor
protocol MediaEngine: AnyObject {
    /// Messages the engine needs sent (answers, offers, candidates,
    /// `track.publish` declarations), in order.
    var sendSignal: ((ClientMessage) -> Void)? { get set }
    var onEvent: ((MediaEngineEvent) -> Void)? { get set }

    var iceConnectionState: String? { get }
    var signalingState: String? { get }

    /// Tears down any existing PeerConnection and starts a new one (first
    /// join, or `room.joined { resumed: false }`). Publications are
    /// re-attached by the caller.
    func resetPeerConnection(iceServers: [ICEServer])
    func handleRemoteOffer(_ sdp: String) async
    func handleRemoteAnswer(_ sdp: String) async
    func handleRemoteCandidate(_ candidate: ICECandidatePayload) async
    /// The server refused our offer with `NEGOTIATION_GLARE`: answer its
    /// offer (already in flight), then offer again.
    func handleGlare()
    func publish(_ publication: EnginePublication) async throws
    func unpublish(trackId: String) async
    /// Dynacast (phase 2 §5).
    func applyPublisherLayers(trackId: String, layers: [LayerActivity])
    /// Whether the published camera genuinely negotiated the ladder.
    func simulcastConfirmed(trackId: String) -> Bool?
    /// Sends on `raven-data`, or on `raven-data-lossy` when `lossy` (opening
    /// either on first use).
    func sendData(_ data: Data, lossy: Bool) throws
    /// Opens `raven-data` and `raven-data-lossy` now (phase 7 §1.1: a
    /// `data.v2` room opens both at connect, so the SFU frames deliveries).
    func openDataChannels()
    func restartIce()
    func close()

    /// Phase 5 §3: when set, every sender gets an encrypting frame cryptor
    /// before it negotiates, and every subscribed receiver a decrypting one.
    /// Setting it attaches cryptors to what already exists; nil detaches.
    var frameEncryption: E2EEFrameEncryption? { get set }
    /// The room matched a remote track to its publisher, so the receiver's
    /// cryptor can be keyed for that participant.
    func remoteTrackSubscribed(trackId: String, participantId: String)
}

/// An ICE server from the token-mint response (`iceServers`).
public struct ICEServer: Codable, Equatable, Sendable {
    public var urls: [String]
    public var username: String?
    public var credential: String?

    public init(urls: [String], username: String? = nil, credential: String? = nil) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }

    /// Accepts `urls` as a string or an array, like the mint response and
    /// the browser's `RTCIceServer`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let many = try? c.decode([String].self, forKey: .urls) {
            urls = many
        } else {
            urls = [try c.decode(String.self, forKey: .urls)]
        }
        username = try c.decodeIfPresent(String.self, forKey: .username)
        credential = try c.decodeIfPresent(String.self, forKey: .credential)
    }
}
