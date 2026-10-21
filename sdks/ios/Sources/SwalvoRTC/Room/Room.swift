import Foundation
import LiveKitWebRTC

/// A Swalvo room: participants, tracks and every room-scoped action. No
/// SDP, ICE candidate or PeerConnection leaks out of here.
///
/// ```swift
/// let room = Room(options: options)
/// Task { for await event in room.events() { handle(event) } }
/// try await room.connect(token: grant.token, endpoint: grant.endpoint)
/// try await room.enableCamera()
/// ```
///
/// Subscribe to `events()` (or set `delegate`) *before* `connect` to see
/// every event, including the roster's `participantJoined`s.
@MainActor
public final class Room {
    public weak var delegate: RoomDelegate?
    public let options: RoomOptions

    /// The room's id, as the server confirmed it.
    public private(set) var roomId: String?
    public private(set) var connectionState: ConnectionState = .disconnected
    public let localParticipant: LocalParticipant
    public private(set) var remoteParticipants: [String: RemoteParticipant] = [:]
    /// Who is speaking right now, loudest first.
    public private(set) var activeSpeakers: [Participant] = []
    /// What this participant may do, as the server last said. Nil until it says.
    public private(set) var permissions: ParticipantPermissions?
    /// Whether this is an end-to-end encrypted room (token claim or `room.joined`).
    public private(set) var isE2EE = false
    public let e2eeKeyProvider: E2EEKeyProvider
    /// Whether media is being end-to-end encrypted right now: the room is
    /// E2EE and a key provider is configured, so every sender and receiver
    /// has a frame cryptor.
    public var isE2EEActive: Bool { frameEncryption != nil }
    /// Why the room last disconnected.
    public private(set) var disconnectReason: DisconnectReason?
    /// The token's `rid` claim: the E2EE passphrase salt input on every platform.
    private var tokenRoomId: String?
    /// Phase 7: the server advertised `data.v2` in its last `room.joined`,
    /// so data messages go out as v2 envelopes and `reliable: false` uses
    /// the lossy channel.
    public private(set) var supportsDataV2 = false
    /// The token's `perms.updateOwnMetadata`, unless the server since said otherwise.
    private var tokenAllowsMetadataUpdate = false
    /// The token's `perms.publishData`; nil when it has no `perms` claim.
    private var tokenAllowsPublishData: Bool?
    /// Data channels need publishData: the API refuses the offer otherwise
    /// (failing the connection), and the SFU closes the channel. Unknown
    /// keeps the old behaviour.
    private var mayOpenDataChannels: Bool { permissions?.publishData ?? tokenAllowsPublishData ?? true }
    private var warnedLossyFallback = false

    private let broadcaster = EventBroadcaster<RoomEvent>()
    private let logger: RTCLogger
    private let socketFactory: WebSocketFactory
    private let environment: SignalingEnvironment
    private let engine: MediaEngine
    private let makeCryptorBackend: @MainActor () -> E2EECryptorBackend?
    private var frameEncryption: E2EEFrameEncryption?
    private var signaling: SignalingClient?
    private var signalingLoop: Task<Void, Never>?
    private var outbox: AsyncStream<ClientMessage>.Continuation?
    private var outboxLoop: Task<Void, Never>?

    private var firstJoinHandled = false
    private var firstJoinWaiters: [CheckedContinuation<Void, Never>] = []
    private var leaving = false
    private var reconnectCount = 0
    private var rtcServer: String?
    private var region: String?
    private var remoteConnectionState: (ice: String, peer: String)?
    /// Phase 6: `agent.state` for an agent not in the roster yet, emitted when it joins.
    private var pendingAgentStates: [String: AgentState] = [:]

    /// What each remote track is, from the roster and `track.published`.
    private var announcements: [String: (participantId: String, track: ServerTrack)] = [:]
    /// Media that arrived before its `track.published` (they race).
    private var pendingMedia: [String: RTCMediaStreamTrack?] = [:]
    /// `subscription.state` that arrived before its track (phase 2 §4).
    private var pendingSubscriptionStates: [String: SubscriptionStateMessage] = [:]

    public convenience init(options: RoomOptions = RoomOptions()) {
        let logger = RTCLogger(level: options.logLevel)
        self.init(options: options,
                  socketFactory: URLSessionWebSocketFactory(),
                  engine: PeerConnectionEngine(logger: logger, preferredVideoCodec: options.preferredVideoCodec),
                  environment: SignalingEnvironment(),
                  logger: logger,
                  cryptorBackend: { LiveKitCryptorBackend(factory: WebRTCFactory.shared) })
    }

