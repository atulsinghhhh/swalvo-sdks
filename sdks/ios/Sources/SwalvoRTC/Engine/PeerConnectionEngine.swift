import Foundation
import LiveKitWebRTC

/// Process-wide WebRTC factory. One per process, as libwebrtc expects.
enum WebRTCFactory {
    /// A custom audio device (the broadcast extension's app audio) to build
    /// the factory with. Only honoured before `shared` is first used.
    @MainActor static var audioDevice: RTCAudioDevice?
    @MainActor private(set) static var isCreated = false

    @MainActor static let shared: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        isCreated = true
        let encoder = RTCDefaultVideoEncoderFactory()
        let decoder = RTCDefaultVideoDecoderFactory()
        if let audioDevice {
            return RTCPeerConnectionFactory(encoderFactory: encoder, decoderFactory: decoder, audioDevice: audioDevice)
        }
        return RTCPeerConnectionFactory(encoderFactory: encoder, decoderFactory: decoder)
    }()
}

/// The production `MediaEngine`: one `RTCPeerConnection` to the SFU.
///
/// # Negotiation
///
/// Both sides offer on one PeerConnection. The SFU offers at join, for every
/// subscription change and for server-driven ICE restarts (phase 1 §2.6 —
/// those are answered like any other offer). This engine offers when a local
/// track needs an m-section that does not exist yet. Every operation that
/// touches the signaling state runs through one serial queue, and glare is
/// resolved in the SFU's favour: our offer is rolled back, the SFU's is
/// answered, and our change is offered again afterwards.
///
/// DTLS: the SFU offers `actpass` and answers `passive`, so this side is
/// always the DTLS client; nothing here has to reason about roles.
@MainActor
final class PeerConnectionEngine: NSObject, MediaEngine {
    var sendSignal: ((ClientMessage) -> Void)?
    var onEvent: ((MediaEngineEvent) -> Void)?

    private let logger: RTCLogger
    private let preferredVideoCodec: String?
    private var pc: RTCPeerConnection?
    private var observer: Observer?
    private var queue = SerialTaskQueue()

    /// Remote candidates that arrived before a remote description.
    private var pendingCandidates: [ICECandidatePayload] = []
    private var awaitingAnswer = false
    private var negotiationNeeded = false

    private struct Published {
        var publication: EnginePublication
        var transceiver: RTCRtpTransceiver
        var simulcastConfirmed: Bool?
    }
    private var published: [String: Published] = [:]
    /// receiverId -> remote track id, for removals.
    private var remoteByReceiver: [String: String] = [:]
    /// Remote track id -> its receiver and (once the room knows) publisher.
    private var remoteReceivers: [String: (receiver: RTCRtpReceiver, participantId: String?)] = [:]

    var frameEncryption: E2EEFrameEncryption? {
        didSet {
            guard oldValue !== frameEncryption else { return }
            oldValue?.dispose()
            attachCryptors()
        }
    }
    private var dataChannel: RTCDataChannel?
    /// Phase 7 §1.1: unordered, `maxRetransmits: 0`. Opened lazily, and only
    /// when the room advertises `data.v2` (the room decides).
    private var lossyDataChannel: RTCDataChannel?
    // legacy: kept for wire compatibility (the SFU matches these labels).
    private static let dataChannelLabel = "raven-data"
    private static let lossyDataChannelLabel = "raven-data-lossy"

    private(set) var iceConnectionState: String?
    private(set) var signalingState: String?

    init(logger: RTCLogger, preferredVideoCodec: String? = nil) {
        self.logger = logger
        self.preferredVideoCodec = preferredVideoCodec
        super.init()
    }

    // MARK: Lifecycle

