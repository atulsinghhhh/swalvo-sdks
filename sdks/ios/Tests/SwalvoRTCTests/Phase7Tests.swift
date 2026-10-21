import AVFoundation
import Foundation
import Testing
@testable import SwalvoRTC

/// Phase 7 (docs/architecture/phase7-contracts.md): the data envelope
/// against the shared vectors, data v2 sending/receiving, participant
/// metadata, and screen-share audio plumbing.
@Suite struct DataEnvelopeVectorTests {
    private struct Vectors: Decodable {
        struct EncodeInput: Decodable {
            let topic: String
            let destinationIdentities: [String]
            let payloadHex: String
        }
        struct EncodeCase: Decodable { let name: String; let input: EncodeInput; let expectedHex: String? }
        struct DecodeExpected: Decodable {
            let legacy: Bool
            let senderIdentity: String?
            let topic: String?
            let payloadHex: String
        }
        struct DecodeCase: Decodable { let name: String; let inputHex: String; let expected: DecodeExpected }
        let encode: [EncodeCase]
        let encodeErrors: [EncodeCase]
        let decode: [DecodeCase]
    }

    /// The bundled copy, plus the live repo copy when present (catches drift).
    private func vectorSources() throws -> [(String, Vectors)] {
        var sources: [(String, Vectors)] = []
        if let url = Bundle.module.url(forResource: "data-envelope-vectors", withExtension: "json", subdirectory: "Fixtures") {
            sources.append(("bundled", try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))))
        }
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("docs/architecture/data-envelope-vectors.json")
        if let data = try? Data(contentsOf: repo) {
            sources.append(("repo", try JSONDecoder().decode(Vectors.self, from: data)))
        }
        #expect(!sources.isEmpty, "no data envelope vectors available")
        return sources
    }

    @Test func testEncodeVectors() throws {
        for (source, vectors) in try vectorSources() {
            #expect(vectors.encode.count >= 10)
            for vector in vectors.encode {
                let encoded = try DataEnvelope.encode(payload: Data(hex: vector.input.payloadHex),
                                                      topic: vector.input.topic,
                                                      destinationIdentities: vector.input.destinationIdentities)
                #expect(encoded.hex == vector.expectedHex, "\(source): \(vector.name)")
            }
        }
    }

    @Test func testEncodeErrorVectors() throws {
        for (source, vectors) in try vectorSources() {
            #expect(!vectors.encodeErrors.isEmpty)
            for vector in vectors.encodeErrors {
                do {
                    _ = try DataEnvelope.encode(payload: Data(hex: vector.input.payloadHex), topic: vector.input.topic,
                                                destinationIdentities: vector.input.destinationIdentities)
                    Issue.record("\(source): \(vector.name) should throw")
                } catch let error as RTCError {
                    #expect(error.code == .invalidArgument, "\(source): \(vector.name)")
                }
            }
        }
    }

    @Test func testDecodeVectors() throws {
        for (source, vectors) in try vectorSources() {
            #expect(vectors.decode.count >= 10)
            for vector in vectors.decode {
                let decoded = DataEnvelope.decode(Data(hex: vector.inputHex))
                let label = "\(source): \(vector.name)"
                #expect(decoded.isLegacy == vector.expected.legacy, "\(label)")
                #expect(decoded.senderIdentity == vector.expected.senderIdentity, "\(label)")
                #expect(decoded.topic == vector.expected.topic, "\(label)")
                #expect(decoded.payload.hex == vector.expected.payloadHex, "\(label)")
            }
        }
    }
}