    /// Internal: lets tests inject a fake socket and a fake media engine.
    /// `cryptorBackend` builds the native frame cryptors (nil: this build
    /// cannot encrypt media).
    init(options: RoomOptions, socketFactory: WebSocketFactory, engine: MediaEngine, environment: SignalingEnvironment,
         logger: RTCLogger, cryptorBackend: @escaping @MainActor () -> E2EECryptorBackend? = { nil }) {
        self.options = options
        self.makeCryptorBackend = cryptorBackend
        self.socketFactory = socketFactory
        self.engine = engine
        self.environment = environment
        self.logger = logger
        self.localParticipant = LocalParticipant(identity: "")
        self.e2eeKeyProvider = options.e2eeKeyProvider ?? E2EEKeyProvider()
        engine.sendSignal = { [weak self] message in self?.send(message) }
        engine.onEvent = { [weak self] event in self?.handleEngineEvent(event) }
        localParticipant.room = self
    }

    /// A stream of room events. Each call returns an independent stream.
    public func events() -> AsyncStream<RoomEvent> {
        broadcaster.stream()
    }

    public var participants: [Participant] {
        [localParticipant] + Array(remoteParticipants.values)
    }

    // MARK: - Connect / leave

    /// Joins the room the token was minted for. `endpoint` and `token` are
    /// the fields of your backend's token-mint response; pass them through.
    /// `roomId`, if given, must match the token (id or name).
    public func connect(token: String, endpoint: URL, roomId: String? = nil) async throws {
        guard connectionState == .disconnected, signaling == nil else {
            throw RTCError(.connectionFailed, "This Room is already connected or connecting; create a new Room to join again")
        }
        let claims = try TokenClaims.decode(token)
        if let exp = claims.expiresAt, exp <= environment.now() {
            throw RTCError(.tokenExpired, "RTC token has already expired")
        }
        if let roomId, claims.roomId != nil || claims.roomName != nil, roomId != claims.roomId, roomId != claims.roomName {
            throw RTCError(.roomNotFound, "This token was minted for room \"\(claims.roomName ?? claims.roomId ?? "")\", not \"\(roomId)\"")
        }
        localParticipant.identity = claims.identity ?? ""
        localParticipant.metadata = claims.metadata
        localParticipant.attributes = claims.attributes
        tokenAllowsMetadataUpdate = claims.canUpdateOwnMetadata
        tokenAllowsPublishData = claims.canPublishData
        isE2EE = claims.e2ee
        tokenRoomId = claims.roomId
        self.roomId = roomId ?? claims.roomId
        startFrameEncryptionIfNeeded()

        var signalingOptions = SignalingOptions(endpoint: endpoint, token: token)
        signalingOptions.roomId = roomId ?? claims.roomId ?? claims.roomName
        signalingOptions.region = options.region
        signalingOptions.autoReconnect = options.autoReconnect
        signalingOptions.autoSubscribe = options.autoSubscribe
        signalingOptions.refreshToken = options.refreshToken
        signalingOptions.timings = options.timings
        let signaling = SignalingClient(options: signalingOptions, factory: socketFactory, environment: environment, logger: logger)
        self.signaling = signaling
        startOutbox(signaling)
        signalingLoop = Task { @MainActor [weak self] in
            for await event in signaling.events {
                guard let self else { return }
                await self.handle(event)
            }
        }

        setState(.connecting)
        do {
            _ = try await signaling.connect()
        } catch {
            let rtcError = (error as? RTCError) ?? RTCError(.connectionFailed, "\(error)")
            teardown()
            disconnectReason = rtcError.code == .tokenExpired ? .tokenExpired : .connectionFailed
            setState(.failed)
            throw rtcError
        }
        if !firstJoinHandled {
            await withCheckedContinuation { firstJoinWaiters.append($0) }
        }
    }

    /// Convenience: `endpoint` as a string from the mint response.
    public func connect(token: String, endpoint: String, roomId: String? = nil) async throws {
        guard let url = URL(string: endpoint) else { throw RTCError(.connectionFailed, "Invalid endpoint URL") }
        try await connect(token: token, endpoint: url, roomId: roomId)
    }

    /// Leaves the room. Emits `disconnected(.clientInitiated)`.
    public func leave() async {
        guard !leaving, let signaling else { return }
        leaving = true
        await signaling.close()
        finishDisconnect(reason: .clientInitiated, failed: false)
    }

    /// Tells the SDK the device's network changed (Wi-Fi → cellular, VPN),
    /// so it recovers now instead of waiting for timeouts: a pending
    /// reconnect runs now and a live media connection restarts ICE.
    public func handleNetworkChange() {
        guard let signaling, !leaving else { return }
        Task { await signaling.reconnectNow() }
        if connectionState == .connected { engine.restartIce() }
    }

    public func getDiagnostics() -> ConnectionDiagnostics {
        #if os(iOS)
        let platform = "iOS"
        #else
        let platform = "macOS"
        #endif
        return ConnectionDiagnostics(connectionState: connectionState, iceConnectionState: engine.iceConnectionState,
                                     signalingState: engine.signalingState,
                                     remoteIceConnectionState: remoteConnectionState?.ice,
                                     remotePeerConnectionState: remoteConnectionState?.peer,
                                     rtcServer: rtcServer, region: region, reconnectCount: reconnectCount,
                                     sdkVersion: SwalvoRTCVersion.string, platform: platform)
    }