    func resetPeerConnection(iceServers: [ICEServer]) {
        closePeerConnection()
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.bundlePolicy = .maxBundle
        config.rtcpMuxPolicy = .require
        config.continualGatheringPolicy = .gatherContinually
        config.iceServers = iceServers.map {
            RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential)
        }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let observer = Observer(engine: self)
        guard let pc = WebRTCFactory.shared.peerConnection(with: config, constraints: constraints, delegate: observer) else {
            onEvent?(.error(RTCError(.mediaError, "Could not create a PeerConnection")))
            return
        }
        self.observer = observer
        self.pc = pc
        queue = SerialTaskQueue()
        pendingCandidates = []
        awaitingAnswer = false
        negotiationNeeded = false
        remoteByReceiver = [:]
        remoteReceivers = [:]
        // Cryptors belonged to the old PeerConnection's senders and receivers.
        frameEncryption?.resetConnection()
        // Publications survive a rebuild; their transceivers do not.
        let publications = published.values.map(\.publication)
        published = [:]
        for publication in publications {
            do {
                try attach(publication, to: pc)
            } catch {
                onEvent?(.error((error as? RTCError) ?? RTCError(.mediaError, "\(error)")))
            }
        }
        if !published.isEmpty { negotiationNeeded = true }
    }

    func close() {
        closePeerConnection()
        published = [:]
        remoteReceivers = [:]
        frameEncryption = nil  // disposes it
    }

    private func closePeerConnection() {
        dataChannel?.close()
        dataChannel = nil
        lossyDataChannel?.close()
        lossyDataChannel = nil
        pc?.close()
        pc = nil
        observer?.engine = nil
        observer = nil
    }

    // MARK: Remote descriptions

    func handleRemoteOffer(_ sdp: String) async {
        await queue.run { [weak self] in await self?.applyRemoteOffer(sdp) }
    }

    private func applyRemoteOffer(_ sdp: String) async {
        guard let pc else { return }
        do {
            if pc.signalingState == .haveLocalOffer {
                logger.debug("glare: rolling our offer back and answering the sfu")
                awaitingAnswer = false
                negotiationNeeded = true
                try await setLocal(pc, RTCSessionDescription(type: .rollback, sdp: ""))
            }
            try await setRemote(pc, RTCSessionDescription(type: .offer, sdp: sdp))
            await flushCandidates(pc)
            let answer = try await createAnswer(pc)
            try await setLocal(pc, answer)
            reconcilePublicationIds(pc)
            sendSignal?(.sdpAnswer(sdp: pc.localDescription?.sdp ?? answer.sdp))
        } catch {
            logger.error("failed to answer offer: \(error)")
            onEvent?(.error(RTCError(.mediaError, "Could not answer the server's offer: \(error.localizedDescription)")))
            return
        }
        await negotiateIfNeeded()
    }

    func handleRemoteAnswer(_ sdp: String) async {
        await queue.run { [weak self] in await self?.applyRemoteAnswer(sdp) }
    }

    private func applyRemoteAnswer(_ sdp: String) async {
        guard let pc else { return }
        guard pc.signalingState == .haveLocalOffer else {
            // An answer to an offer we rolled back for glare.
            logger.debug("discarding an answer for a superseded offer")
            return
        }
        do {
            try await setRemote(pc, RTCSessionDescription(type: .answer, sdp: sdp))
            awaitingAnswer = false
            await flushCandidates(pc)
            confirmSimulcast(pc)
        } catch {
            awaitingAnswer = false
            logger.error("failed to apply answer: \(error)")
        }
        await negotiateIfNeeded()
    }

    func handleRemoteCandidate(_ candidate: ICECandidatePayload) async {
        guard let pc else { return }
        if pc.remoteDescription == nil {
            // Adding a candidate before a remote description is an error.
            pendingCandidates.append(candidate)
            return
        }
        await addCandidate(pc, candidate)
    }

    private func flushCandidates(_ pc: RTCPeerConnection) async {
        let pending = pendingCandidates
        pendingCandidates = []
        for candidate in pending { await addCandidate(pc, candidate) }
    }

    private func addCandidate(_ pc: RTCPeerConnection, _ c: ICECandidatePayload) async {
        let candidate = RTCIceCandidate(sdp: c.candidate, sdpMLineIndex: Int32(c.sdpMLineIndex ?? 0), sdpMid: c.sdpMid)
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            pc.add(candidate) { [logger] error in
                // Candidates for a transceiver that is already gone are routine.
                if let error { logger.debug("ignoring ICE candidate: \(error.localizedDescription)") }
                cont.resume()
            }
        }
    }

    func handleGlare() {
        negotiationNeeded = true
        // The SFU's offer is in flight; answering it re-runs negotiateIfNeeded.
    }

    // MARK: Publishing

    func publish(_ publication: EnginePublication) async throws {
        guard let pc else { throw RTCError(.notConnected, "The media connection is not up") }
        try attach(publication, to: pc)
        negotiationNeeded = true
        await queue.run { [weak self] in await self?.negotiateIfNeeded() }
    }

    private func attach(_ publication: EnginePublication, to pc: RTCPeerConnection) throws {
        let initOptions = RTCRtpTransceiverInit()
        initOptions.direction = .sendOnly
        initOptions.streamIds = [publication.trackId]
        if publication.simulcast {
            initOptions.sendEncodings = Simulcast.layers.map { layer in
                let encoding = RTCRtpEncodingParameters()
                encoding.rid = layer.rid
                encoding.scaleResolutionDownBy = NSNumber(value: layer.scaleResolutionDownBy)
                encoding.maxBitrateBps = NSNumber(value: layer.maxBitrateBps)
                encoding.maxFramerate = NSNumber(value: layer.maxFramerate)
                encoding.isActive = true
                return encoding
            }
        }
        let transceiver: RTCRtpTransceiver?
        if let track = publication.track {
            transceiver = pc.addTransceiver(with: track, init: initOptions)
        } else {
            let type: RTCRtpMediaType = publication.source.isAudio ? .audio : .video
            transceiver = pc.addTransceiver(of: type, init: initOptions)
        }
        guard let transceiver else {
            sendSignal?(.trackPublish(trackId: publication.trackId, source: publication.source))
            onEvent?(.error(RTCError(.mediaError, "Could not add a transceiver for the \(publication.source.rawValue) track")))
            return
        }
        // Before the offer, so no frame leaves this sender unencrypted.
        // libwebrtc's cryptor needs the sender's track; a sender with no
        // track sends nothing, so it is safe without one.
        if let frameEncryption, publication.track != nil, frameEncryption.attachSender(transceiver.sender) == nil {
            transceiver.sender.track = nil
            pc.removeTrack(transceiver.sender)
            throw RTCError(.e2eeNotSupported, "Could not create a frame cryptor for the \(publication.source.rawValue) track; it is not published rather than sent unencrypted")
        }
        // Declared before negotiating, so the source is known by the time
        // media arrives (signaling.md, `track.publish`).
        sendSignal?(.trackPublish(trackId: publication.trackId, source: publication.source))
        applyCodecPreference(transceiver, source: publication.source)
        published[publication.trackId] = Published(publication: publication, transceiver: transceiver, simulcastConfirmed: nil)
    }

    /// Cryptors for every existing sender and identified receiver (E2EE
    /// switched on after media started).
    private func attachCryptors() {
        guard let frameEncryption else { return }
        for (id, entry) in published where entry.publication.track != nil {
            guard frameEncryption.attachSender(entry.transceiver.sender) == nil else { continue }
            // Never plaintext into an E2EE room: silence the sender instead.
            entry.transceiver.sender.track = nil
            onEvent?(.error(RTCError(.e2eeNotSupported, "Could not create a frame cryptor for \(id); its media is stopped")))
        }
        for (_, remote) in remoteReceivers {
            guard let participantId = remote.participantId else { continue }
            _ = frameEncryption.attachReceiver(remote.receiver, participantId: participantId)
        }
    }

    func remoteTrackSubscribed(trackId: String, participantId: String) {
        guard let remote = remoteReceivers[trackId] else { return }
        remoteReceivers[trackId]?.participantId = participantId
        _ = frameEncryption?.attachReceiver(remote.receiver, participantId: participantId)
    }

    private func applyCodecPreference(_ transceiver: RTCRtpTransceiver, source: TrackSource) {
        if source.isAudio {
            // Phase 5 §3: no RED while encrypting. The frame cryptor would see
            // the RED-wrapped payload rather than the Opus frame (the web and
            // Flutter SDKs drop RED for the same reason).
            guard frameEncryption != nil else { return }
            let codecs = WebRTCFactory.shared.rtpSenderCapabilities(forKind: kRTCMediaStreamTrackKindAudio).codecs
            let withoutRed = codecs.filter { $0.name.lowercased() != "red" }
            guard withoutRed.count != codecs.count else { return }
            do {
                try transceiver.setCodecPreferences(withoutRed, error: ())
            } catch {
                logger.debug("could not drop RED for an encrypted microphone: \(error.localizedDescription)")
            }
            return
        }
        guard let preferred = preferredVideoCodec?.lowercased() else { return }
        let capabilities = WebRTCFactory.shared.rtpSenderCapabilities(forKind: kRTCMediaStreamTrackKindVideo)
        let first = capabilities.codecs.filter { $0.name.lowercased() == preferred }
        guard !first.isEmpty else { return }
        let rest = capabilities.codecs.filter { $0.name.lowercased() != preferred }
        // `setCodecPreferences:error:` clashes with the deprecated void form,
        // so Swift imports it with a placeholder `error: ()` argument. It is
        // best-effort: an unsupported codec keeps the default order.
        do {
            try transceiver.setCodecPreferences(first + rest, error: ())
        } catch {
            logger.debug("codec preference \(preferred) not applied: \(error.localizedDescription)")
        }
    }

    func unpublish(trackId: String) async {
        guard let entry = published.removeValue(forKey: trackId) else { return }
        frameEncryption?.release(entry.transceiver.sender)
        if let pc {
            pc.removeTrack(entry.transceiver.sender)
            negotiationNeeded = true
            await queue.run { [weak self] in await self?.negotiateIfNeeded() }
        }
    }

    func simulcastConfirmed(trackId: String) -> Bool? {
        published[trackId]?.simulcastConfirmed
    }

    /// Offers when something of ours is not negotiated yet, and the
    /// connection is stable. Runs inside the serial queue.
    private func negotiateIfNeeded() async {
        guard let pc, negotiationNeeded, !awaitingAnswer else { return }
        guard pc.signalingState == .stable else { return }
        negotiationNeeded = false
        do {
            let offer = try await createOffer(pc, iceRestart: false)
            try await setLocal(pc, offer)
            reconcilePublicationIds(pc)
            awaitingAnswer = true
            sendSignal?(.sdpOffer(sdp: pc.localDescription?.sdp ?? offer.sdp))
        } catch {
            negotiationNeeded = true
            onEvent?(.error(RTCError(.mediaError, "Could not negotiate the published track: \(error.localizedDescription)")))
        }
    }

    /// Re-declares a publication when the msid on the wire differs from the
    /// id we declared (a reused transceiver can keep the SFU's msid).
    private func reconcilePublicationIds(_ pc: RTCPeerConnection) {
        guard let sdp = pc.localDescription?.sdp else { return }
        for (id, entry) in published {
            let mid = entry.transceiver.mid
            guard !mid.isEmpty, let onWire = SDPUtilities.msidTrackId(forMid: mid, in: sdp), onWire != id else { continue }
            var updated = entry
            updated.publication.trackId = onWire
            published.removeValue(forKey: id)
            published[onWire] = updated
            sendSignal?(.trackPublish(trackId: onWire, source: entry.publication.source))
            onEvent?(.publicationIdChanged(oldId: id, newId: onWire))
        }
    }

    private func confirmSimulcast(_ pc: RTCPeerConnection) {
        for (id, entry) in published where entry.publication.simulcast {
            let rids = entry.transceiver.sender.parameters.encodings.compactMap(\.rid)
            let complete = Simulcast.layers.allSatisfy { rids.contains($0.rid) }
            published[id]?.simulcastConfirmed = complete
            if !complete { logger.warn("simulcast did not survive negotiation for \(id): rids \(rids)") }
        }
    }

    func applyPublisherLayers(trackId: String, layers: [LayerActivity]) {
        guard let entry = published[trackId] else { return }
        let sender = entry.transceiver.sender
        let parameters = sender.parameters
        let rids = parameters.encodings.compactMap(\.rid)
        let activity = Simulcast.activity(for: rids, frame: layers)
        guard !activity.isEmpty else { return }
        var changed = false
        for encoding in parameters.encodings {
            guard let rid = encoding.rid, let active = activity[rid], encoding.isActive != active else { continue }
            encoding.isActive = active
            changed = true
        }
        if changed { sender.parameters = parameters }
    }

    // MARK: Data

    /// Phase 7 §1.1: both channels carry protocol `raven.v2`, which tells the
    /// SFU this client reads the 0x52 0x03 delivery framing. Set on
    /// `raven-data` even against older servers (they ignore it).
    static let dataChannelProtocol = "raven.v2"

    static func dataChannelConfiguration(lossy: Bool) -> RTCDataChannelConfiguration {
        let config = RTCDataChannelConfiguration()
        config.protocol = dataChannelProtocol
        if lossy {
            config.isOrdered = false
            config.maxRetransmits = 0
        } else {
            config.isOrdered = true
        }
        return config
    }

    /// Creates the channel (and asks for the renegotiation that carries
    /// it) unless it already exists.
    @discardableResult
    private func ensureDataChannel(lossy: Bool) -> RTCDataChannel? {
        if let existing = lossy ? lossyDataChannel : dataChannel { return existing }
        guard let pc else { return nil }
        let label = lossy ? Self.lossyDataChannelLabel : Self.dataChannelLabel
        let channel = pc.dataChannel(forLabel: label, configuration: Self.dataChannelConfiguration(lossy: lossy))
        channel?.delegate = observer
        if lossy { lossyDataChannel = channel } else { dataChannel = channel }
        negotiationNeeded = true
        Task { await queue.run { [weak self] in await self?.negotiateIfNeeded() } }
        return channel
    }

    func openDataChannels() {
        ensureDataChannel(lossy: false)
        ensureDataChannel(lossy: true)
    }

    /// The channels' configured protocols, for tests.
    var dataChannelProtocols: (reliable: String?, lossy: String?) {
        (dataChannel?.protocol, lossyDataChannel?.protocol)
    }

    func sendData(_ data: Data, lossy: Bool) throws {
        guard pc != nil else { throw RTCError(.notConnected, "The media connection is not up") }
        guard let channel = ensureDataChannel(lossy: lossy), channel.readyState == .open else {
            throw RTCError(.notConnected, "The data channel is not open yet")
        }
        channel.sendData(RTCDataBuffer(data: data, isBinary: true))
    }

    func restartIce() {
        guard let pc else { return }
        pc.restartIce()
        negotiationNeeded = true
        Task { await queue.run { [weak self] in await self?.negotiateIfNeeded() } }
    }

    // MARK: Observer callbacks (main actor)

    fileprivate func didGenerate(_ candidate: RTCIceCandidate) {
        sendSignal?(.iceCandidate(ICECandidatePayload(candidate: candidate.sdp, sdpMid: candidate.sdpMid,
                                                      sdpMLineIndex: Int(candidate.sdpMLineIndex))))
    }

    fileprivate func didStartReceiving(_ transceiver: RTCRtpTransceiver) {
        let receiver = transceiver.receiver
        var trackId: String?
        if let sdp = pc?.remoteDescription?.sdp, !transceiver.mid.isEmpty {
            trackId = SDPUtilities.msidTrackId(forMid: transceiver.mid, in: sdp)
        }
        let id = trackId ?? receiver.track?.trackId ?? receiver.receiverId
        remoteByReceiver[receiver.receiverId] = id
        remoteReceivers[id] = (receiver, remoteReceivers[id]?.participantId)
        onEvent?(.remoteTrackAdded(trackId: id, track: receiver.track))
    }

    fileprivate func didRemove(_ receiver: RTCRtpReceiver) {
        guard let id = remoteByReceiver.removeValue(forKey: receiver.receiverId) else { return }
        if let remote = remoteReceivers.removeValue(forKey: id) { frameEncryption?.release(remote.receiver) }
        onEvent?(.remoteTrackRemoved(trackId: id))
    }

    fileprivate func didChangeConnection(_ state: RTCPeerConnectionState) {
        let mapped: MediaConnectionState
        switch state {
        case .new: mapped = .new
        case .connecting: mapped = .connecting
        case .connected: mapped = .connected
        case .disconnected: mapped = .disconnected
        case .failed: mapped = .failed
        case .closed: mapped = .closed
        @unknown default: mapped = .new
        }
        onEvent?(.connectionStateChanged(mapped))
    }

    fileprivate func didChangeIce(_ state: RTCIceConnectionState) {
        switch state {
        case .new: iceConnectionState = "new"
        case .checking: iceConnectionState = "checking"
        case .connected: iceConnectionState = "connected"
        case .completed: iceConnectionState = "completed"
        case .failed: iceConnectionState = "failed"
        case .disconnected: iceConnectionState = "disconnected"
        case .closed: iceConnectionState = "closed"
        default: iceConnectionState = "unknown"
        }
    }

    fileprivate func didChangeSignaling(_ state: RTCSignalingState) {
        switch state {
        case .stable: signalingState = "stable"
        case .haveLocalOffer: signalingState = "have-local-offer"
        case .haveLocalPrAnswer: signalingState = "have-local-pranswer"
        case .haveRemoteOffer: signalingState = "have-remote-offer"
        case .haveRemotePrAnswer: signalingState = "have-remote-pranswer"
        case .closed: signalingState = "closed"
        @unknown default: signalingState = "unknown"
        }
    }

    fileprivate func shouldNegotiate() {
        negotiationNeeded = true
        Task { await queue.run { [weak self] in await self?.negotiateIfNeeded() } }
    }

    fileprivate func didOpen(_ channel: RTCDataChannel) {
        if channel.label == Self.lossyDataChannelLabel {
            if lossyDataChannel == nil { lossyDataChannel = channel }
        } else if dataChannel == nil {
            dataChannel = channel
        }
        channel.delegate = observer
    }

    fileprivate func didReceive(_ data: Data) {
        onEvent?(.dataReceived(data))
    }

    // MARK: Async wrappers

    private func createOffer(_ pc: RTCPeerConnection, iceRestart: Bool) async throws -> RTCSessionDescription {
        let constraints = RTCMediaConstraints(mandatoryConstraints: iceRestart ? ["IceRestart": "true"] : nil, optionalConstraints: nil)
        return try await withCheckedThrowingContinuation { cont in
            pc.offer(for: constraints) { sdp, error in
                if let sdp { cont.resume(returning: sdp) } else { cont.resume(throwing: error ?? RTCError(.mediaError, "createOffer failed")) }
            }
        }
    }

    private func createAnswer(_ pc: RTCPeerConnection) async throws -> RTCSessionDescription {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        return try await withCheckedThrowingContinuation { cont in
            pc.answer(for: constraints) { sdp, error in
                if let sdp { cont.resume(returning: sdp) } else { cont.resume(throwing: error ?? RTCError(.mediaError, "createAnswer failed")) }
            }
        }
    }

    private func setLocal(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setLocalDescription(sdp) { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    private func setRemote(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(sdp) { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    // MARK: - Observer

    /// The WebRTC delegate. Callbacks arrive on WebRTC's signaling thread
    /// and hop to the main actor, where all engine state lives.
    private final class Observer: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, @unchecked Sendable {
        weak var engine: PeerConnectionEngine?

        init(engine: PeerConnectionEngine) {
            self.engine = engine
        }

        private func hop(_ body: @escaping @MainActor (PeerConnectionEngine) -> Void) {
            Task { @MainActor [weak self] in
                guard let engine = self?.engine else { return }
                body(engine)
            }
        }

        func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
            hop { $0.didChangeSignaling(stateChanged) }
        }
        func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
        func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
            hop { $0.shouldNegotiate() }
        }
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
            hop { $0.didChangeIce(newState) }
        }
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
            hop { $0.didGenerate(candidate) }
        }
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
            hop { $0.didOpen(dataChannel) }
        }
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
            hop { $0.didChangeConnection(newState) }
        }
        func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
            hop { $0.didStartReceiving(transceiver) }
        }
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove rtpReceiver: RTCRtpReceiver) {
            hop { $0.didRemove(rtpReceiver) }
        }

        func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
        func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
            let data = buffer.data
            hop { $0.didReceive(data) }
        }
    }
}

/// Runs async operations strictly one after another, in submission order.
@MainActor
final class SerialTaskQueue {
    private var tail: Task<Void, Never>?

    func run(_ operation: @escaping @MainActor () async -> Void) async {
        let previous = tail
        let task = Task { @MainActor in
            await previous?.value
            await operation()
        }
        tail = task
        await task.value
    }
}
