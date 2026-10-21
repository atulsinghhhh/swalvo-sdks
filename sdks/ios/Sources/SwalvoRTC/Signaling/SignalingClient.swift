import Foundation

/// Timing knobs. The defaults are the web SDK's; tests shrink them.
public struct SignalingTimings: Sendable {
    /// Time to wait for the socket to open ("can't reach the API").
    public var openTimeout: TimeInterval = 10
    /// Time to wait for `room.joined` ("the API can't reach an RTC server").
    public var joinTimeout: TimeInterval = 15
    /// Full-jitter exponential backoff: delay = random(0, min(base·2^(n-1), max)).
    public var reconnectBase: TimeInterval = 0.3
    public var reconnectMax: TimeInterval = 10
    public var maxReconnectAttempts = 12
    /// Upper bound of the random delay after close 1012 (phase 1 §1.3).
    public var serviceRestartJitter: TimeInterval = 2
    /// A resume token older than this is not offered (it expires at 120 s).
    public var resumeTokenMaxAge: TimeInterval = 110
    /// A token this close to expiry is refreshed before reconnecting with it.
    public var tokenRefreshSkew: TimeInterval = 30

    public init() {}
}

/// What the signaling client tells its owner.
enum SignalingEvent: Sendable {
    /// `room.joined` arrived, on the first connect or a reconnect.
    case joined(JoinedPayload)
    /// Any other server message, in order.
    case message(ServerMessage)
    /// The connection dropped and a reconnect is scheduled.
    case reconnecting(resuming: Bool)
    /// Reconnects exhausted, or the failure is not retryable.
    case failed(RTCError, DisconnectReason)
    /// The server ended the session on purpose. Never followed by a reconnect.
    case ended(DisconnectReason)
    /// Closed on purpose, via `close()`.
    case closed
    case warning(RTCWarning)
}

struct JoinedPayload: Equatable, Sendable {
    var message: RoomJoinedMessage
    /// True only when this join asked to resume and the server kept the session.
    var resumed: Bool
    var isReconnect: Bool
}

struct SignalingOptions: Sendable {
    var endpoint: URL
    var token: String
    var roomId: String?
    var region: String?
    var autoReconnect: Bool = true
    var autoSubscribe: Bool = true
    var refreshToken: (@Sendable () async throws -> String)?
    var timings = SignalingTimings()
}