    // MARK: - Publishing

    /// Publishes the camera (`true`) or unpublishes it (`false`).
    @discardableResult
    public func enableCamera(_ enabled: Bool = true, options capture: CameraCaptureOptions = CameraCaptureOptions()) async throws -> LocalTrack? {
        try await setSource(.camera, enabled: enabled) { try await LocalMedia.createCameraTrack(options: capture) }
    }

    @discardableResult
    public func enableMicrophone(_ enabled: Bool = true) async throws -> LocalTrack? {
        try await setSource(.microphone, enabled: enabled) { LocalMedia.createMicrophoneTrack() }
    }

    /// In-app screen share (ReplayKit) on iOS. For the whole device, use the
    /// Broadcast Upload Extension template. Video only: in-app capture has
    /// no way to publish app audio as a second track (the app's audio
    /// device is the microphone). The broadcast extension template can
    /// publish `screenShareAudio`. Disabling also unpublishes any
    /// `screenShareAudio` track.
    @discardableResult
    public func enableScreenShare(_ enabled: Bool = true) async throws -> LocalTrack? {
        try await setSource(.screenShare, enabled: enabled) { try await LocalMedia.createScreenShareTrack() }
    }

    private func setSource(_ source: TrackSource, enabled: Bool, create: () async throws -> LocalTrack) async throws -> LocalTrack? {
        let existing = localParticipant.tracks.first { $0.source == source }
        if enabled {
            if let existing {
                if existing.isMuted { await existing.unmute() }
                return existing
            }
            try checkCanPublish(source)
            let track = try await create()
            do {
                try await publish(track)
            } catch {
                track.stop()
                throw error
            }
            return track
        }
        if let existing { await unpublish(existing) }
        return nil
    }

    private func checkCanPublish(_ source: TrackSource) throws {
        guard connectionState == .connected || connectionState == .reconnecting else {
            throw RTCError(.notConnected, "Join the room before publishing")
        }
        if let permissions, !permissions.allows(source) {
            throw RTCError(.permissionDenied, "This participant may not publish \(source.rawValue)")
        }
        if isE2EE && frameEncryption == nil {
            startFrameEncryptionIfNeeded()
        }
        if isE2EE && frameEncryption == nil {
            // Phase 5 §3.1: SDKs refuse to publish unencrypted media into an E2EE room.
            if isE2EEConfigured {
                throw RTCError(.e2eeNotSupported, "This room is end-to-end encrypted and this build cannot encrypt media frames. Publishing is refused rather than sending plaintext.")
            }
            throw RTCError(.e2eeRequired, "This room is end-to-end encrypted: set RoomOptions.e2eeKeyProvider (or call setE2EEPassphrase / setKey) to publish into it. See the SwalvoRTC README, \"End-to-end encryption\".")
        }
    }

    /// Publishes a track you created with `LocalMedia`.
    public func publish(_ track: LocalTrack) async throws {
        try checkCanPublish(track.source)
        guard !localParticipant.tracks.contains(where: { $0 === track }) else { return }
        track.room = self
        let simulcast = track.source == .camera && options.simulcast
        try await engine.publish(EnginePublication(trackId: track.trackId, source: track.source,
                                                   track: track.mediaStreamTrack, simulcast: simulcast))
        localParticipant.tracks.append(track)
        emit(.localTrackPublished(track))
        if track.isMuted { send(.trackMute(trackId: track.trackId, muted: true)) }
    }

    /// Unpublishing a `screenShare` also unpublishes its `screenShareAudio`
    /// (phase 7 §3: they go together).
    public func unpublish(_ track: LocalTrack) async {
        guard let index = localParticipant.tracks.firstIndex(where: { $0 === track }) else { return }
        localParticipant.tracks.remove(at: index)
        await engine.unpublish(trackId: track.trackId)
        track.room = nil
        if options.stopLocalTrackOnUnpublish { track.stop() }
        emit(.localTrackUnpublished(track))
        if track.source == .screenShare {
            for audio in localParticipant.tracks where audio.source == .screenShareAudio {
                await unpublish(audio)
            }
        }
    }

    func sendLocalMute(_ track: LocalTrack, muted: Bool) async {
        guard localParticipant.tracks.contains(where: { $0 === track }) else { return }
        send(.trackMute(trackId: track.trackId, muted: muted))
    }

    /// Whether the published camera genuinely negotiated three layers.
    /// Nil until negotiated or when nothing applies.
    public func simulcastConfirmed() -> Bool? {
        guard let camera = localParticipant.tracks.first(where: { $0.source == .camera }) else { return nil }
        return engine.simulcastConfirmed(trackId: camera.trackId)
    }

