import Foundation
import Testing
@testable import SwalvoRTC

/// The signaling state machine against a scripted fake WebSocket: join,
/// resume, close codes, token refresh.
@Suite(.serialized) final class SignalingClientTests {
    private let endpoint = URL(string: "wss://api.example.com/v1/rtc")!

    private func makeClient(token: String = makeToken(), autoReconnect: Bool = true, autoSubscribe: Bool = true,
                            refresh: (@Sendable () async throws -> String)? = nil,
                            factory: FakeSocketFactory) -> SignalingClient {
        var options = SignalingOptions(endpoint: endpoint, token: token)
        options.roomId = "room_123"
        options.autoReconnect = autoReconnect
        options.autoSubscribe = autoSubscribe
        options.refreshToken = refresh
        options.timings = fastTimings()
        return SignalingClient(options: options, factory: factory, environment: testEnvironment())
    }

    private func joined(resumeToken: String? = "rt-1", resumed: Bool? = nil) -> String {
        var fields = #""type":"room.joined","roomId":"room_123","participants":[]"#
        if let resumeToken { fields += #","resumeToken":"\#(resumeToken)""# }
        if let resumed { fields += #","resumed":\#(resumed)"# }
        return "{\(fields)}"
    }

    /// Connects and completes the join on connection 0.
    private func connectJoined(_ client: SignalingClient, _ factory: FakeSocketFactory,
                               resumeToken: String? = "rt-1") async throws -> FakeConnection {
        async let result = client.connect()
        let socket = await factory.connection(0)
        await waitUntil { socket.sent.count == 1 }
        socket.serverSend(joined(resumeToken: resumeToken))
        let payload = try await result
        #expect(!(payload.resumed))
        #expect(!(payload.isReconnect))
        return socket
    }

    private func roomJoin(_ message: ClientMessage?) -> RoomJoinMessage? {
        if case let .roomJoin(join) = message { return join }
        return nil
    }

    // MARK: Join

    @Test func testJoinSendsRoomJoinFirstAndPutsTokenInQuery() async throws {
        let factory = FakeSocketFactory()
        let token = makeToken()
        let client = makeClient(token: token, factory: factory)
        let socket = try await connectJoined(client, factory)

        let components = try #require(URLComponents(url: socket.url, resolvingAgainstBaseURL: false))
        #expect((components.queryItems?.first { $0.name == "token" }?.value) == (token))
        let join = try #require(roomJoin(socket.sentMessages.first))
        #expect((join.roomId) == ("room_123"))
        #expect((join.resume) == nil, "a first join never carries resume")
        #expect((join.autoSubscribe) == nil)
        let isJoined = await client.isJoined
        #expect(isJoined)
    }

    @Test func testAutoSubscribeFalseGoesOnTheJoin() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(autoSubscribe: false, factory: factory)
        let socket = try await connectJoined(client, factory)
        #expect((socket.sentJSON.first?["autoSubscribe"] as? Bool) == (false))
    }

    @Test func testJoinErrorFrameFailsConnect() async {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        async let result = client.connect()
        let socket = await factory.connection(0)
        await waitUntil { socket.sent.count == 1 }
        socket.serverSend(#"{"type":"error","code":"INVALID_TOKEN","message":"bad"}"#)
        socket.serverClose(4001)
        do {
            _ = try await result
            Issue.record("connect should throw")
        } catch let error as RTCError {
            #expect((error.code) == (.invalidToken))
        } catch {
            Issue.record("unexpected \(error)")
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect((factory.connections.count) == (1), "a failed first join is never retried")
    }

    @Test func testResumedFlagIgnoredOnFirstJoin() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        async let result = client.connect()
        let socket = await factory.connection(0)
        await waitUntil { socket.sent.count == 1 }
        socket.serverSend(joined(resumed: true))
        let payload = try await result
        #expect(!(payload.resumed), "only a join that asked to resume can be resumed")
    }

    // MARK: 1012 + resume

    @Test func testServiceRestartReconnectsWithJitterAndResume() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let events = Recorder(client.events)
        let first = try await connectJoined(client, factory)
        first.serverSend(#"{"type":"room.resume_token","resumeToken":"rt-2"}"#)
        await waitUntil { await client.currentResumeToken == "rt-2" }

        first.serverClose(1012)
        let second = await factory.connection(1)
        await waitUntil { second.sent.count == 1 }
        #expect((roomJoin(second.sentMessages.first)?.resume?.token) == ("rt-2"), "the latest resume token is offered")

        let schedule = await client.scheduledReconnects
        #expect((schedule.last?.kind) == (.serviceRestart))
        #expect(abs((schedule.last?.delay ?? -1) - (0.5 * fastTimings().serviceRestartJitter)) <= 1e-9)

        second.serverSend(joined(resumeToken: "rt-3", resumed: true))
        await waitUntil {
            events.events.contains { if case let .joined(p) = $0 { return p.isReconnect } else { return false } }
        }
        let rejoin = events.events.compactMap { event -> JoinedPayload? in
            if case let .joined(p) = event, p.isReconnect { return p }
            return nil
        }.first
        #expect((rejoin?.resumed) == (true))
        #expect(events.events.contains { if case .reconnecting(resuming: true) = $0 { return true } else { return false } })
    }

    @Test func testResumeRefusedIsAFreshJoin() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let events = Recorder(client.events)
        let first = try await connectJoined(client, factory)
        first.serverClose(1012)
        let second = await factory.connection(1)
        await waitUntil { second.sent.count == 1 }
        #expect((roomJoin(second.sentMessages.first)?.resume) != nil)
        second.serverSend(joined(resumeToken: "rt-9", resumed: false))
        await waitUntil {
            events.events.contains { if case let .joined(p) = $0 { return p.isReconnect && !p.resumed } else { return false } }
        }
        let token = await client.currentResumeToken
        #expect((token) == ("rt-9"))
    }

    @Test func testAbnormalCloseBacksOffAndResumes() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let first = try await connectJoined(client, factory)
        first.serverClose(1006)
        let second = await factory.connection(1)
        await waitUntil { second.sent.count == 1 }
        #expect((roomJoin(second.sentMessages.first)?.resume?.token) == ("rt-1"))
        let schedule = await client.scheduledReconnects
        #expect((schedule.first?.kind) == (.backoff))
        #expect(abs((schedule.first?.delay ?? -1) - (0.5 * fastTimings().reconnectBase)) <= 1e-9)
    }