/// Random numbers and clocks, injectable so the reconnect schedule is testable.
struct SignalingEnvironment: Sendable {
    var now: @Sendable () -> Date = { Date() }
    var random: @Sendable () -> Double = { Double.random(in: 0..<1) }
    var sleep: @Sendable (TimeInterval) async throws -> Void = { seconds in
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
}

/// A reconnect the client scheduled; recorded for diagnostics and tests.
struct ScheduledReconnect: Equatable, Sendable {
    enum Kind: Equatable, Sendable { case backoff, serviceRestart }
    var attempt: Int
    var delay: TimeInterval
    var kind: Kind
    var refreshFirst: Bool
}

/// The SDK's signaling connection: one WebSocket to `/v1/rtc`.
///
/// Owns the socket, the join handshake, reconnection, resume and the
/// session's token. It has no idea what a PeerConnection is — every message
/// goes to the owner (the `Room`), which decides what to negotiate. This is
/// the same split the web SDK uses, and what makes this state machine
/// testable with a fake socket.
///
/// Close codes steer reconnection (docs/rtc/signaling.md, "Close codes"):
/// 1012 reconnects after 0–2 s jitter with resume; 4003 never reconnects;
/// 4002 never reconnects; 4001 reconnects only after a token refresh; 4004
/// reconnects without resume; anything else backs off with full jitter.
actor SignalingClient {
    nonisolated let events: AsyncStream<SignalingEvent>
    private let eventSink: AsyncStream<SignalingEvent>.Continuation

    private let options: SignalingOptions
    private let factory: WebSocketFactory
    private let env: SignalingEnvironment
    private let logger: RTCLogger

    private(set) var token: String
    private var connection: WebSocketConnection?
    private var generation = 0
    /// The generation of the socket that completed its join. Only that
    /// socket's close drives reconnection.
    private var joinedGeneration: Int?
    private(set) var isJoined = false
    private var closedByCaller = false

    private var pendingJoin: PendingJoin?
    private struct PendingJoin {
        let generation: Int
        let continuation: CheckedContinuation<JoinedPayload, Error>
        let sentResume: Bool
        let isReconnect: Bool
        let timeout: Task<Void, Never>
    }

    private(set) var reconnectAttempts = 0
    private var reconnectTask: Task<Void, Never>?
    private var pendingAttemptID: Int?
    private var attemptCounter = 0
    /// Every reconnect scheduled, in order. Internal; read by tests.
    private(set) var scheduledReconnects: [ScheduledReconnect] = []

    private var resume: (token: String, receivedAt: Date)?
    private var endedReason: DisconnectReason?
    /// The server said the token expired or was revoked and a
    /// `refreshToken` is configured: the 4001 that follows means "refresh
    /// and reconnect", not "stop".
    private var authEndedAwaitingRefresh = false
    private var pendingRefreshToken: String?
    private var liveRefreshInFlight = false

    struct JoinFailure: Error {
        let error: RTCError
        let serverCode: SignalingErrorCode?
        let closeCode: Int?
    }

    init(options: SignalingOptions, factory: WebSocketFactory, environment: SignalingEnvironment = SignalingEnvironment(),
         logger: RTCLogger = RTCLogger()) {
        self.options = options
        self.factory = factory
        self.env = environment
        self.logger = logger
        self.token = options.token
        var sink: AsyncStream<SignalingEvent>.Continuation!
        self.events = AsyncStream(bufferingPolicy: .unbounded) { sink = $0 }
        self.eventSink = sink
    }

    var isReconnecting: Bool { !closedByCaller && !isJoined && reconnectAttempts > 0 }

    /// The resume token a reconnect would offer right now, if any.
    var currentResumeToken: String? { usableResumeToken() }

    // MARK: Connect

    /// Opens the socket and joins. Resolves on `room.joined`. A first join
    /// that fails is never retried in the background.
    func connect() async throws -> JoinedPayload {
        closedByCaller = false
        endedReason = nil
        do {
            return try await openAndJoin(isReconnect: false)
        } catch let failure as JoinFailure {
            closedByCaller = true
            throw failure.error
        } catch {
            closedByCaller = true
            throw error
        }
    }

    private func openAndJoin(isReconnect: Bool) async throws -> JoinedPayload {
        generation += 1
        let gen = generation
        let connection: WebSocketConnection
        do {
            connection = try await factory.open(url: buildURL(), timeout: options.timings.openTimeout)
        } catch {
            let rtc = (error as? RTCError) ?? RTCError(.networkError, "Could not reach the signaling endpoint at \(options.endpoint.absoluteString)")
            throw JoinFailure(error: rtc, serverCode: nil, closeCode: nil)
        }
        guard gen == generation, !closedByCaller || !isReconnect else {
            connection.close(code: CloseCode.normal, reason: "superseded")
            throw JoinFailure(error: RTCError(.connectionFailed, "Connection attempt superseded"), serverCode: nil, closeCode: nil)
        }
        self.connection = connection
        startReadLoop(connection, generation: gen)

        let resumeToken = isReconnect ? usableResumeToken() : nil
        let join = RoomJoinMessage(
            roomId: options.roomId,
            region: options.region,
            resume: resumeToken.map { RoomJoinMessage.Resume(token: $0) },
            // Only the non-default value goes on the wire (phase 2 §4).
            autoSubscribe: options.autoSubscribe ? nil : false
        )

        return try await withCheckedThrowingContinuation { continuation in
            let timeoutSeconds = options.timings.joinTimeout
            let sleep = env.sleep
            let timeout = Task { [weak self] in
                do { try await sleep(timeoutSeconds) } catch { return }
                await self?.failPendingJoin(generation: gen, error: RTCError(.timeout, "The server did not confirm the room join"),
                                            serverCode: nil, closeCode: nil)
            }
            pendingJoin = PendingJoin(generation: gen, continuation: continuation, sentResume: resumeToken != nil,
                                      isReconnect: isReconnect, timeout: timeout)
            sendNow(.roomJoin(join), on: connection)
        }
    }

    private func startReadLoop(_ connection: WebSocketConnection, generation gen: Int) {
        Task { [weak self] in
            for await event in connection.events {
                guard let self else { return }
                await self.handle(event, generation: gen)
            }
        }
    }

    private func handle(_ event: WebSocketEvent, generation gen: Int) {
        switch event {
        case let .text(text):
            guard gen == generation else { return }
            let message: ServerMessage
            do {
                message = try SignalingCoder.decode(text)
            } catch {
                logger.warn("ignoring unparseable signaling frame")
                return
            }
            if let pending = pendingJoin, pending.generation == gen {
                if case let .roomJoined(joined) = message {
                    completeJoin(pending, joined)
                    return
                }
                if case let .error(code, text) = message {
                    failPendingJoin(generation: gen, error: RTCError.fromServer(code, text), serverCode: code, closeCode: nil)
                    return
                }
            }
            handleMessage(message)

        case let .closed(code, _):
            if pendingJoin?.generation == gen {
                failPendingJoin(generation: gen,
                                error: RTCError(.signalingError, "The signaling connection closed before the room was joined (code \(code))"),
                                serverCode: nil, closeCode: code)
                return
            }
            guard gen == joinedGeneration, gen == generation else { return }
            joinedGeneration = nil
            isJoined = false
            connection = nil
            handleClose(code: code)
        }
    }

    private func completeJoin(_ pending: PendingJoin, _ joined: RoomJoinedMessage) {
        pending.timeout.cancel()
        pendingJoin = nil
        storeResumeToken(joined.resumeToken)
        isJoined = true
        joinedGeneration = pending.generation
        reconnectAttempts = 0
        let payload = JoinedPayload(
            message: joined,
            // Only meaningful if we asked. A server that ignores a resume
            // request it does not understand must read as "fresh".
            resumed: pending.isReconnect && pending.sentResume && joined.resumed == true,
            isReconnect: pending.isReconnect
        )
        logger.info(payload.resumed ? "resumed room session \(joined.roomId)" : "joined room \(joined.roomId)")
        pending.continuation.resume(returning: payload)
        eventSink.yield(.joined(payload))
    }

    private func failPendingJoin(generation gen: Int, error: RTCError, serverCode: SignalingErrorCode?, closeCode: Int?) {
        guard let pending = pendingJoin, pending.generation == gen else { return }
        pending.timeout.cancel()
        pendingJoin = nil
        pending.continuation.resume(throwing: JoinFailure(error: error, serverCode: serverCode, closeCode: closeCode))
        if gen == generation, let connection {
            connection.close(code: CloseCode.normal, reason: "join failed")
            self.connection = nil
        }
    }

    // MARK: Steady state

    private func handleMessage(_ message: ServerMessage) {
        switch message {
        case let .error(code, text):
            if handleErrorFrame(code, text) { return }
        case let .roomResumeToken(token):
            storeResumeToken(token)
            return
        case let .tokenExpiring(expiresAt):
            refreshLiveToken(expiresAt: expiresAt)
            return
        case let .tokenRefreshed(expiresAt):
            if let pending = pendingRefreshToken {
                // Adopted only now, so a reconnect never presents a token
                // the server has not accepted for this session.
                token = pending
                pendingRefreshToken = nil
            }
            logger.debug("rtc token refreshed; session now expires at \(expiresAt)")
            return
        case let .roomLeft(_, reason):
            handleRoomLeft(reason)
        default:
            break
        }
        eventSink.yield(.message(message))
    }

    /// Returns true when the error frame was fully handled here.
    private func handleErrorFrame(_ code: SignalingErrorCode, _ text: String) -> Bool {
        if code == .tokenInvalid {
            // Phase 1 §1.1: a refused refresh is non-fatal.
            pendingRefreshToken = nil
            logger.warn("the server refused the refreshed rtc token: \(text)")
            eventSink.yield(.warning(RTCWarning(code: .tokenRefreshFailed, message: text)))
            return true
        }
        if code == .roomClosed {
            endedReason = .roomClosed
            return true
        }
        if (code == .tokenExpired || code == .tokenRevoked), options.refreshToken != nil, options.autoReconnect {
            // The server closes with 4001 next; with a way to get a new
            // token that is a reconnect, not the end of the call.
            authEndedAwaitingRefresh = true
            logger.warn("rtc token \(code == .tokenExpired ? "expired" : "revoked") on the server; will refresh and reconnect")
            return true
        }
        logger.warn("signaling error \(code.rawValue): \(text)")
        if code.isFatal {
            closedByCaller = true
            clearResume()
            let reason: DisconnectReason = code == .tokenExpired ? .tokenExpired : code == .tokenRevoked ? .tokenRevoked : .connectionFailed
            eventSink.yield(.failed(RTCError.fromServer(code, text), reason))
            connection?.close(code: CloseCode.normal, reason: "fatal error")
            return true
        }
        // Retryable ones (glare, mostly) belong to the owner.
        return false
    }

    private func handleRoomLeft(_ reason: ServerLeaveReason?) {
        guard let reason else { return } // The ack of our own leave.
        if reason == .tokenExpired || reason == .tokenRevoked, options.refreshToken != nil, options.autoReconnect {
            authEndedAwaitingRefresh = true
            return
        }
        switch reason {
        case .removed: endedReason = .removed
        case .roomClosed: endedReason = .roomClosed
        case .tokenExpired: endedReason = .tokenExpired
        case .tokenRevoked: endedReason = .tokenRevoked
        default: endedReason = .removed
        }
        clearResume()
    }

    private func handleClose(code: Int) {
        if closedByCaller {
            eventSink.yield(.closed)
            return
        }

        // 4003, or a session the server already said was over: final,
        // whatever autoReconnect says (phase 1 §1.5).
        if endedReason != nil || code == CloseCode.removed {
            let reason = endedReason ?? .removed
            endedReason = nil
            closedByCaller = true
            clearResume()
            logger.info("the server ended this session: \(reason.rawValue)")
            eventSink.yield(.ended(reason))
            return
        }

        if code == CloseCode.replaced {
            // Another device took over this identity. Reconnecting would
            // evict it, and two clients fighting over one identity is a loop.
            closedByCaller = true
            clearResume()
            eventSink.yield(.ended(.replaced))
            return
        }

        let authFailed = code == CloseCode.authFailed || authEndedAwaitingRefresh
        if authFailed || code == CloseCode.nodeLost {
            // The SFU session went with it; there is nothing to resume.
            clearResume()
        }

        if !options.autoReconnect {
            closedByCaller = true
            eventSink.yield(.failed(
                authFailed ? RTCError(.tokenExpired, "The signaling connection was closed because the RTC token was rejected")
                    : RTCError(.networkError, "The signaling connection closed (code \(code))"),
                authFailed ? .tokenExpired : .connectionFailed))
            return
        }

        if authFailed {
            authEndedAwaitingRefresh = false
            guard options.refreshToken != nil else {
                closedByCaller = true
                eventSink.yield(.failed(RTCError(.tokenExpired, "The RTC token expired. Pass refreshToken to keep long sessions alive"),
                                        .tokenExpired))
                return
            }
            scheduleReconnect(refreshFirst: true, serviceRestart: false)
            return
        }

        if code == CloseCode.serviceRestart {
            logger.info("signaling server restarting; reconnecting with resume")
            scheduleReconnect(refreshFirst: false, serviceRestart: true)
            return
        }
        scheduleReconnect(refreshFirst: false, serviceRestart: false)
    }

    // MARK: Reconnect

    private func scheduleReconnect(refreshFirst: Bool, serviceRestart: Bool) {
        guard !closedByCaller else { return }
        let timings = options.timings
        if reconnectAttempts >= timings.maxReconnectAttempts {
            closedByCaller = true
            eventSink.yield(.failed(RTCError(.connectionFailed, "Could not re-establish signaling after \(timings.maxReconnectAttempts) attempts"),
                                    .connectionFailed))
            return
        }
        reconnectAttempts += 1
        eventSink.yield(.reconnecting(resuming: usableResumeToken() != nil))

        let delay: TimeInterval
        if serviceRestart {
            delay = env.random() * timings.serviceRestartJitter
        } else {
            // Full jitter: a fleet that dropped together does not come back together.
            let cap = min(timings.reconnectBase * pow(2, Double(reconnectAttempts - 1)), timings.reconnectMax)
            delay = env.random() * cap
        }
        scheduledReconnects.append(ScheduledReconnect(attempt: reconnectAttempts, delay: delay,
                                                      kind: serviceRestart ? .serviceRestart : .backoff,
                                                      refreshFirst: refreshFirst))
        logger.info("signaling reconnect attempt \(reconnectAttempts) in \(Int(delay * 1000))ms")

        attemptCounter += 1
        let id = attemptCounter
        pendingAttemptID = id
        let sleep = env.sleep
        reconnectTask = Task { [weak self] in
            // Cancellation (reconnectNow) ends the wait early and runs the attempt.
            try? await sleep(delay)
            await self?.runAttempt(id: id, refreshFirst: refreshFirst)
        }
    }

    private func runAttempt(id: Int, refreshFirst: Bool) async {
        guard pendingAttemptID == id else { return }
        pendingAttemptID = nil
        reconnectTask = nil
        guard !closedByCaller else { return }

        if refreshFirst || tokenExpiresSoon() {
            // Refreshed only when needed: calling the app's backend on every
            // network blip would be a request per reconnect for nothing.
            let refreshed = await tryRefreshToken()
            if closedByCaller { return }
            if !refreshed && refreshFirst {
                logger.warn("reconnecting without a fresh token; the server may reject it again")
            }
        }

        do {
            _ = try await openAndJoin(isReconnect: true)
            if closedByCaller {
                connection?.close(code: CloseCode.normal, reason: "client left")
            }
        } catch let failure as JoinFailure {
            handleReconnectFailure(failure)
        } catch {
            handleReconnectFailure(JoinFailure(error: RTCError(.networkError, "\(error)"), serverCode: nil, closeCode: nil))
        }
    }

    private func handleReconnectFailure(_ failure: JoinFailure) {
        guard !closedByCaller else { return }
        logger.warn("signaling reconnect failed: \(failure.error.message)")
        if let code = failure.serverCode, code == .tokenExpired || code == .tokenRevoked, options.refreshToken != nil {
            scheduleReconnect(refreshFirst: true, serviceRestart: false)
            return
        }
        if let code = failure.serverCode, code.isFatal {
            closedByCaller = true
            let reason: DisconnectReason = code == .tokenExpired ? .tokenExpired : code == .tokenRevoked ? .tokenRevoked : .connectionFailed
            eventSink.yield(.failed(failure.error, reason))
            return
        }
        if failure.closeCode == CloseCode.removed || failure.serverCode == .roomClosed {
            closedByCaller = true
            eventSink.yield(.ended(failure.serverCode == .roomClosed ? .roomClosed : .removed))
            return
        }
        if failure.closeCode == CloseCode.replaced {
            closedByCaller = true
            eventSink.yield(.ended(.replaced))
            return
        }
        scheduleReconnect(refreshFirst: failure.closeCode == CloseCode.authFailed, serviceRestart: false)
    }

    /// Runs a scheduled reconnect now instead of waiting out its backoff —
    /// for when the platform says the network is back.
    func reconnectNow() {
        guard pendingAttemptID != nil else { return }
        reconnectTask?.cancel()
    }

    /// Abandons the current session and joins afresh (new SFU session, new
    /// PeerConnection). For when media is dead but signaling is not.
    func rejoin() {
        guard !closedByCaller else { return }
        clearResume()
        if isJoined, let connection {
            connection.close(code: CloseCode.normal, reason: "client rejoin")
        }
    }

    // MARK: Token

    private func refreshLiveToken(expiresAt: String) {
        guard let refresh = options.refreshToken else {
            logger.warn("rtc token expiring at \(expiresAt) and no refreshToken is configured")
            eventSink.yield(.warning(RTCWarning(code: .tokenExpiring,
                                                message: "The RTC token expires at \(expiresAt) and no refreshToken is configured",
                                                expiresAt: expiresAt)))
            return
        }
        guard !liveRefreshInFlight else { return }
        liveRefreshInFlight = true
        // Off the message path: the app's backend may be slow, and frames
        // keep arriving meanwhile.
        Task { [weak self] in
            do {
                let token = try await refresh()
                await self?.sendRefreshedToken(token)
            } catch {
                await self?.liveRefreshFailed(error, expiresAt: expiresAt)
            }
        }
    }

    private func sendRefreshedToken(_ newToken: String) {
        liveRefreshInFlight = false
        pendingRefreshToken = newToken
        send(.tokenRefresh(token: newToken))
    }

    private func liveRefreshFailed(_ error: Error, expiresAt: String) {
        liveRefreshInFlight = false
        logger.warn("rtc token refresh failed: \(error)")
        eventSink.yield(.warning(RTCWarning(code: .tokenRefreshFailed, message: "refreshToken() failed: \(error)", expiresAt: expiresAt)))
    }

    private func tryRefreshToken() async -> Bool {
        guard let refresh = options.refreshToken else { return false }
        do {
            token = try await refresh()
            pendingRefreshToken = nil
            return true
        } catch {
            logger.warn("rtc token refresh failed: \(error)")
            eventSink.yield(.warning(RTCWarning(code: .tokenRefreshFailed, message: "refreshToken() failed: \(error)")))
            return false
        }
    }

    private func tokenExpiresSoon() -> Bool {
        guard let exp = (try? TokenClaims.decode(token))?.expiresAt else { return false }
        return exp.timeIntervalSince(env.now()) < options.timings.tokenRefreshSkew
    }

    /// Replaces the token used by future reconnects.
    func setToken(_ token: String) {
        self.token = token
    }

    // MARK: Resume token

    private func storeResumeToken(_ token: String?) {
        guard let token, !token.isEmpty else { return }
        resume = (token, env.now())
    }

    private func usableResumeToken() -> String? {
        guard let resume else { return nil }
        if env.now().timeIntervalSince(resume.receivedAt) > options.timings.resumeTokenMaxAge { return nil }
        return resume.token
    }

    private func clearResume() {
        resume = nil
    }

    // MARK: Send / close

    /// Sends a message on the live socket. Dropped, not queued, when there
    /// is none: every message describes one moment in a negotiation, and a
    /// reconnect negotiates from scratch anyway.
    func send(_ message: ClientMessage) {
        guard let connection else {
            logger.debug("dropping signaling message, socket not open: \(message.type)")
            return
        }
        sendNow(message, on: connection)
    }

    private func sendNow(_ message: ClientMessage, on connection: WebSocketConnection) {
        do {
            connection.send(try SignalingCoder.encode(message))
        } catch {
            logger.error("could not encode \(message.type): \(error)")
        }
    }

    /// Leaves the room and closes the socket. No reconnect afterwards.
    func close() {
        closedByCaller = true
        clearResume()
        reconnectTask?.cancel()
        reconnectTask = nil
        pendingAttemptID = nil
        if let pending = pendingJoin {
            failPendingJoin(generation: pending.generation, error: RTCError(.connectionFailed, "Closed by the client"),
                            serverCode: nil, closeCode: nil)
        }
        if let connection {
            if isJoined { sendNow(.roomLeave, on: connection) }
            connection.close(code: CloseCode.normal, reason: "client left")
        } else {
            eventSink.yield(.closed)
        }
        isJoined = false
    }

    /// Ends the event stream. Called by the owner once it is done.
    func finish() {
        eventSink.finish()
    }

    private func buildURL() -> URL {
        // The token rides in a query parameter: it is short-lived by design
        // for exactly this reason, and production requires wss://.
        var components = URLComponents(url: options.endpoint, resolvingAgainstBaseURL: false)
            ?? URLComponents()
        var items = (components.queryItems ?? []).filter { $0.name != "token" }
        items.append(URLQueryItem(name: "token", value: token))
        components.queryItems = items
        // URLComponents leaves '+' unescaped in queries; a JWT has none,
        // but escape defensively so a server never reads a space.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url ?? options.endpoint
    }
}