    // MARK: - Data

    /// Sends bytes over the data channel: to everyone, or with
    /// `options.destinationIdentities` only to them (phase 7 §1).
    ///
    /// With no options against a server without `data.v2`, this sends
    /// exactly what it always did. Otherwise it sends a v2 envelope, and
    /// receivers learn the sender (stamped by the SFU) and the topic.
    /// `reliable: false` uses the lossy channel (at most 1,200 bytes); on a
    /// server without `data.v2` it falls back to the reliable channel.
    ///
    /// Data messages are **not** end-to-end encrypted, even in an E2EE room.
    public func sendData(_ data: Data, options: DataPublishOptions = DataPublishOptions()) throws {
        if !mayOpenDataChannels {
            throw RTCError(.permissionDenied, "This participant may not publish data")
        }
        let topic = options.topic ?? ""
        let destinations = options.destinationIdentities ?? []
        let limit = options.reliable ? DataEnvelope.maxReliablePayloadBytes : DataEnvelope.maxLossyPayloadBytes
        guard data.count <= limit else {
            throw RTCError(.invalidArgument, "Data payload is \(data.count) bytes, over the \(limit)-byte limit for \(options.reliable ? "reliable" : "lossy") messages")
        }
        let useEnvelope = supportsDataV2 || !topic.isEmpty || !destinations.isEmpty || !options.reliable
        let lossy = !options.reliable && supportsDataV2
        if !options.reliable && !supportsDataV2 && !warnedLossyFallback {
            warnedLossyFallback = true
            logger.warn("this server does not support data.v2: reliable: false messages go over the reliable channel")
        }
        let bytes = useEnvelope
            ? try DataEnvelope.encode(payload: data, topic: topic, destinationIdentities: destinations)
            : data
        try engine.sendData(bytes, lossy: lossy)
    }

    /// Sends a UTF-8 string; see `sendData(_:options:)`.
    public func sendData(_ text: String, options: DataPublishOptions = DataPublishOptions()) throws {
        try sendData(Data(text.utf8), options: options)
    }

    // MARK: - Participant metadata

    /// Sends `participant.update` for the local participant (phase 7 §2).
    func updateLocalParticipant(metadata: String?, attributes: [String: String]?) throws {
        guard connectionState == .connected || connectionState == .reconnecting else {
            throw RTCError(.notConnected, "Join the room before updating participant metadata")
        }
        guard permissions?.updateOwnMetadata ?? tokenAllowsMetadataUpdate else {
            throw RTCError(.permissionDenied, "This participant may not update its own metadata; mint the token with perms.updateOwnMetadata")
        }
        if let metadata { try ParticipantMetadataLimits.validate(metadata: metadata) }
        if let attributes { try ParticipantMetadataLimits.validate(attributes: attributes) }
        send(.participantUpdate(metadata: metadata, attributes: attributes))
    }

    /// Applies server-side metadata to a participant, emitting
    /// `participantMetadataChanged` when something actually changed.
    private func applyMetadata(_ participant: Participant, metadata: String??, attributes: [String: String]?, emitChange: Bool = true) {
        guard let previous = participant.applyMetadata(metadata, attributes: attributes), emitChange else { return }
        emit(.participantMetadataChanged(participant: participant, previousMetadata: previous.metadata,
                                         previousAttributes: previous.attributes))
    }

    // MARK: - E2EE

    /// Shared-passphrase E2EE: derives the room key (phase 5 §3.1). The
    /// salt is `"LivqenoE2EE:" + rid`, the token's room-id claim, so every
    /// platform derives the same key. Call after `connect` (or pass the
    /// provider pre-keyed via `RoomOptions.e2eeKeyProvider`).
    public func setE2EEPassphrase(_ passphrase: String) throws {
        guard let rid = tokenRoomId ?? roomId else { throw RTCError(.notConnected, "The room id is not known yet") }
        e2eeKeyProvider.setSharedPassphrase(passphrase, roomId: rid)
        startFrameEncryptionIfNeeded()
    }

    /// Per-participant E2EE: key material distributed over the app's own
    /// channel. Your own identity's key is what you encrypt with. For this
    /// mode create the provider with `E2EEKeyProvider(sharedKeyMode: false)`
    /// (or set the keys before joining).
    public func setKey(participantId: String, key: Data, keyIndex: UInt8 = 0) {
        e2eeKeyProvider.setKey(participantId: participantId, key: key, keyIndex: keyIndex)
        startFrameEncryptionIfNeeded()
    }

    /// Configured = the app gave a key provider or set a key on this room.
    private var isE2EEConfigured: Bool {
        options.e2eeKeyProvider != nil || e2eeKeyProvider.hasAnyKey
    }