    @Test func testBackoffGrowsExponentiallyUpToTheCap() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let socket = try await connectJoined(client, factory)
        // Every reopen fails until we have seen several attempts.
        factory.failOpens = 4
        socket.serverClose(1006)
        await waitUntil { await client.scheduledReconnects.count >= 5 }
        let delays = await client.scheduledReconnects.prefix(5).map(\.delay)
        let t = fastTimings()
        let expected = (0..<5).map { 0.5 * min(t.reconnectBase * pow(2, Double($0)), t.reconnectMax) }
        for (got, want) in zip(delays, expected) { #expect(abs((got) - (want)) <= 1e-9) }
    }

    @Test func testNodeLostReconnectsWithoutResume() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let first = try await connectJoined(client, factory)
        first.serverClose(4004)
        let second = await factory.connection(1)
        await waitUntil { second.sent.count == 1 }
        #expect((roomJoin(second.sentMessages.first)?.resume) == nil, "4004: the SFU session is gone")
    }

    // MARK: Final closes

    @Test func testRemovedCloseNeverReconnects() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let events = Recorder(client.events)
        let first = try await connectJoined(client, factory)
        first.serverClose(4003)
        await waitUntil { events.events.contains { if case .ended(.removed) = $0 { return true } else { return false } } }
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect((factory.connections.count) == (1), "never reconnect after 4003")
    }

    @Test func testRoomLeftReasonIsReported() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let events = Recorder(client.events)
        let first = try await connectJoined(client, factory)
        first.serverSend(#"{"type":"room.left","roomId":"room_123","reason":"ROOM_CLOSED"}"#)
        first.serverClose(4003)
        await waitUntil { events.events.contains { if case .ended(.roomClosed) = $0 { return true } else { return false } } }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect((factory.connections.count) == (1))
    }

    @Test func testReplacedCloseDoesNotReconnect() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let events = Recorder(client.events)
        let first = try await connectJoined(client, factory)
        first.serverClose(4002)
        await waitUntil { events.events.contains { if case .ended(.replaced) = $0 { return true } else { return false } } }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect((factory.connections.count) == (1))
    }

    // MARK: Auth (4001)

    @Test func testAuthCloseRefreshesThenReconnectsWithNewToken() async throws {
        let factory = FakeSocketFactory()
        let fresh = makeToken(sub: "alice", rid: "room_123")
        let client = makeClient(refresh: { fresh }, factory: factory)
        let first = try await connectJoined(client, factory)
        first.serverSend(#"{"type":"room.left","roomId":"room_123","reason":"TOKEN_EXPIRED"}"#)
        first.serverSend(#"{"type":"error","code":"TOKEN_EXPIRED","message":"expired"}"#)
        first.serverClose(4001)
        let second = await factory.connection(1)
        await waitUntil { second.sent.count == 1 }
        let token = URLComponents(url: second.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "token" }?.value
        #expect((token) == (fresh))
        #expect((roomJoin(second.sentMessages.first)?.resume) == nil, "4001 ends the SFU session; nothing to resume")
        let schedule = await client.scheduledReconnects
        #expect((schedule.last?.refreshFirst) == (true))
    }

    @Test func testAuthCloseWithoutRefreshFails() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let events = Recorder(client.events)
        let first = try await connectJoined(client, factory)
        first.serverClose(4001)
        await waitUntil {
            events.events.contains { if case .failed(_, .tokenExpired) = $0 { return true } else { return false } }
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect((factory.connections.count) == (1))
    }

    @Test func testFatalErrorFrameMidSessionFails() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let events = Recorder(client.events)
        let first = try await connectJoined(client, factory)
        first.serverSend(#"{"type":"error","code":"USAGE_LIMIT_EXCEEDED","message":"out of minutes"}"#)
        await waitUntil {
            events.events.contains { if case let .failed(error, .connectionFailed) = $0 { return error.code == .usageLimitExceeded } else { return false } }
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect((factory.connections.count) == (1))
    }

    // MARK: Live token refresh

    @Test func testTokenExpiringRefreshesInPlace() async throws {
        let factory = FakeSocketFactory()
        let fresh = makeToken(sub: "alice", rid: "room_123", rnm: "fresh")
        let client = makeClient(refresh: { fresh }, factory: factory)
        let socket = try await connectJoined(client, factory)
        socket.serverSend(#"{"type":"token.expiring","expiresAt":"2026-10-02T12:00:00.000Z"}"#)
        await waitUntil { socket.sentMessages.contains(.tokenRefresh(token: fresh)) }
        // Not adopted until the server confirms it.
        let before = await client.token
        #expect((before) != (fresh))
        socket.serverSend(#"{"type":"token.refreshed","expiresAt":"2026-10-02T12:10:00.000Z"}"#)
        await waitUntil { await client.token == fresh }
        #expect((factory.connections.count) == (1), "a live refresh never reconnects")

        // The next reconnect presents the refreshed token.
        socket.serverClose(1006)
        let second = await factory.connection(1)
        let token = URLComponents(url: second.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "token" }?.value
        #expect((token) == (fresh))
    }

    @Test func testTokenExpiringWithoutRefreshWarns() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let events = Recorder(client.events)
        let socket = try await connectJoined(client, factory)
        socket.serverSend(#"{"type":"token.expiring","expiresAt":"2026-10-02T12:00:00.000Z"}"#)
        await waitUntil {
            events.events.contains { if case let .warning(w) = $0 { return w.code == .tokenExpiring && w.expiresAt == "2026-10-02T12:00:00.000Z" } else { return false } }
        }
    }

    @Test func testRefusedRefreshIsANonFatalWarning() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(refresh: { "x.y.z" }, factory: factory)
        let events = Recorder(client.events)
        let socket = try await connectJoined(client, factory)
        socket.serverSend(#"{"type":"token.expiring","expiresAt":"2026-10-02T12:00:00.000Z"}"#)
        await waitUntil { socket.sentMessages.contains(.tokenRefresh(token: "x.y.z")) }
        socket.serverSend(#"{"type":"error","code":"TOKEN_INVALID","message":"different identity"}"#)
        await waitUntil {
            events.events.contains { if case let .warning(w) = $0 { return w.code == .tokenRefreshFailed } else { return false } }
        }
        let joined = await client.isJoined
        #expect(joined)
        #expect(!(socket.isClosed))
    }

    // MARK: Messages and close

    @Test func testMessagesAreForwardedInOrder() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let events = Recorder(client.events)
        let socket = try await connectJoined(client, factory)
        socket.serverSend(#"{"type":"sdp.offer","sdp":"o1"}"#)
        socket.serverSend(#"{"type":"ice.candidate","candidate":"c1"}"#)
        socket.serverSend(#"{"type":"error","code":"NEGOTIATION_GLARE","message":"retry"}"#)
        await waitUntil { events.events.count >= 4 }
        let messages = events.events.compactMap { event -> ServerMessage? in
            if case let .message(m) = event { return m }
            return nil
        }
        #expect((messages) == ([.sdpOffer(sdp: "o1"), .iceCandidate(ICECandidatePayload(candidate: "c1")),
                                  .error(code: .negotiationGlare, message: "retry")]))
    }

    @Test func testCloseSendsLeaveAndDoesNotReconnect() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(factory: factory)
        let events = Recorder(client.events)
        let socket = try await connectJoined(client, factory)
        await client.close()
        #expect((socket.sentMessages.last) == (.roomLeave))
        #expect((socket.clientCloseCode) == (1000))
        await waitUntil { events.events.contains { if case .closed = $0 { return true } else { return false } } }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect((factory.connections.count) == (1))
    }

    @Test func testAutoReconnectOffFailsOnDrop() async throws {
        let factory = FakeSocketFactory()
        let client = makeClient(autoReconnect: false, factory: factory)
        let events = Recorder(client.events)
        let socket = try await connectJoined(client, factory)
        socket.serverClose(1006)
        await waitUntil {
            events.events.contains { if case .failed(_, .connectionFailed) = $0 { return true } else { return false } }
        }
    }
}
