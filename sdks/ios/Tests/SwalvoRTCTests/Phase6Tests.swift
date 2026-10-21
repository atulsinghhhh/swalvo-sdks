import Foundation
import Testing
@testable import SwalvoRTC

/// Phase 6 (docs/architecture/phase6-contracts.md §4, §8): caption
/// segments, transcription state, agent state, and the bot identities.
@Suite struct Phase6ProtocolTests {
    @Test func testDecodesSegments() throws {
        let interim = try SignalingCoder.decode(#"""
        {"type":"transcription.segment","transcriptionId":"trx_1","participantId":"alice","segmentId":"seg_1",
         "text":"hello every","final":false,"language":"en","startMs":120340,"endMs":121010}
        """#)
        #expect(interim == .transcriptionSegment(TranscriptionSegment(
            transcriptionId: "trx_1", participantId: "alice", segmentId: "seg_1", text: "hello every",
            isFinal: false, language: "en", startMs: 120_340, endMs: 121_010)))

        // Agent speech with no transcription running: null id, agentId set.
        let agent = try SignalingCoder.decode(#"""
        {"type":"transcription.segment","transcriptionId":null,"agentId":"agt_1","participantId":"agent-agt_1",
         "segmentId":"seg_2","text":"","final":true,"language":"en","startMs":5,"endMs":5}
        """#)
        guard case let .transcriptionSegment(segment) = agent else { Issue.record("not a segment"); return }
        #expect(segment.transcriptionId == nil)
        #expect(segment.agentId == "agt_1")
        #expect(segment.isFinal)
        #expect(segment.text.isEmpty)

        // Round trip.
        let encoded = try JSONEncoder().encode(agent)
        #expect(try JSONDecoder().decode(ServerMessage.self, from: encoded) == agent)
    }

    @Test func testDecodesStates() throws {
        #expect(try SignalingCoder.decode(#"{"type":"transcription.state","transcriptionId":"trx_1","status":"ACTIVE","language":"en"}"#)
                == .transcriptionState(TranscriptionState(transcriptionId: "trx_1", status: .active, language: "en")))
        #expect(try SignalingCoder.decode(#"{"type":"agent.state","agentId":"agt_1","participantId":"agent-agt_1","state":"thinking"}"#)
                == .agentState(AgentStateUpdate(agentId: "agt_1", participantId: "agent-agt_1", state: .thinking)))
    }

    @Test func testMalformedFramesAreIgnored() throws {
        #expect(try SignalingCoder.decode(#"{"type":"agent.state","agentId":"a","participantId":"agent-a","state":"dancing"}"#)
                == .unknown(type: "agent.state"))
        #expect(try SignalingCoder.decode(#"{"type":"transcription.state","transcriptionId":"t","status":"PAUSED","language":"en"}"#)
                == .unknown(type: "transcription.state"))
        #expect(try SignalingCoder.decode(#"{"type":"transcription.segment","participantId":"a"}"#)
                == .unknown(type: "transcription.segment"))
    }
}

@MainActor
@Suite(.serialized) final class Phase6RoomTests {
    private var room: Room!
    private var recorder: Recorder<RoomEvent>!
    private var socket: FakeConnection!

    private func connect() async throws {
        var options = RoomOptions()
        options.timings = fastTimings()
        let factory = FakeSocketFactory()
        room = Room(options: options, socketFactory: factory, engine: FakeEngine(), environment: testEnvironment(), logger: RTCLogger())
        recorder = Recorder(room.events())
        let connectTask = Task { @MainActor in try await self.room.connect(token: makeToken(), endpoint: URL(string: "wss://x/v1/rtc")!) }
        socket = await factory.connection(0)
        let socket = self.socket!
        await waitUntil { socket.sent.count == 1 }
        socket.serverSend("""
        {"type":"room.joined","roomId":"room_123","participants":[{"id":"bob","tracks":[]},{"id":"agent-agt_1","tracks":[]},{"id":"transcriber-trx_1","tracks":[]}]}
        """)
        try await connectTask.value
    }

    private func names() -> [String] { recorder.events.map(\.name) }

    @Test func testBotIdentities() async throws {
        try await connect()
        #expect(room.remoteParticipants["agent-agt_1"]?.isAgent == true)
        #expect(room.remoteParticipants["agent-agt_1"]?.isTranscriber == false)
        #expect(room.remoteParticipants["transcriber-trx_1"]?.isTranscriber == true)
        #expect(room.remoteParticipants["bob"]?.isAgent == false)
        #expect(room.localParticipant.isAgent == false)
    }

    @Test func testSegmentsAndStateAreEmitted() async throws {
        try await connect()
        socket.serverSend(#"{"type":"transcription.state","transcriptionId":"trx_1","status":"ACTIVE","language":"en"}"#)
        socket.serverSend(#"{"type":"transcription.segment","transcriptionId":"trx_1","participantId":"bob","segmentId":"s1","text":"hi","final":false,"language":"en","startMs":0,"endMs":10}"#)
        socket.serverSend(#"{"type":"transcription.segment","transcriptionId":"trx_1","participantId":"bob","segmentId":"s1","text":"","final":true,"language":"en","startMs":0,"endMs":20}"#)
        await waitUntil { @MainActor in self.names().filter { $0 == "transcriptionSegment" }.count == 2 }
        let state = recorder.events.first { $0.name == "transcriptionStateChanged" }
        if case let .transcriptionStateChanged(s) = state { #expect(s.status == .active) } else { Issue.record("missing state") }
        let segments = recorder.events.compactMap { event -> TranscriptionSegment? in
            if case let .transcriptionSegment(segment) = event { return segment }
            return nil
        }
        #expect(segments.map(\.isFinal) == [false, true])
        // The empty final is delivered unchanged, so a UI can clear the interim.
        #expect(segments[1].text == "")
    }

    @Test func testAgentStateResolvesTheParticipant() async throws {
        try await connect()
        let agent = try #require(room.remoteParticipants["agent-agt_1"])
        let agentEvents = Recorder(agent.events())
        socket.serverSend(#"{"type":"agent.state","agentId":"agt_1","participantId":"agent-agt_1","state":"speaking"}"#)
        await waitUntil { @MainActor in self.names().contains("agentStateChanged") }
        let event = recorder.events.first { $0.name == "agentStateChanged" }
        if case let .agentStateChanged(participant, state) = event {
            #expect(participant === agent)
            #expect(state == .speaking)
        } else { Issue.record("missing") }
        #expect(agent.agentState == .speaking)
        await waitUntil { @MainActor in !agentEvents.events.isEmpty }
        if case let .agentStateChanged(state)? = agentEvents.events.first { #expect(state == .speaking) } else { Issue.record("no participant event") }

        // A repeated identical frame emits nothing; a change emits again.
        socket.serverSend(#"{"type":"agent.state","agentId":"agt_1","participantId":"agent-agt_1","state":"speaking"}"#)
        socket.serverSend(#"{"type":"agent.state","agentId":"agt_1","participantId":"agent-agt_1","state":"listening"}"#)
        await waitUntil { @MainActor in self.names().filter { $0 == "agentStateChanged" }.count >= 2 }
        let states = recorder.events.compactMap { event -> AgentState? in
            if case let .agentStateChanged(_, state) = event { return state }
            return nil
        }
        #expect(states == [.speaking, .listening])
    }

    @Test func testAgentStateBeforeJoinIsBuffered() async throws {
        try await connect()
        socket.serverSend(#"{"type":"agent.state","agentId":"agt_2","participantId":"agent-agt_2","state":"listening"}"#)
        // An `ended` for someone never seen is dropped.
        socket.serverSend(#"{"type":"agent.state","agentId":"agt_3","participantId":"agent-agt_3","state":"ended"}"#)
        socket.serverSend(#"{"type":"participant.joined","participant":{"id":"agent-agt_2","tracks":[]}}"#)
        await waitUntil { @MainActor in self.names().contains("agentStateChanged") }
        let joinedIndex = try #require(names().lastIndex(of: "participantJoined"))
        let stateIndex = try #require(names().firstIndex(of: "agentStateChanged"))
        #expect(stateIndex > joinedIndex)
        #expect(room.remoteParticipants["agent-agt_2"]?.agentState == .listening)
        socket.serverSend(#"{"type":"participant.joined","participant":{"id":"agent-agt_3","tracks":[]}}"#)
        await waitUntil { @MainActor in self.room.remoteParticipants["agent-agt_3"] != nil }
        #expect(room.remoteParticipants["agent-agt_3"]?.agentState == nil)
        #expect(names().filter { $0 == "agentStateChanged" }.count == 1)
    }
}