    /// Starts frame encryption once the room is known to be E2EE and keys
    /// are configured. Encryption never engages in an ordinary room
    /// (configured E2EE there sends media as usual, like the web SDK).
    private func startFrameEncryptionIfNeeded() {
        guard isE2EE, frameEncryption == nil, isE2EEConfigured, !leaving else { return }
        guard let backend = makeCryptorBackend() else {
            logger.warn("this room is end-to-end encrypted but this build cannot encrypt media; publishing is disabled")
            return
        }
        let encryption = E2EEFrameEncryption(keys: e2eeKeyProvider, backend: backend,
                                             localIdentity: localParticipant.identity, logger: logger)
        encryption.onState = { [weak self] participantId, local, state in
            self?.applyE2EEState(participantId: participantId, local: local, state: state)
        }
        frameEncryption = encryption
        engine.frameEncryption = encryption
        logger.info("e2ee: frame encryption on (\(encryption.options.sharedKeyMode ? "shared key" : "per-participant keys"))")
    }

    private func applyE2EEState(participantId: String, local: Bool, state: E2EEState) {
        let participant: Participant? = local ? localParticipant : remoteParticipants[participantId]
        guard let participant, participant.setE2EEState(state) else { return }
        emit(.e2eeStateChanged(participant: participant, state: state))
    }

    /// Ratchets a participant's key (or the shared key).
    @discardableResult
    public func ratchetKey(participantId: String? = nil) -> E2EEKeySet? {
        e2eeKeyProvider.ratchetKey(participantId: participantId)
    }

    // MARK: - Signaling events

    private func handle(_ event: SignalingEvent) async {
        switch event {
        case let .joined(payload):
            await handleJoined(payload)
        case let .message(message):
            await handleMessage(message)
        case .reconnecting:
            if connectionState == .connected || connectionState == .connecting {
                setState(.reconnecting)
            }
        case let .failed(error, reason):
            emit(.error(error))
            finishDisconnect(reason: reason, failed: true)
        case let .ended(reason):
            finishDisconnect(reason: reason, failed: false)
        case .closed:
            break
        case let .warning(warning):
            emit(.warning(warning))
        }
    }

    private func handleJoined(_ payload: JoinedPayload) async {
        let joined = payload.message
        if !joined.roomId.isEmpty { roomId = joined.roomId }
        rtcServer = joined.rtcServer
        region = joined.region
        if joined.e2ee == true { isE2EE = true }
        supportsDataV2 = joined.capabilities?.contains("data.v2") ?? false
        startFrameEncryptionIfNeeded()

        if !payload.resumed {
            // A fresh session: a new PeerConnection, every subscription gone,
            // publications re-attached by the engine (it re-declares each).
            for participant in remoteParticipants.values {
                for track in participant.tracks {
                    emit(.trackUnsubscribed(track: track, participant: participant))
                }
                participant.tracks = []
            }
            pendingMedia = [:]
            pendingSubscriptionStates = [:]
            engine.resetPeerConnection(iceServers: options.iceServers)
        }
        reconcileRoster(joined.participants)
        // Phase 7 §1.1: v2 SDKs open both channels at connect; without the
        // capability, channels stay lazy exactly as before. Only with
        // publishData: a live-stream viewer's offer would be refused.
        if supportsDataV2, mayOpenDataChannels { engine.openDataChannels() }

        let wasReconnecting = connectionState == .reconnecting
        if payload.isReconnect { reconnectCount += 1 }
        setState(.connected, reconnected: wasReconnecting || payload.isReconnect)

        if !firstJoinHandled {
            firstJoinHandled = true
            let waiters = firstJoinWaiters
            firstJoinWaiters = []
            waiters.forEach { $0.resume() }
        }
    }

    /// Brings the roster in line with a `room.joined`, emitting only what
    /// actually changed (so a resume or rejoin does not replay the room).
    private func reconcileRoster(_ participants: [ServerParticipant]) {
        if let me = participants.first(where: { $0.id == localParticipant.identity }) {
            applyMetadata(localParticipant, metadata: me.metadata.map { .some($0) }, attributes: me.attributes)
        }
        let incoming = participants.filter { $0.id != localParticipant.identity }
        let ids = Set(incoming.map(\.id))
        for (id, participant) in remoteParticipants where !ids.contains(id) {
            removeParticipant(participant)
        }
        for server in incoming {
            let participant: RemoteParticipant
            if let existing = remoteParticipants[server.id] {
                participant = existing
                let newIds = Set(server.tracks.map(\.trackId))
                for old in participant.publishedTracks where !newIds.contains(old.trackId) {
                    unannounce(old.trackId, participant: participant)
                }
                applyMetadata(participant, metadata: server.metadata.map { .some($0) }, attributes: server.attributes)
            } else {
                participant = RemoteParticipant(identity: server.id)
                _ = participant.applyMetadata(server.metadata.map { .some($0) }, attributes: server.attributes)
                remoteParticipants[server.id] = participant
                emit(.participantJoined(participant))
            }
            for track in server.tracks {
                announce(track, participant: participant)
            }
        }
    }