@Suite struct Phase7ProtocolTests {
    @Test func testDecodesPhase7ServerMessages() throws {
        let joined = try SignalingCoder.decode(#"""
        {"type":"room.joined","roomId":"r","capabilities":["data.v2"],
         "participants":[{"id":"bob","metadata":"{\"role\":\"host\"}","attributes":{"hand":"up"}}]}
        """#)
        guard case let .roomJoined(message) = joined else { Issue.record("not room.joined"); return }
        #expect(message.capabilities == ["data.v2"])
        #expect(message.participants.first?.metadata == #"{"role":"host"}"#)
        #expect(message.participants.first?.attributes == ["hand": "up"])

        let updated = try SignalingCoder.decode(#"{"type":"participant.updated","participantId":"bob","metadata":null,"attributes":{"a":"1"}}"#)
        #expect(updated == .participantUpdated(ParticipantUpdate(participantId: "bob", metadata: nil, attributes: ["a": "1"])))
        let attributesOnly = try SignalingCoder.decode(#"{"type":"participant.updated","participantId":"bob","attributes":{}}"#)
        #expect(attributesOnly == .participantUpdated(ParticipantUpdate(participantId: "bob", metadata: nil, attributes: [:],
                                                                         includesMetadata: false)))

        #expect(try SignalingCoder.decode(#"{"type":"data.throttled","channel":"lossy"}"#) == .dataThrottled(channel: .lossy))
        #expect(try SignalingCoder.decode(#"{"type":"data.throttled","channel":"reliable"}"#) == .dataThrottled(channel: .reliable))
    }

    @Test func testEncodesParticipantUpdateAndScreenShareAudio() throws {
        #expect(try SignalingCoder.encode(.participantUpdate(metadata: "m", attributes: nil))
                == #"{"metadata":"m","type":"participant.update"}"#)
        #expect(try SignalingCoder.encode(.participantUpdate(metadata: nil, attributes: ["k": "v"]))
                == #"{"attributes":{"k":"v"},"type":"participant.update"}"#)
        #expect(try SignalingCoder.encode(.trackPublish(trackId: "t", source: .screenShareAudio))
                == #"{"source":"screenShareAudio","trackId":"t","type":"track.publish"}"#)
        #expect(TrackKind(source: "screenShareAudio") == .screenShareAudio)
        #expect(TrackKind.screenShareAudio.mediaKind == .audio)
        let perms = ParticipantPermissions(subscribe: true, publish: true, publishAudio: true, publishVideo: false, publishData: true)
        #expect(perms.allows(.screenShareAudio))
        #expect(!perms.allows(.screenShare))
    }

    // Agora-parity audit, phase 2: publishScreen is a peer of publishVideo,
    // not a refinement of it — neither implies the other.
    @Test func testPublishScreenIsIndependentOfPublishVideo() throws {
        let screenOnly = ParticipantPermissions(
            subscribe: true, publish: true, publishAudio: false, publishVideo: false, publishScreen: true,
            publishData: false,
        )
        #expect(screenOnly.allows(.screenShare))
        #expect(!screenOnly.allows(.camera))

        let videoOnly = ParticipantPermissions(
            subscribe: true, publish: true, publishAudio: false, publishVideo: true, publishScreen: false,
            publishData: false,
        )
        #expect(videoOnly.allows(.camera))
        #expect(!videoOnly.allows(.screenShare))

        // A payload that never names publishScreen (an older server, or a
        // pre-phase-2 token) decodes it as false, not as "unspecified".
        let decoded = try JSONDecoder().decode(
            ParticipantPermissions.self,
            from: Data(#"{"subscribe":true,"publish":true,"publishAudio":true,"publishVideo":true,"publishData":true}"#.utf8),
        )
        #expect(decoded.publishVideo)
        #expect(!decoded.publishScreen)
    }

    @Test func testTokenClaimsCarryMetadata() throws {
        let token = makeToken(extra: ["md": "hello", "attrs": ["a": "1", "n": 2], "perms": ["updateOwnMetadata": true]])
        let claims = try TokenClaims.decode(token)
        #expect(claims.metadata == "hello")
        #expect(claims.attributes == ["a": "1"])
        #expect(claims.canUpdateOwnMetadata)
        #expect(!(try TokenClaims.decode(makeToken())).canUpdateOwnMetadata)
    }
}

@Suite struct ScreenShareAudioConversionTests {
    private func format(rate: Double, channels: UInt32, bits: UInt32, float: Bool, bigEndian: Bool = false,
                        nonInterleaved: Bool = false) -> AudioStreamBasicDescription {
        var flags: AudioFormatFlags = float ? kAudioFormatFlagIsFloat : kAudioFormatFlagIsSignedInteger
        if bigEndian { flags |= kAudioFormatFlagIsBigEndian }
        if nonInterleaved { flags |= kAudioFormatFlagIsNonInterleaved }
        let bytesPerFrame = nonInterleaved ? bits / 8 : bits / 8 * channels
        return AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: flags,
                                           mBytesPerPacket: bytesPerFrame, mFramesPerPacket: 1, mBytesPerFrame: bytesPerFrame,
                                           mChannelsPerFrame: channels, mBitsPerChannel: bits, mReserved: 0)
    }

    @Test func testBigEndianStereoInt16IsMixedToMono() {
        // ReplayKit's app audio is commonly big-endian 16-bit.
        var data = Data()
        for value: Int16 in [16384, 0, -16384, -16384] { withUnsafeBytes(of: value.bigEndian) { data.append(contentsOf: $0) } }
        let mono = PCMConverter.monoSamples(buffers: [data], format: format(rate: 48_000, channels: 2, bits: 16, float: false, bigEndian: true),
                                            frameCount: 2)
        #expect(mono == [0.25, -0.5])
    }

    @Test func testNonInterleavedFloat() {
        func floats(_ values: [Float]) -> Data { values.withUnsafeBytes { Data($0) } }
        let mono = PCMConverter.monoSamples(buffers: [floats([1, 0]), floats([0, 0.5])],
                                            format: format(rate: 44_100, channels: 2, bits: 32, float: true, nonInterleaved: true),
                                            frameCount: 2)
        #expect(mono == [0.5, 0.25])
    }

    @Test func testUnsupportedFormatIsIgnored() {
        #expect(PCMConverter.monoSamples(buffers: [Data(count: 6)], format: format(rate: 48_000, channels: 1, bits: 24, float: false),
                                         frameCount: 2) == nil)
    }

    @Test func testResamplesToFortyEightKilohertzAcrossChunks() {
        var converter = PCMConverter(outputSampleRate: 48_000)
        let fmt = format(rate: 44_100, channels: 1, bits: 16, float: false)
        var total = 0
        for _ in 0..<100 {
            let chunk = Data(count: 441 * 2) // 10 ms of silence at 44.1 kHz
            total += converter.convert(buffers: [chunk], format: fmt, frameCount: 441).count
        }
        // One second in, one second (± a sample) out.
        #expect(abs(total - 48_000) <= 1)

        var same = PCMConverter(outputSampleRate: 48_000)
        var ramp = Data()
        for value: Int16 in [0, 1000, 2000, 3000] { withUnsafeBytes(of: value.littleEndian) { ramp.append(contentsOf: $0) } }
        let out = same.convert(buffers: [ramp], format: format(rate: 48_000, channels: 1, bits: 16, float: false), frameCount: 4)
        #expect(out.count == 3)
        #expect(out.first == 0)
    }
}

/// Room-level behaviour with a fake socket and engine.
@MainActor
@Suite(.serialized) final class Phase7RoomTests {
    private var engine: FakeEngine!
    private var room: Room!
    private var recorder: Recorder<RoomEvent>!
    private var socket: FakeConnection!

    private func connect(token: String = makeToken(), capabilities: Bool = true, roster: String? = nil) async throws {
        var options = RoomOptions()
        options.timings = fastTimings()
        let factory = FakeSocketFactory()
        engine = FakeEngine()
        room = Room(options: options, socketFactory: factory, engine: engine, environment: testEnvironment(), logger: RTCLogger())
        recorder = Recorder(room.events())
        let connectTask = Task { @MainActor in try await self.room.connect(token: token, endpoint: URL(string: "wss://x/v1/rtc")!) }
        socket = await factory.connection(0)
        let socket = self.socket!
        await waitUntil { socket.sent.count == 1 }
        let caps = capabilities ? #","capabilities":["data.v2"]"# : ""
        socket.serverSend(roster ?? """
        {"type":"room.joined","roomId":"room_123"\(caps),"participants":[{"id":"bob","tracks":[],"metadata":"m0","attributes":{"k":"v"}}]}
        """)
        try await connectTask.value
    }

    private func names() -> [String] { recorder.events.map(\.name) }

    // MARK: Sending

    @Test func testLegacyServerWithoutOptionsSendsRawBytes() async throws {
        try await connect(capabilities: false)
        #expect(!room.supportsDataV2)
        try room.sendData(Data("hi".utf8))
        #expect(engine.sentData.count == 1)
        #expect(engine.sentData[0].data == Data("hi".utf8))
        #expect(engine.sentData[0].lossy == false)
    }

    @Test func testLegacyServerWithOptionsStillEnvelopesAndFallsBackToReliable() async throws {
        try await connect(capabilities: false)
        try room.sendData("hi", options: DataPublishOptions(topic: "chat", reliable: false))
        #expect(engine.sentData[0].lossy == false)
        #expect(engine.sentData[0].data.hex == "52020004636861740068" + "69")
    }

    @Test func testDataV2ServerAlwaysEnvelopesAndUsesLossyChannel() async throws {
        try await connect()
        #expect(room.supportsDataV2)
        try room.sendData(Data("hello".utf8))
        #expect(engine.sentData[0].data.hex == "520200000068656c6c6f")
        try room.sendData(Data([1]), options: DataPublishOptions(destinationIdentities: ["bob"], reliable: false))
        #expect(engine.sentData[1].lossy)
        #expect(engine.sentData[1].data.hex == "5202000001" + "03626f62" + "01")
    }

    @Test func testPayloadLimitsAndValidation() async throws {
        try await connect()
        #expect(throws: RTCError.self) { try self.room.sendData(Data(count: 1_201), options: DataPublishOptions(reliable: false)) }
        try room.sendData(Data(count: 1_200), options: DataPublishOptions(reliable: false))
        #expect(throws: RTCError.self) { try self.room.sendData(Data(count: 65_537)) }
        try room.sendData(Data(count: 65_536))
        do {
            try room.sendData(Data([1]), options: DataPublishOptions(topic: String(repeating: "a", count: 256)))
            Issue.record("should throw")
        } catch let error as RTCError {
            #expect(error.code == .invalidArgument)
        }
    }

    @Test func testDataV2JoinOpensBothChannelsEagerly() async throws {
        try await connect()
        #expect(engine.openDataChannelsCount == 1)
    }

    @Test func testDataV2JoinWithoutPublishDataOpensNoChannel() async throws {
        // A live-stream viewer: opening a channel is an offer the API refuses,
        // failing the whole connection.
        let viewer = ["subscribe": true, "publish": false, "publishData": false]
        try await connect(token: makeToken(extra: ["perms": viewer]))
        #expect(engine.openDataChannelsCount == 0)
        do {
            try room.sendData(Data([1]))
            Issue.record("should throw")
        } catch let error as RTCError {
            #expect(error.code == .permissionDenied)
        }
        #expect(engine.sentData.isEmpty)
    }

    @Test func testLegacyJoinLeavesChannelsLazy() async throws {
        try await connect(capabilities: false)
        #expect(engine.openDataChannelsCount == 0)
    }

    @Test func testBothChannelsCarryTheV2Protocol() async throws {
        let reliable = PeerConnectionEngine.dataChannelConfiguration(lossy: false)
        #expect(reliable.protocol == "raven.v2")
        #expect(reliable.isOrdered)
        let lossy = PeerConnectionEngine.dataChannelConfiguration(lossy: true)
        #expect(lossy.protocol == "raven.v2")
        #expect(!lossy.isOrdered)
        #expect(lossy.maxRetransmits == 0)

        // The real engine on a real PeerConnection.
        let engine = PeerConnectionEngine(logger: RTCLogger())
        engine.resetPeerConnection(iceServers: [])
        engine.openDataChannels()
        #expect(engine.dataChannelProtocols.reliable == "raven.v2")
        #expect(engine.dataChannelProtocols.lossy == "raven.v2")
        engine.close()
    }

    // MARK: Receiving

    @Test func testReceivedMessagesAreAttributed() async throws {
        try await connect()
        engine.deliverData(Data([0x52, 0x03, 3]) + Data("bob".utf8) + Data([4]) + Data("chat".utf8) + Data("hi".utf8))
        engine.deliverData(Data([0x52, 0x03, 0, 0]) + Data("srv".utf8))
        engine.deliverData(Data("legacy".utf8))
        await waitUntil { @MainActor in self.names().filter { $0 == "dataMessageReceived" }.count == 3 }
        let messages = recorder.events.compactMap { event -> DataMessage? in
            if case let .dataMessageReceived(message) = event { return message }
            return nil
        }
        try #require(messages.count == 3)
        #expect(messages[0].participant === room.remoteParticipants["bob"])
        #expect(messages[0].topic == "chat")
        #expect(messages[0].payload == Data("hi".utf8))
        #expect(messages[1].participant == nil)
        #expect(messages[1].senderIdentity == "")
        #expect(messages[1].topic == nil)
        #expect(messages[2].senderIdentity == nil)
        #expect(messages[2].payload == Data("legacy".utf8))
        // The original event still fires, now attributed.
        let first = recorder.events.first { if case .dataReceived = $0 { return true }; return false }
        if case let .dataReceived(payload, participant) = first {
            #expect(payload == Data("hi".utf8))
            #expect(participant?.identity == "bob")
        } else { Issue.record("no dataReceived") }
    }

    @Test func testDataThrottled() async throws {
        try await connect()
        socket.serverSend(#"{"type":"data.throttled","channel":"lossy"}"#)
        await waitUntil { @MainActor in self.names().contains("dataThrottled") }
        let event = recorder.events.first { $0.name == "dataThrottled" }
        if case let .dataThrottled(channel) = event { #expect(channel == .lossy) } else { Issue.record("missing") }
    }

    // MARK: Metadata

    @Test func testRosterAndUpdatesCarryMetadata() async throws {
        try await connect(token: makeToken(extra: ["md": "mine", "attrs": ["seat": "1"]]))
        #expect(room.localParticipant.metadata == "mine")
        #expect(room.localParticipant.attributes == ["seat": "1"])
        let bob = try #require(room.remoteParticipants["bob"])
        #expect(bob.metadata == "m0")
        #expect(bob.attributes == ["k": "v"])
        #expect(!names().contains("participantMetadataChanged"))

        socket.serverSend(#"{"type":"participant.updated","participantId":"bob","metadata":"m1","attributes":{"k":"v"}}"#)
        await waitUntil { @MainActor in self.names().contains("participantMetadataChanged") }
        #expect(bob.metadata == "m1")
        let event = recorder.events.first { $0.name == "participantMetadataChanged" }
        if case let .participantMetadataChanged(participant, previousMetadata, previousAttributes) = event {
            #expect(participant === bob)
            #expect(previousMetadata == "m0")
            #expect(previousAttributes == ["k": "v"])
        } else { Issue.record("missing") }

        // No change → no event. Attributes only → metadata kept.
        socket.serverSend(#"{"type":"participant.updated","participantId":"bob","metadata":"m1","attributes":{"k":"v"}}"#)
        socket.serverSend(#"{"type":"participant.updated","participantId":"alice","attributes":{"seat":"2"}}"#)
        await waitUntil { @MainActor in self.names().filter { $0 == "participantMetadataChanged" }.count == 2 }
        #expect(room.localParticipant.metadata == "mine")
        #expect(room.localParticipant.attributes == ["seat": "2"])
        #expect(names().filter { $0 == "participantMetadataChanged" }.count == 2)

        socket.serverSend(#"{"type":"participant.joined","participant":{"id":"carol","tracks":[],"metadata":"c"}}"#)
        await waitUntil { @MainActor in self.room.remoteParticipants["carol"] != nil }
        #expect(room.remoteParticipants["carol"]?.metadata == "c")
    }

    @Test func testSetMetadataNeedsThePermission() async throws {
        try await connect()
        do {
            try await room.localParticipant.setMetadata("x")
            Issue.record("should throw")
        } catch let error as RTCError {
            #expect(error.code == .permissionDenied)
        }
        #expect(!socket.sentMessages.contains { $0.type == "participant.update" })
    }

    @Test func testSetMetadataAndAttributesSendParticipantUpdate() async throws {
        try await connect(token: makeToken(extra: ["perms": ["updateOwnMetadata": true]]))
        try await room.localParticipant.setMetadata("x")
        try await room.localParticipant.setAttributes(["hand": "up"])
        await waitUntil { @MainActor in self.socket.sentMessages.filter { $0.type == "participant.update" }.count == 2 }
        #expect(socket.sentMessages.contains(.participantUpdate(metadata: "x", attributes: nil)))
        #expect(socket.sentMessages.contains(.participantUpdate(metadata: nil, attributes: ["hand": "up"])))
        // Not optimistic: unchanged until the server confirms.
        #expect(room.localParticipant.metadata == nil)

        do {
            try await room.localParticipant.setMetadata(String(repeating: "a", count: 4_097))
            Issue.record("should throw")
        } catch let error as RTCError { #expect(error.code == .invalidArgument) }
        let tooMany = Dictionary(uniqueKeysWithValues: (0..<33).map { ("k\($0)", "v") })
        await #expect(throws: RTCError.self) { try await self.room.localParticipant.setAttributes(tooMany) }
        await #expect(throws: RTCError.self) {
            try await self.room.localParticipant.setAttributes([String(repeating: "k", count: 65): "v"])
        }
        await #expect(throws: RTCError.self) {
            try await self.room.localParticipant.setAttributes(["k": String(repeating: "v", count: 1_025)])
        }

        // The server can withdraw it.
        socket.serverSend(#"{"type":"participant.permissions_updated","permissions":{"subscribe":true,"publish":true,"publishAudio":true,"publishVideo":true,"publishData":true,"updateOwnMetadata":false}}"#)
        await waitUntil { @MainActor in self.names().contains("permissionsChanged") }
        do {
            try await room.localParticipant.setMetadata("y")
            Issue.record("should throw")
        } catch let error as RTCError { #expect(error.code == .permissionDenied) }
    }

    // MARK: Screen-share audio

    @Test func testUnpublishingScreenShareUnpublishesItsAudio() async throws {
        try await connect()
        let screen = LocalTrack(trackId: "screen-1", source: .screenShare, mediaStreamTrack: nil)
        let audio = LocalTrack(trackId: "screen-audio-1", source: .screenShareAudio, mediaStreamTrack: nil)
        try await room.publish(screen)
        try await room.publish(audio)
        #expect(socket.sentMessages.isEmpty == false)
        await waitUntil { @MainActor in self.socket.sentMessages.contains(.trackPublish(trackId: "screen-audio-1", source: .screenShareAudio)) }
        await room.unpublish(screen)
        #expect(engine.unpublished == ["screen-1", "screen-audio-1"])
        #expect(room.localParticipant.tracks.isEmpty)
    }

    @Test func testRemoteScreenShareAudioIsAnAudioTrack() async throws {
        try await connect()
        socket.serverSend(#"{"type":"track.published","participantId":"bob","track":{"trackId":"bob-sa","kind":"audio","source":"screenShareAudio"}}"#)
        engine.deliverRemoteTrack("bob-sa")
        await waitUntil { @MainActor in self.room.remoteParticipants["bob"]?.tracks.isEmpty == false }
        #expect(room.remoteParticipants["bob"]?.tracks.first?.kind == .screenShareAudio)
        #expect(room.remoteParticipants["bob"]?.tracks.first?.mediaKind == .audio)
    }
}
