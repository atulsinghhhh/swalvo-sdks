import Foundation
import LiveKitWebRTC
import Testing
@testable import SwalvoRTC

/// Polls `condition` until true or `timeout` passes.
func waitUntil(_ timeout: TimeInterval = 3, sourceLocation: SourceLocation = #_sourceLocation,
               _ condition: @escaping () async -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    Issue.record("timed out waiting for condition", sourceLocation: sourceLocation)
}

/// A JWT-shaped token with the given claims (unsigned; the SDK never verifies).
func makeToken(sub: String = "alice", rid: String = "room_123", rnm: String? = "standup", exp: TimeInterval? = nil,
               e2ee: Bool = false, extra: [String: Any] = [:]) -> String {
    var claims: [String: Any] = ["sub": sub, "rid": rid, "exp": exp ?? Date().addingTimeInterval(3600).timeIntervalSince1970]
    if let rnm { claims["rnm"] = rnm }
    if e2ee { claims["e2ee"] = true }
    claims.merge(extra) { _, new in new }
    func b64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    let header = b64(Data(#"{"alg":"HS256","typ":"JWT"}"#.utf8))
    let payload = b64(try! JSONSerialization.data(withJSONObject: claims))
    return "\(header).\(payload).sig"
}

/// A scripted server side of one WebSocket.
final class FakeConnection: WebSocketConnection, @unchecked Sendable {
    let url: URL
    let events: AsyncStream<WebSocketEvent>
    private let continuation: AsyncStream<WebSocketEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [String] = []
    private var _closed = false
    private(set) var clientCloseCode: Int?

    init(url: URL) {
        self.url = url
        var cont: AsyncStream<WebSocketEvent>.Continuation!
        events = AsyncStream(bufferingPolicy: .unbounded) { cont = $0 }
        continuation = cont
    }

    var sent: [String] {
        lock.lock(); defer { lock.unlock() }
        return _sent
    }

    /// Sent frames decoded back into client messages.
    var sentMessages: [ClientMessage] {
        sent.compactMap { try? JSONDecoder().decode(ClientMessage.self, from: Data($0.utf8)) }
    }

    var sentJSON: [[String: Any]] {
        sent.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }

    var isClosed: Bool {
        lock.lock(); defer { lock.unlock() }
        return _closed
    }

    func send(_ text: String) {
        lock.lock()
        _sent.append(text)
        lock.unlock()
    }

    func close(code: Int, reason: String?) {
        lock.lock()
        clientCloseCode = code
        lock.unlock()
        finish(code: code)
    }

    /// The server sends a frame.
    func serverSend(_ json: String) {
        continuation.yield(.text(json))
    }

    /// The server closes with `code`.
    func serverClose(_ code: Int) {
        finish(code: code)
    }

    private func finish(code: Int) {
        lock.lock()
        let already = _closed
        _closed = true
        lock.unlock()
        guard !already else { return }
        continuation.yield(.closed(code: code, reason: nil))
        continuation.finish()
    }
}

final class FakeSocketFactory: WebSocketFactory, @unchecked Sendable {
    private let lock = NSLock()
    private var _connections: [FakeConnection] = []
    /// When set, `open` fails this many times before succeeding.
    var failOpens = 0

    var connections: [FakeConnection] {
        lock.lock(); defer { lock.unlock() }
        return _connections
    }

    func open(url: URL, timeout: TimeInterval) async throws -> WebSocketConnection {
        lock.lock()
        if failOpens > 0 {
            failOpens -= 1
            lock.unlock()
            throw RTCError(.networkError, "fake open failure")
        }
        let connection = FakeConnection(url: url)
        _connections.append(connection)
        lock.unlock()
        return connection
    }

    func connection(_ index: Int) async -> FakeConnection {
        await waitUntil { self.connections.count > index }
        return connections[index]
    }
}

/// Collects events from an AsyncStream.
final class Recorder<Event: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [Event] = []
    private var task: Task<Void, Never>?

    init(_ stream: AsyncStream<Event>) {
        task = Task { [weak self] in
            for await event in stream {
                self?.append(event)
            }
        }
    }

    private func append(_ event: Event) {
        lock.lock(); _events.append(event); lock.unlock()
    }

    var events: [Event] {
        lock.lock(); defer { lock.unlock() }
        return _events
    }
}

/// Signaling timings that make the reconnect schedule fast.
func fastTimings() -> SignalingTimings {
    var timings = SignalingTimings()
    timings.openTimeout = 5
    timings.joinTimeout = 5
    timings.reconnectBase = 0.002
    timings.reconnectMax = 0.02
    timings.serviceRestartJitter = 0.01
    return timings
}

func testEnvironment() -> SignalingEnvironment {
    var env = SignalingEnvironment()
    env.random = { 0.5 }
    return env
}

/// A media engine that records what the room asked of it.
@MainActor
final class FakeEngine: MediaEngine {
    var sendSignal: ((ClientMessage) -> Void)?
    var onEvent: ((MediaEngineEvent) -> Void)?
    var iceConnectionState: String?
    var signalingState: String?

    var resetCount = 0
    var offers: [String] = []
    var answers: [String] = []
    var candidates: [ICECandidatePayload] = []
    var glareCount = 0
    var published: [EnginePublication] = []
    var unpublished: [String] = []
    var layerFrames: [(String, [LayerActivity])] = []
    var closed = false
    var iceRestarts = 0
    /// Stand-ins for RTCRtpSender / RTCRtpReceiver, by track id.
    var senders: [String: NSObject] = [:]
    var receivers: [String: NSObject] = [:]
    var subscribedRemote: [String: String] = [:]

    var frameEncryption: E2EEFrameEncryption? {
        didSet {
            guard oldValue !== frameEncryption else { return }
            oldValue?.dispose()
            guard let frameEncryption else { return }
            for publication in published { _ = frameEncryption.attachSender(sender(publication.trackId)) }
            for (trackId, participantId) in subscribedRemote {
                if let receiver = receivers[trackId] { _ = frameEncryption.attachReceiver(receiver, participantId: participantId) }
            }
        }
    }

    func sender(_ trackId: String) -> NSObject {
        if let existing = senders[trackId] { return existing }
        let sender = NSObject()
        senders[trackId] = sender
        return sender
    }

    func remoteTrackSubscribed(trackId: String, participantId: String) {
        subscribedRemote[trackId] = participantId
        if let receiver = receivers[trackId] { _ = frameEncryption?.attachReceiver(receiver, participantId: participantId) }
    }

    func resetPeerConnection(iceServers: [ICEServer]) {
        resetCount += 1
        for publication in published {
            sendSignal?(.trackPublish(trackId: publication.trackId, source: publication.source))
        }
    }

    func handleRemoteOffer(_ sdp: String) async {
        offers.append(sdp)
        sendSignal?(.sdpAnswer(sdp: "answer-to:" + sdp))
    }

    func handleRemoteAnswer(_ sdp: String) async { answers.append(sdp) }
    func handleRemoteCandidate(_ candidate: ICECandidatePayload) async { candidates.append(candidate) }
    func handleGlare() { glareCount += 1 }

    func publish(_ publication: EnginePublication) async throws {
        published.append(publication)
        _ = frameEncryption?.attachSender(sender(publication.trackId))
        sendSignal?(.trackPublish(trackId: publication.trackId, source: publication.source))
        sendSignal?(.sdpOffer(sdp: "offer-for:" + publication.trackId))
    }

    func unpublish(trackId: String) async {
        unpublished.append(trackId)
        published.removeAll { $0.trackId == trackId }
        if let sender = senders.removeValue(forKey: trackId) { frameEncryption?.release(sender) }
    }

    func applyPublisherLayers(trackId: String, layers: [LayerActivity]) { layerFrames.append((trackId, layers)) }
    func simulcastConfirmed(trackId: String) -> Bool? { nil }
    /// What `sendData` was asked to send, and on which channel.
    var sentData: [(data: Data, lossy: Bool)] = []
    func sendData(_ data: Data, lossy: Bool) throws { sentData.append((data, lossy)) }
    var openDataChannelsCount = 0
    func openDataChannels() { openDataChannelsCount += 1 }

    /// Simulates a message arriving on a data channel.
    func deliverData(_ data: Data) {
        onEvent?(.dataReceived(data))
    }
    func restartIce() { iceRestarts += 1 }
    func close() {
        closed = true
        frameEncryption = nil
    }

    /// Simulates a remote track arriving on the PeerConnection.
    func deliverRemoteTrack(_ trackId: String) {
        if receivers[trackId] == nil { receivers[trackId] = NSObject() }
        onEvent?(.remoteTrackAdded(trackId: trackId, track: nil))
    }
}