    private func handleMessage(_ message: ServerMessage) async {
        switch message {
        case let .sdpOffer(sdp):
            await engine.handleRemoteOffer(sdp)
        case let .sdpAnswer(sdp):
            await engine.handleRemoteAnswer(sdp)
        case let .iceCandidate(candidate):
            await engine.handleRemoteCandidate(candidate)

        case let .participantJoined(server):
            guard server.id != localParticipant.identity else { return }
            let participant: RemoteParticipant
            if let existing = remoteParticipants[server.id] {
                participant = existing
                applyMetadata(participant, metadata: server.metadata.map { .some($0) }, attributes: server.attributes)
            } else {
                participant = RemoteParticipant(identity: server.id)
                _ = participant.applyMetadata(server.metadata.map { .some($0) }, attributes: server.attributes)
                remoteParticipants[server.id] = participant
                emit(.participantJoined(participant))
            }
            server.tracks.forEach { announce($0, participant: participant) }

        case let .participantLeft(server):
            if let participant = remoteParticipants[server.id] {
                removeParticipant(participant)
            }

        case let .trackPublished(participantId, track):
            guard participantId != localParticipant.identity else { return }
            let participant: RemoteParticipant
            if let existing = remoteParticipants[participantId] {
                participant = existing
            } else {
                // A track for someone we have not heard join (missed frame).
                participant = RemoteParticipant(identity: participantId)
                remoteParticipants[participantId] = participant
                emit(.participantJoined(participant))
            }
            announce(track, participant: participant)

        case let .trackUnpublished(participantId, trackId):
            if let participant = remoteParticipants[participantId] {
                unannounce(trackId, participant: participant)
            }

        case let .trackMuted(participantId, trackId, byServer):
            applyMute(participantId: participantId, trackId: trackId, muted: true, byServer: byServer)
        case let .trackUnmuted(participantId, trackId, byServer):
            applyMute(participantId: participantId, trackId: trackId, muted: false, byServer: byServer)

        case let .speakersChanged(speakers):
            applySpeakers(speakers)
        case let .qualityChanged(updates):
            for update in updates {
                guard let participant = participant(for: update.participantId) else { continue }
                if participant.setConnectionQuality(update.quality) {
                    emit(.connectionQualityChanged(participant: participant, quality: update.quality))
                }
            }
        case let .subscriptionState(state):
            applySubscriptionState(state)
        case let .publisherLayers(trackId, layers):
            engine.applyPublisherLayers(trackId: trackId, layers: layers)

        case let .permissionsUpdated(newPermissions):
            await applyPermissions(newPermissions)

        case let .participantUpdated(update):
            guard let participant = participant(for: update.participantId) else { return }
            applyMetadata(participant, metadata: update.includesMetadata ? .some(update.metadata) : nil,
                          attributes: update.attributes)

        case let .dataThrottled(channel):
            logger.warn("data messages on the \(channel.rawValue) channel are being dropped: over the SFU's rate limit")
            emit(.dataThrottled(channel: channel))

        case let .transcriptionSegment(segment):
            emit(.transcriptionSegment(segment))
        case let .transcriptionState(state):
            emit(.transcriptionStateChanged(state))
        case let .agentState(update):
            if let participant = participant(for: update.participantId) {
                applyAgentState(participant, update.state)
            } else if update.state == .ended {
                pendingAgentStates.removeValue(forKey: update.participantId)
            } else {
                pendingAgentStates[update.participantId] = update.state
            }

        case let .connectionState(ice, peer):
            remoteConnectionState = (ice, peer)

        case let .error(code, text):
            if code == .negotiationGlare {
                engine.handleGlare()
            } else {
                emit(.error(RTCError.fromServer(code, text)))
            }

        case .roomJoined, .roomLeft, .roomResumeToken, .tokenExpiring, .tokenRefreshed, .pong, .unknown:
            break
        }
    }

    // MARK: Tracks

    private func announce(_ track: ServerTrack, participant: RemoteParticipant) {
        let isNew = announcements[track.trackId] == nil
        announcements[track.trackId] = (participant.identity, track)
        if let index = participant.publishedTracks.firstIndex(where: { $0.trackId == track.trackId }) {
            participant.publishedTracks[index] = track
        } else {
            participant.publishedTracks.append(track)
        }
        if isNew {
            emit(.trackPublished(kind: TrackKind(source: track.source), participant: participant))
        }
        if let media = pendingMedia.removeValue(forKey: track.trackId) {
            completeSubscription(trackId: track.trackId, media: media)
        }
    }

