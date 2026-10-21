import Foundation
import Testing
@testable import SwalvoRTC

/// Every client and server message in docs/rtc/signaling.md decodes into
/// the typed model and re-encodes to the same JSON.
@Suite(.serialized) final class ProtocolCodingTests {
    private func fixture(_ name: String) throws -> [[String: Any]] {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        let data = try Data(contentsOf: url)
        return try #require(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    }

    private func jsonObject(_ data: Data) throws -> NSDictionary {
        try #require(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    @Test func testClientMessagesRoundTrip() throws {
        let messages = try fixture("client-messages")
        #expect((messages.count) == (14))
        for original in messages {
            let data = try JSONSerialization.data(withJSONObject: original)
            let decoded = try JSONDecoder().decode(ClientMessage.self, from: data)
            #expect((decoded.type) == (original["type"] as? String))
            let encoded = try SignalingCoder.encode(decoded)
            #expect((try jsonObject(Data(encoded.utf8))) == (original as NSDictionary), "round trip of \(decoded.type)")
        }
    }

    @Test func testServerMessagesRoundTrip() throws {
        let messages = try fixture("server-messages")
        for original in messages {
            let data = try JSONSerialization.data(withJSONObject: original)
            let decoded = try JSONDecoder().decode(ServerMessage.self, from: data)
            #expect((decoded.type) == (original["type"] as? String))
            if case .unknown = decoded { Issue.record("\(decoded.type) decoded as unknown") }
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            let reencoded = try encoder.encode(decoded)
            #expect((try jsonObject(reencoded)) == (original as NSDictionary), "round trip of \(decoded.type)")
        }
    }

    @Test func testRoomJoinedFieldsDecode() throws {
        let message = try SignalingCoder.decode(#"""
        {"type":"room.joined","roomId":"room_123","rtcServer":"sfu-asia-02","region":"asia-south","resumeToken":"rt","resumed":false,
         "participants":[{"id":"bob","tracks":[{"trackId":"bob-cam","kind":"video","source":"camera","muted":false,"simulcast":true,"layers":["low","medium","high"]}]}]}
        """#)
        guard case let .roomJoined(joined) = message else { Issue.record("not room.joined"); return }
        #expect((joined.resumeToken) == ("rt"))
        #expect((joined.resumed) == (false))
        #expect((joined.participants.first?.tracks.first?.layers) == (["low", "medium", "high"]))
        #expect((joined.e2ee) == nil)
    }

    @Test func testUnknownTypeAndFieldsAreIgnored() throws {
        #expect((try SignalingCoder.decode(#"{"type":"something.new","x":1}"#)) == (.unknown(type: "something.new")))
        let message = try SignalingCoder.decode(#"{"type":"track.muted","participantId":"bob","trackId":"t","futureField":true}"#)
        #expect((message) == (.trackMuted(participantId: "bob", trackId: "t", byServer: false)))
    }

    @Test func testUnknownErrorCodeStillDecodes() throws {
        let message = try SignalingCoder.decode(#"{"type":"error","code":"BRAND_NEW_CODE","message":"m"}"#)
        #expect((message) == (.error(code: "BRAND_NEW_CODE", message: "m")))
    }

    @Test func testQualityEntriesWithUnknownValuesAreDropped() throws {
        let message = try SignalingCoder.decode(#"{"type":"quality.changed","updates":[{"participantId":"a","quality":"good"},{"participantId":"b","quality":"stellar"}]}"#)
        #expect((message) == (.qualityChanged([QualityUpdate(participantId: "a", quality: .good)])))
    }

    @Test func testSpeakerLevelsAreClampedAndCapped() throws {
        let speakers = (0..<10).map { #"{"participantId":"p\#($0)","level":1.7}"# }.joined(separator: ",")
        let message = try SignalingCoder.decode(#"{"type":"speakers.changed","speakers":[\#(speakers)]}"#)
        guard case let .speakersChanged(list) = message else { Issue.record("failed"); return }
        #expect((list.count) == (8))
        #expect((list.first?.level) == (1))
    }

    @Test func testPublisherLayerEntriesWithoutRidAreDropped() throws {
        let message = try SignalingCoder.decode(#"{"type":"publisher.layers","trackId":"t","layers":[{"rid":"q","active":true},{"active":false},{"rid":"h","active":"yes"}]}"#)
        #expect((message) == (.publisherLayers(trackId: "t", layers: [LayerActivity(rid: "q", active: true)])))
    }

    @Test func testAutoSubscribeIsOnlySentWhenFalse() throws {
        #expect(!(try SignalingCoder.encode(.roomJoin(RoomJoinMessage(roomId: "r"))).contains("autoSubscribe")))
        #expect(try SignalingCoder.encode(.roomJoin(RoomJoinMessage(roomId: "r", autoSubscribe: false))).contains(#""autoSubscribe":false"#))
    }

    @Test func testICEServerAcceptsStringOrArrayURLs() throws {
        let servers = try JSONDecoder().decode([ICEServer].self, from: Data(#"""
        [{"urls":"stun:stun.example.com:3478"},{"urls":["turn:t.example.com:3478?transport=udp","turns:t.example.com:5349?transport=tcp"],"username":"u","credential":"c"}]
        """#.utf8))
        #expect((servers[0].urls) == (["stun:stun.example.com:3478"]))
        #expect((servers[1].urls.count) == (2))
        #expect((servers[1].credential) == ("c"))
    }

    @Test func testTokenClaimsDecode() throws {
        let claims = try TokenClaims.decode(makeToken(sub: "alice", rid: "room_123", rnm: "standup", exp: 2_000_000_000, e2ee: true))
        #expect((claims.identity) == ("alice"))
        #expect((claims.roomId) == ("room_123"))
        #expect((claims.roomName) == ("standup"))
        #expect((claims.expiresAt) == (Date(timeIntervalSince1970: 2_000_000_000)))
        #expect(claims.e2ee)
        #expect(throws: (any Error).self) { try TokenClaims.decode("not-a-jwt") }
    }

    @Test func testServerErrorMapping() {
        #expect((RTCError.fromServer(.originNotAllowed, "x").code) == (.permissionDenied))
        #expect((RTCError.fromServer(.usageLimitExceeded, "x").code) == (.usageLimitExceeded))
        #expect((RTCError.fromServer(.noRTCCapacity, "x").code) == (.connectionFailed))
        #expect(SignalingErrorCode.tokenRevoked.isFatal)
        #expect(!(SignalingErrorCode.negotiationGlare.isFatal))
    }
}
