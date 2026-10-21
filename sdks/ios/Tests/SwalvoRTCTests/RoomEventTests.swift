import Foundation
import Testing
@testable import SwalvoRTC

/// Server messages → Room state and events, with a fake socket and a fake
/// media engine (no WebRTC, no network).
@MainActor
@Suite(.serialized) final class RoomEventTests {
    private var factory: FakeSocketFactory!
    private var engine: FakeEngine!
    private var room: Room!
    private var recorder: Recorder<RoomEvent>!
    private var socket: FakeConnection!

    private nonisolated static let bobRoster = #"""
    {"type":"room.joined","roomId":"room_123","rtcServer":"sfu-1","region":"ap-south","resumeToken":"rt-1",
     "participants":[{"id":"bob","tracks":[{"trackId":"bob-cam","kind":"video","source":"camera","muted":false,"simulcast":true}]}]}
    """#

    private func connect(options: RoomOptions = RoomOptions(), token: String = makeToken(), roster: String = bobRoster,
                         cryptors: FakeCryptorBackend? = nil) async throws {
        var options = options
        options.timings = fastTimings()
        factory = FakeSocketFactory()
        engine = FakeEngine()
        room = Room(options: options, socketFactory: factory, engine: engine, environment: testEnvironment(), logger: RTCLogger(),
                    cryptorBackend: { cryptors })
        recorder = Recorder(room.events())
        let factory = self.factory!
        let connectTask = Task { @MainActor in try await self.room.connect(token: token, endpoint: URL(string: "wss://x/v1/rtc")!) }
        socket = await factory.connection(0)
        let socket = self.socket!
        await waitUntil { socket.sent.count == 1 }
        socket.serverSend(roster)
        try await connectTask.value
    }

    private func names() -> [String] { recorder.events.map(\.name) }

    private func waitFor(_ name: String, count: Int = 1, sourceLocation: SourceLocation = #_sourceLocation) async {
        await waitUntil(sourceLocation: sourceLocation) { @MainActor in self.names().filter { $0 == name }.count >= count }
    }

    // MARK: Join

    @Test func testJoinBuildsRosterAndEmitsInOrder() async throws {
        try await connect()
        #expect((room.connectionState) == (.connected))
        #expect((room.localParticipant.identity) == ("alice"))
        #expect((room.roomId) == ("room_123"))
        #expect((Array(room.remoteParticipants.keys)) == (["bob"]))
        #expect((engine.resetCount) == (1))
        await waitFor("connected")
        #expect((names()) == (["connectionStateChanged", "participantJoined", "trackPublished", "connectionStateChanged", "connected"]))
        if case let .trackPublished(kind, participant) = recorder.events[2] {
            #expect((kind) == (.camera))
            #expect((participant.identity) == ("bob"))
        } else { Issue.record("failed") }
        #expect((getDiag().rtcServer) == ("sfu-1"))
    }

    private func getDiag() -> ConnectionDiagnostics { room.getDiagnostics() }

    @Test func testRoomMismatchFailsBeforeConnecting() async {
        let room = Room(options: RoomOptions(), socketFactory: FakeSocketFactory(), engine: FakeEngine(),
                        environment: testEnvironment(), logger: RTCLogger())
        do {
            try await room.connect(token: makeToken(rid: "room_123", rnm: "standup"), endpoint: URL(string: "wss://x")!, roomId: "other")
            Issue.record("should throw")
        } catch let error as RTCError {
            #expect((error.code) == (.roomNotFound))
        } catch { Issue.record("\(error)") }
    }

    @Test func testExpiredTokenIsRejectedUpFront() async {
        let room = Room(options: RoomOptions(), socketFactory: FakeSocketFactory(), engine: FakeEngine(),
                        environment: testEnvironment(), logger: RTCLogger())
        do {
            try await room.connect(token: makeToken(exp: 1000), endpoint: URL(string: "wss://x")!)
            Issue.record("should throw")
        } catch let error as RTCError {
            #expect((error.code) == (.tokenExpired))
        } catch { Issue.record("\(error)") }
    }

    // MARK: Negotiation plumbing

    @Test func testOfferIsAnsweredAndCandidatesApplied() async throws {
        try await connect()
        socket.serverSend(#"{"type":"sdp.offer","sdp":"o1"}"#)
        socket.serverSend(#"{"type":"ice.candidate","candidate":"c1","sdpMid":"0"}"#)
        await waitUntil { @MainActor in self.engine.candidates.count == 1 }
        #expect((engine.offers) == (["o1"]))
        await waitUntil { self.socket.sentMessages.contains(.sdpAnswer(sdp: "answer-to:o1")) }
        // Answer before anything else the engine sent after it.
        socket.serverSend(#"{"type":"error","code":"NEGOTIATION_GLARE","message":"retry"}"#)
        await waitUntil { @MainActor in self.engine.glareCount == 1 }
        #expect(!(names().contains("error")), "glare is retried, not surfaced")
    }

    // MARK: Tracks

    @Test func testTrackSubscribedWhenMediaArrivesAfterAnnouncement() async throws {
        try await connect()
        engine.deliverRemoteTrack("bob-cam")
        await waitFor("trackSubscribed")
        let bob = try #require(room.remoteParticipants["bob"])
        #expect((bob.tracks.map(\.trackId)) == (["bob-cam"]))
        #expect((bob.tracks.first?.kind) == (.camera))
    }

    @Test func testTrackSubscribedWhenMediaArrivesBeforeAnnouncement() async throws {
        try await connect()
        engine.deliverRemoteTrack("bob-screen")
        #expect(!(names().contains("trackSubscribed")), "parked until track.published")
        socket.serverSend(#"{"type":"track.published","participantId":"bob","track":{"trackId":"bob-screen","kind":"video","source":"screenShare","muted":false,"simulcast":false}}"#)
        await waitFor("trackSubscribed")
        #expect((room.remoteParticipants["bob"]?.tracks.first?.kind) == (.screenShare))
    }

    @Test func testUnpublishAndParticipantLeft() async throws {
        try await connect()
        engine.deliverRemoteTrack("bob-cam")
        await waitFor("trackSubscribed")
        socket.serverSend(#"{"type":"participant.left","participant":{"id":"bob","tracks":[]}}"#)
        await waitFor("participantLeft")
        let tail = Array(names().suffix(3))
        #expect((tail) == (["trackUnsubscribed", "trackUnpublished", "participantLeft"]))
        #expect(room.remoteParticipants.isEmpty)
    }

    @Test func testRemoteMuteAndUnmute() async throws {
        try await connect()
        engine.deliverRemoteTrack("bob-cam")
        socket.serverSend(#"{"type":"track.muted","participantId":"bob","trackId":"bob-cam"}"#)
        await waitFor("trackMuted")
        #expect((room.remoteParticipants["bob"]?.tracks.first?.isMuted) == (true))
        socket.serverSend(#"{"type":"track.unmuted","participantId":"bob","trackId":"bob-cam"}"#)
        await waitFor("trackUnmuted")
        #expect((room.remoteParticipants["bob"]?.tracks.first?.isMuted) == (false))
    }

    // MARK: Phase 2

    @Test func testActiveSpeakersIncludeLocalParticipant() async throws {
        try await connect()
        socket.serverSend(#"{"type":"speakers.changed","speakers":[{"participantId":"alice","level":0.9},{"participantId":"bob","level":0.4}]}"#)
        await waitFor("activeSpeakersChanged")
        #expect((room.activeSpeakers.map(\.identity)) == (["alice", "bob"]))
        #expect(room.localParticipant.isSpeaking)
        #expect(abs((room.remoteParticipants["bob"]?.audioLevel ?? 0) - (0.4)) <= 1e-9)
        socket.serverSend(#"{"type":"speakers.changed","speakers":[]}"#)
        await waitFor("activeSpeakersChanged", count: 2)
        #expect(room.activeSpeakers.isEmpty)
        #expect(!(room.localParticipant.isSpeaking))
    }

    @Test func testConnectionQualityChangedOnlyOnChange() async throws {
        try await connect()
        #expect((room.localParticipant.connectionQuality) == (.unknown))
        socket.serverSend(#"{"type":"quality.changed","updates":[{"participantId":"alice","quality":"poor"}]}"#)
        socket.serverSend(#"{"type":"quality.changed","updates":[{"participantId":"alice","quality":"poor"},{"participantId":"bob","quality":"good"}]}"#)
        await waitFor("connectionQualityChanged", count: 2)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect((names().filter { $0 == "connectionQualityChanged" }.count) == (2))
        #expect((room.localParticipant.connectionQuality) == (.poor))
        #expect((room.remoteParticipants["bob"]?.connectionQuality) == (.good))
    }

    @Test func testSubscriptionStateAppliesAndIsKeptForLateTracks() async throws {
        try await connect()
        // Arrives before the track: kept.
        socket.serverSend(#"{"type":"subscription.state","publisherId":"bob","trackId":"bob-cam","state":"paused_bandwidth"}"#)
        try await Task.sleep(nanoseconds: 30_000_000)
        engine.deliverRemoteTrack("bob-cam")
        await waitFor("trackSubscribed")
        let track = try #require(room.remoteParticipants["bob"]?.tracks.first)
        #expect((track.subscriptionState) == (.pausedBandwidth))

        socket.serverSend(#"{"type":"subscription.state","publisherId":"bob","trackId":"bob-cam","state":"active","layer":"medium"}"#)
        await waitFor("trackSubscriptionStateChanged")
        #expect((track.subscriptionState) == (.active))
        #expect((track.layer) == (.medium))
    }

    @Test func testPublisherLayersGoToTheEngine() async throws {
        try await connect()
        socket.serverSend(#"{"type":"publisher.layers","trackId":"cam-1","layers":[{"rid":"q","active":true},{"rid":"f","active":false}]}"#)
        await waitUntil { @MainActor in self.engine.layerFrames.count == 1 }
        #expect((engine.layerFrames.first?.0) == ("cam-1"))
        #expect((engine.layerFrames.first?.1) == ([LayerActivity(rid: "q", active: true), LayerActivity(rid: "f", active: false)]))
    }

    @Test func testSetEnabledSendsLayerOffAndBack() async throws {
        var options = RoomOptions()
        options.adaptiveStream = false
        try await connect(options: options)
        engine.deliverRemoteTrack("bob-cam")
        await waitFor("trackSubscribed")
        let track = try #require(room.remoteParticipants["bob"]?.tracks.first)
        track.setEnabled(false)
        await waitUntil { self.socket.sentMessages.contains(.subscriptionUpdate(publisherId: "bob", trackId: "bob-cam", layer: .off)) }
        track.setEnabled(false) // no change → nothing sent
        track.setEnabled(true)
        await waitUntil { self.socket.sentMessages.contains(.subscriptionUpdate(publisherId: "bob", trackId: "bob-cam", layer: .auto)) }
        track.setLayer(.low)
        await waitUntil { self.socket.sentMessages.contains(.subscriptionUpdate(publisherId: "bob", trackId: "bob-cam", layer: .low)) }
        let updates = socket.sentMessages.filter { if case .subscriptionUpdate = $0 { return true } else { return false } }
        #expect((updates.count) == (3))
    }

    @Test func testAutoSubscribeOffStartsPausedClient() async throws {
        var options = RoomOptions()
        options.autoSubscribe = false
        options.adaptiveStream = false
        try await connect(options: options)
        #expect((socket.sentJSON.first?["autoSubscribe"] as? Bool) == (false))
        engine.deliverRemoteTrack("bob-cam")
        await waitFor("trackSubscribed")
        let track = try #require(room.remoteParticipants["bob"]?.tracks.first)
        #expect((track.subscriptionState) == (.pausedClient))
        #expect(!(track.isEnabled))
        track.setEnabled(true)
        await waitUntil { self.socket.sentMessages.contains(.subscriptionUpdate(publisherId: "bob", trackId: "bob-cam", layer: .auto)) }
    }

    // MARK: Phase 1: permissions, server mute, removal

    @Test func testPermissionsRevokedUnpublishesWithoutError() async throws {
        try await connect()
        let camera = LocalTrack(trackId: "cam-1", source: .camera, mediaStreamTrack: nil)
        let mic = LocalTrack(trackId: "mic-1", source: .microphone, mediaStreamTrack: nil)
        try await room.publish(camera)
        try await room.publish(mic)
        await waitUntil { self.socket.sentMessages.contains(.trackPublish(trackId: "cam-1", source: .camera)) }
        socket.serverSend(#"{"type":"participant.permissions_updated","permissions":{"subscribe":true,"publish":true,"publishAudio":true,"publishVideo":false,"publishData":true}}"#)
        await waitFor("permissionsChanged")
        #expect((room.localParticipant.tracks.map(\.trackId)) == (["mic-1"]))
        #expect((engine.unpublished) == (["cam-1"]))
        #expect(!(names().contains("error")))
        let unpublishedIndex = try #require(names().lastIndex(of: "localTrackUnpublished"))
        #expect((unpublishedIndex) < (try #require(names().lastIndex(of: "permissionsChanged"))))
        #expect((room.permissions?.publishVideo) == (false))

        // Publishing what is no longer allowed is refused locally.
        do {
            try await room.publish(LocalTrack(trackId: "cam-2", source: .camera, mediaStreamTrack: nil))
            Issue.record("should throw")
        } catch let error as RTCError {
            #expect((error.code) == (.permissionDenied))
        }
    }

    @Test func testServerMuteOfOwnTrack() async throws {
        try await connect()
        let mic = LocalTrack(trackId: "mic-1", source: .microphone, mediaStreamTrack: nil)
        try await room.publish(mic)
        socket.serverSend(#"{"type":"track.muted","participantId":"alice","trackId":"mic-1","byServer":true}"#)
        await waitFor("localTrackMutedByServer")
        #expect(mic.isMuted)
        #expect(!(names().contains("trackMuted")), "local mutes are not remote trackMuted events")
    }

    @Test func testLocalMuteSendsTrackMute() async throws {
        try await connect()
        let mic = LocalTrack(trackId: "mic-1", source: .microphone, mediaStreamTrack: nil)
        try await room.publish(mic)
        await mic.mute()
        await waitUntil { self.socket.sentMessages.contains(.trackMute(trackId: "mic-1", muted: true)) }
    }

    @Test func testRemovedDisconnectsWithReasonAndNoReconnect() async throws {
        try await connect()
        socket.serverSend(#"{"type":"room.left","roomId":"room_123","reason":"REMOVED"}"#)
        socket.serverClose(4003)
        await waitFor("disconnected")
        if case let .disconnected(reason) = recorder.events.last { #expect((reason) == (.removed)) } else { Issue.record("failed") }
        #expect((room.connectionState) == (.disconnected))
        #expect((room.disconnectReason) == (.removed))
        #expect(engine.closed)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect((factory.connections.count) == (1))
    }

    @Test func testLeaveIsClientInitiated() async throws {
        try await connect()
        await room.leave()
        #expect((room.disconnectReason) == (.clientInitiated))
        #expect((socket.sentMessages.last) == (.roomLeave))
        await waitFor("disconnected")
    }

    // MARK: Resume at the room level

    @Test func testResumedReconnectKeepsPeerConnection() async throws {
        try await connect()
        engine.deliverRemoteTrack("bob-cam")
        await waitFor("trackSubscribed")
        socket.serverClose(1012)
        await waitFor("reconnecting")
        let second = await factory.connection(1)
        await waitUntil { second.sent.count == 1 }
        #expect((second.sentJSON.first?["resume"] as? [String: String]) == (["token": "rt-1"]))
        second.serverSend(#"{"type":"room.joined","roomId":"room_123","resumed":true,"resumeToken":"rt-2","participants":[{"id":"bob","tracks":[{"trackId":"bob-cam","kind":"video","source":"camera","muted":false,"simulcast":true}]}]}"#)
        await waitFor("reconnected")
        #expect((engine.resetCount) == (1), "resumed: keep the PeerConnection")
        #expect(!(names().contains("trackUnsubscribed")))
        #expect((names().filter { $0 == "participantJoined" }.count) == (1), "no replayed roster")
    }

    @Test func testFreshRejoinRebuildsPeerConnectionAndRepublishes() async throws {
        try await connect()
        try await room.publish(LocalTrack(trackId: "mic-1", source: .microphone, mediaStreamTrack: nil))
        engine.deliverRemoteTrack("bob-cam")
        await waitFor("trackSubscribed")
        socket.serverClose(1012)
        let second = await factory.connection(1)
        await waitUntil { second.sent.count == 1 }
        second.serverSend(#"{"type":"room.joined","roomId":"room_123","resumed":false,"participants":[]}"#)
        await waitFor("reconnected")
        #expect((engine.resetCount) == (2), "resumed: false → new PeerConnection")
        #expect(names().contains("trackUnsubscribed"))
        #expect(names().contains("participantLeft"), "bob is gone from the fresh roster")
        await waitUntil { second.sentMessages.contains(.trackPublish(trackId: "mic-1", source: .microphone)) }
    }

    @Test func testPassphraseSaltIsTheTokenRidClaim() async throws {
        let roster = #"{"type":"room.joined","roomId":"server-echo-id","participants":[]}"#
        try await connect(token: makeToken(rid: "room_rid_claim", rnm: "standup", e2ee: true), roster: roster)
        try room.setE2EEPassphrase("correct horse battery staple")
        let current = try #require(room.e2eeKeyProvider.currentKey(participantId: "anyone"))
        #expect(current.set.material == E2EEKeyDerivation.material(passphrase: "correct horse battery staple", roomId: "room_rid_claim"))
    }

    @Test func testE2EERoomRefusesToPublish() async throws {
        try await connect(token: makeToken(e2ee: true))
        #expect(room.isE2EE)
        do {
            try await room.publish(LocalTrack(trackId: "mic-1", source: .microphone, mediaStreamTrack: nil))
            Issue.record("should refuse")
        } catch let error as RTCError {
            #expect((error.code) == (.e2eeRequired), "no key provider configured: E2EE_REQUIRED, as the web SDK")
        }
        #expect(engine.published.isEmpty, "nothing unencrypted reaches the engine")
    }

    @Test func testE2EERoomWithoutFrameCryptoRefusesAsNotSupported() async throws {
        var options = RoomOptions()
        options.e2eeKeyProvider = E2EEKeyProvider()
        try await connect(options: options, token: makeToken(e2ee: true), cryptors: nil)
        #expect(!room.isE2EEActive)
        do {
            try await room.publish(LocalTrack(trackId: "mic-1", source: .microphone, mediaStreamTrack: nil))
            Issue.record("should refuse")
        } catch let error as RTCError {
            #expect((error.code) == (.e2eeNotSupported))
        }
        #expect(engine.published.isEmpty)
    }

    @Test func testConfiguredE2EERoomEncryptsEverySenderAndReceiver() async throws {
        let keys = E2EEKeyProvider()
        var options = RoomOptions()
        options.e2eeKeyProvider = keys
        let cryptors = FakeCryptorBackend()
        try await connect(options: options, token: makeToken(rid: "room_rid", e2ee: true), cryptors: cryptors)
        #expect(room.isE2EEActive)
        #expect(cryptors.providerOptions == [.swalvo(sharedKeyMode: true, ratchetWindow: 8, failureTolerance: -1, keyRingSize: 16)])
        try room.setE2EEPassphrase("pw")
        #expect(cryptors.keyProvider.calls == [.setShared(E2EEKeyDerivation.material(passphrase: "pw", roomId: "room_rid"), 0)])

        try await room.publish(LocalTrack(trackId: "mic-1", source: .microphone, mediaStreamTrack: nil))
        #expect(engine.published.map(\.trackId) == ["mic-1"])
        let sender = try #require(cryptors.senderCryptors.first)
        #expect(sender.target === engine.senders["mic-1"] && sender.participantId == "alice" && sender.isEnabled)

        // bob's camera (from the roster) arrives: decrypted as bob.
        engine.deliverRemoteTrack("bob-cam")
        await waitFor("trackSubscribed")
        let receiver = try #require(cryptors.receiverCryptors.first)
        #expect(receiver.target === engine.receivers["bob-cam"] && receiver.participantId == "bob" && receiver.isEnabled)

        // Cryptor callbacks become e2eeStateChanged, once per change.
        receiver.fire(.decryptionFailed)
        receiver.fire(.decryptionFailed)
        sender.fire(.ok)
        receiver.fire(.keyRatcheted)
        await waitFor("e2eeStateChanged", count: 3)
        let changes = recorder.events.compactMap { event -> (String, E2EEState)? in
            if case let .e2eeStateChanged(participant, state) = event { return (participant.identity, state) }
            return nil
        }
        #expect(changes.map(\.0) == ["bob", "alice", "bob"])
        #expect(changes.map(\.1) == [.decryptFailed, .ok, .ok])
        #expect(room.remoteParticipants["bob"]?.e2eeState == .ok)

        await room.unpublish(room.localParticipant.tracks[0])
        #expect(!sender.isEnabled, "an unpublished sender's cryptor is released")
    }

    @Test func testKeysSetAfterJoinStartEncryption() async throws {
        let cryptors = FakeCryptorBackend()
        try await connect(token: makeToken(e2ee: true), cryptors: cryptors)
        #expect(!room.isE2EEActive, "no key provider configured yet")
        room.setKey(participantId: "alice", key: Data(repeating: 7, count: 32), keyIndex: 1)
        #expect(room.isE2EEActive)
        #expect(cryptors.providerOptions.first?.sharedKeyMode == false)
        try await room.publish(LocalTrack(trackId: "mic-1", source: .microphone, mediaStreamTrack: nil))
        #expect(cryptors.senderCryptors.first?.keyIndex == 1)
    }

    @Test func testConfiguredE2EEDoesNothingInAnOrdinaryRoom() async throws {
        var options = RoomOptions()
        options.e2eeKeyProvider = E2EEKeyProvider()
        let cryptors = FakeCryptorBackend()
        try await connect(options: options, token: makeToken(e2ee: false), cryptors: cryptors)
        #expect(!room.isE2EEActive)
        try await room.publish(LocalTrack(trackId: "mic-1", source: .microphone, mediaStreamTrack: nil))
        #expect(cryptors.cryptors.isEmpty && cryptors.providerOptions.isEmpty, "media is sent as usual, like the web SDK")
    }
}