    private func unannounce(_ trackId: String, participant: RemoteParticipant) {
        guard let announcement = announcements.removeValue(forKey: trackId) else { return }
        participant.publishedTracks.removeAll { $0.trackId == trackId }
        pendingMedia.removeValue(forKey: trackId)
        pendingSubscriptionStates.removeValue(forKey: trackId)
        if let index = participant.tracks.firstIndex(where: { $0.trackId == trackId }) {
            let track = participant.tracks.remove(at: index)
            emit(.trackUnsubscribed(track: track, participant: participant))
        }
        emit(.trackUnpublished(kind: TrackKind(source: announcement.track.source), participant: participant))
    }

    private func removeParticipant(_ participant: RemoteParticipant) {
        for track in participant.publishedTracks {
            unannounce(track.trackId, participant: participant)
        }
        for track in participant.tracks {
            emit(.trackUnsubscribed(track: track, participant: participant))
        }
        participant.tracks = []
        remoteParticipants.removeValue(forKey: participant.identity)
        activeSpeakers.removeAll { $0 === participant }
        emit(.participantLeft(participant))
        participant.finishEvents()
    }

    private func completeSubscription(trackId: String, media: RTCMediaStreamTrack?) {
        guard let (participantId, serverTrack) = announcements[trackId],
              let participant = remoteParticipants[participantId] else {
            pendingMedia[trackId] = media
            return
        }
        engine.remoteTrackSubscribed(trackId: trackId, participantId: participantId)
        if let existing = participant.tracks.first(where: { $0.trackId == trackId }) {
            existing.mediaStreamTrack = media
            return
        }
        let track = RemoteTrack(trackId: trackId, kind: TrackKind(source: serverTrack.source), participantId: participantId,
                                isMuted: serverTrack.muted, isSimulcast: serverTrack.simulcast, mediaStreamTrack: media,
                                adaptiveStream: options.adaptiveStream, autoSubscribe: options.autoSubscribe)
        track.layerSink = { [weak self] layer in
            self?.send(.subscriptionUpdate(publisherId: participantId, trackId: trackId, layer: layer))
        }
        if let pending = pendingSubscriptionStates.removeValue(forKey: trackId) {
            _ = track.applySubscriptionState(pending.state, layer: pending.layer)
        }
        participant.tracks.append(track)
        emit(.trackSubscribed(track: track, participant: participant))
    }

    private func applyMute(participantId: String, trackId: String, muted: Bool, byServer: Bool) {
        if participantId == localParticipant.identity {
            // Phase 1 §1.6: the server muted one of our tracks. Mark it and
            // stop sending. A server unmute is left to the user.
            guard byServer, muted, let track = localParticipant.tracks.first(where: { $0.trackId == trackId }) else { return }
            track.isMuted = true
            track.mediaStreamTrack?.isEnabled = false
            emit(.localTrackMutedByServer(track))
            return
        }
        guard let participant = remoteParticipants[participantId] else { return }
        var kind = TrackKind.unknown
        if let index = participant.publishedTracks.firstIndex(where: { $0.trackId == trackId }) {
            participant.publishedTracks[index].muted = muted
            kind = TrackKind(source: participant.publishedTracks[index].source)
            announcements[trackId]?.track.muted = muted
        }
        if let track = participant.tracks.first(where: { $0.trackId == trackId }) {
            track.isMuted = muted
            kind = track.kind
        }
        emit(muted ? .trackMuted(kind: kind, participant: participant) : .trackUnmuted(kind: kind, participant: participant))
    }

    private func applySpeakers(_ speakers: [SpeakerEntry]) {
        var levels: [String: Double] = [:]
        for speaker in speakers { levels[speaker.participantId] = speaker.level }
        for participant in participants {
            if let level = levels[participant.identity] {
                participant.setSpeaking(true, level: level)
            } else {
                participant.setSpeaking(false, level: 0)
            }
        }
        activeSpeakers = speakers.compactMap { participant(for: $0.participantId) }
        emit(.activeSpeakersChanged(activeSpeakers))
    }

    private func applySubscriptionState(_ message: SubscriptionStateMessage) {
        guard let participant = remoteParticipants[message.publisherId],
              let track = participant.tracks.first(where: { $0.trackId == message.trackId }) else {
            // Kept and applied when the track arrives (phase 2 §4).
            pendingSubscriptionStates[message.trackId] = message
            return
        }
        if track.applySubscriptionState(message.state, layer: message.layer) {
            emit(.trackSubscriptionStateChanged(track: track, participant: participant))
        }
    }

    private func applyPermissions(_ newPermissions: ParticipantPermissions) async {
        let hadDataGrant = mayOpenDataChannels
        permissions = newPermissions
        // Granted mid-session: open what connect would have opened.
        if !hadDataGrant, newPermissions.publishData, supportsDataV2 { engine.openDataChannels() }
        // Withdrawn publish rights: the SFU already unpublished these; stop
        // the local publications without treating it as an error.
        let revoked = localParticipant.tracks.filter { !newPermissions.allows($0.source) }
        for track in revoked {
            await unpublish(track)
        }
        emit(.permissionsChanged(newPermissions))
    }

    private func participant(for id: String) -> Participant? {
        id == localParticipant.identity ? localParticipant : remoteParticipants[id]
    }

    // MARK: - Engine events

    private func handleEngineEvent(_ event: MediaEngineEvent) {
        switch event {
        case let .remoteTrackAdded(trackId, track):
            completeSubscription(trackId: trackId, media: track)
        case let .remoteTrackRemoved(trackId):
            pendingMedia.removeValue(forKey: trackId)
            guard let (participantId, _) = announcements[trackId], let participant = remoteParticipants[participantId],
                  let index = participant.tracks.firstIndex(where: { $0.trackId == trackId }) else { return }
            let track = participant.tracks.remove(at: index)
            emit(.trackUnsubscribed(track: track, participant: participant))
        case let .connectionStateChanged(state):
            if state == .failed, connectionState == .connected, let signaling {
                // Media is dead while signaling is fine: resuming would only
                // re-bind the dead session, so join afresh.
                logger.warn("media connection failed; rejoining")
                Task { await signaling.rejoin() }
            }
        case let .dataReceived(data):
            let decoded = DataEnvelope.decode(data)
            let sender = decoded.senderIdentity.flatMap { $0.isEmpty ? nil : remoteParticipants[$0] }
            let topic = decoded.topic.flatMap { $0.isEmpty ? nil : $0 }
            emit(.dataReceived(decoded.payload, participant: sender))
            emit(.dataMessageReceived(DataMessage(payload: decoded.payload, participant: sender,
                                                  senderIdentity: decoded.senderIdentity, topic: topic)))
        case let .publicationIdChanged(oldId, newId):
            localParticipant.tracks.first { $0.trackId == oldId }?.trackId = newId
        case let .error(error):
            emit(.error(error))
        }
    }

    // MARK: - Plumbing

    private func send(_ message: ClientMessage) {
        outbox?.yield(message)
    }

    /// One ordered queue to the signaling actor, so an answer is never
    /// overtaken by the candidates that follow it.
    private func startOutbox(_ signaling: SignalingClient) {
        var continuation: AsyncStream<ClientMessage>.Continuation!
        let stream = AsyncStream<ClientMessage>(bufferingPolicy: .unbounded) { continuation = $0 }
        outbox = continuation
        outboxLoop = Task {
            for await message in stream {
                await signaling.send(message)
            }
        }
    }

    private func setState(_ state: ConnectionState, reconnected: Bool = false) {
        let previous = connectionState
        guard previous != state else { return }
        connectionState = state
        emit(.connectionStateChanged(state))
        switch state {
        case .connected:
            emit(reconnected ? .reconnected : .connected)
        case .reconnecting:
            emit(.reconnecting)
        default:
            break
        }
    }

    private func finishDisconnect(reason: DisconnectReason, failed: Bool) {
        guard connectionState != .disconnected, connectionState != .failed else { return }
        disconnectReason = reason
        teardown()
        setState(failed ? .failed : .disconnected)
        emit(.disconnected(reason: reason))
        broadcaster.finish()
        participants.forEach { $0.finishEvents() }
    }

    private func teardown() {
        engine.close()
        frameEncryption?.dispose()
        frameEncryption = nil
        for track in localParticipant.tracks { track.stop() }
        outbox?.finish()
        outbox = nil
        let signaling = self.signaling
        Task { await signaling?.finish() }
        let waiters = firstJoinWaiters
        firstJoinWaiters = []
        waiters.forEach { $0.resume() }
    }

    private func emit(_ event: RoomEvent) {
        logger.debug("room event \(event.name)")
        broadcaster.emit(event)
        delegate?.room(self, didEmit: event)
        if case let .participantJoined(participant) = event,
           let state = pendingAgentStates.removeValue(forKey: participant.identity) {
            applyAgentState(participant, state)
        }
    }

    private func applyAgentState(_ participant: Participant, _ state: AgentState) {
        // Only on a real change: a repeated identical frame emits nothing.
        guard participant.setAgentState(state) else { return }
        emit(.agentStateChanged(participant: participant, state: state))
    }
}

/// The SDK's entry point, matching the web SDK's vocabulary
/// (`SwalvoClient` → `connect(token, endpoint)` → `Room`, phase 5 §4).
public final class SwalvoClient: Sendable {
    public let options: RoomOptions

    public init(options: RoomOptions = RoomOptions()) {
        self.options = options
    }

    /// Joins and returns the room. To observe the roster's events, use
    /// `Room(options:)`, subscribe, then `room.connect(...)` instead.
    @MainActor
    public func connect(token: String, endpoint: String, roomId: String? = nil) async throws -> Room {
        let room = Room(options: options)
        try await room.connect(token: token, endpoint: endpoint, roomId: roomId)
        return room
    }
}
