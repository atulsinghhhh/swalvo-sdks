import Foundation
import Testing
@testable import SwalvoRTC

/// Pure media logic: the adaptive-layer precedence (phase 2 §4), dynacast
/// RID matching (§5) and SDP readers.
@Suite(.serialized) final class MediaPolicyTests {
    @Test func testLayerPrecedence() {
        // App pause beats everything.
        #expect((RemoteTrack.desiredLayer(enabled: false, pinned: .high, adaptive: true, visible: true, size: nil, autoSubscribe: true)) == (.off))
        // Then a pinned layer.
        #expect((RemoteTrack.desiredLayer(enabled: nil, pinned: .low, adaptive: true, visible: false, size: nil, autoSubscribe: true)) == (.low))
        // Adaptive: hidden → off, visible → size-chosen layer.
        #expect((RemoteTrack.desiredLayer(enabled: nil, pinned: nil, adaptive: true, visible: false, size: nil, autoSubscribe: true)) == (.off))
        #expect((RemoteTrack.desiredLayer(enabled: nil, pinned: nil, adaptive: true, visible: true, size: CGSize(width: 240, height: 135), autoSubscribe: true)) == (.low))
        #expect((RemoteTrack.desiredLayer(enabled: nil, pinned: nil, adaptive: true, visible: true, size: CGSize(width: 640, height: 360), autoSubscribe: true)) == (.medium))
        #expect((RemoteTrack.desiredLayer(enabled: nil, pinned: nil, adaptive: true, visible: true, size: CGSize(width: 1920, height: 1080), autoSubscribe: true)) == (.high))
        // Adaptive with no view yet: no opinion → auto.
        #expect((RemoteTrack.desiredLayer(enabled: nil, pinned: nil, adaptive: true, visible: nil, size: nil, autoSubscribe: true)) == (.auto))
        // autoSubscribe off: nothing until asked.
        #expect((RemoteTrack.desiredLayer(enabled: nil, pinned: nil, adaptive: false, visible: nil, size: nil, autoSubscribe: false)) == (.off))
        #expect((RemoteTrack.desiredLayer(enabled: true, pinned: nil, adaptive: false, visible: nil, size: nil, autoSubscribe: false)) == (.auto))
        #expect((RemoteTrack.desiredLayer(enabled: nil, pinned: nil, adaptive: true, visible: true, size: nil, autoSubscribe: false)) == (.auto))
    }

    @MainActor
    @Test func testHiddenViewPausesAfterDebounceAndVisibleResumesAtOnce() async throws {
        RemoteTrack.hideDebounceNanoseconds = 30_000_000
        defer { RemoteTrack.hideDebounceNanoseconds = 500_000_000 }
        let track = RemoteTrack(trackId: "t", kind: .camera, participantId: "bob", isMuted: false, isSimulcast: true,
                                mediaStreamTrack: nil, adaptiveStream: true, autoSubscribe: true)
        var sent: [SubscriptionLayer] = []
        track.layerSink = { sent.append($0) }
        track.setVisible(true)
        #expect((sent) == ([]), "visible with no size is auto, which is already the default")
        track.setVisible(false)
        track.setVisible(true) // a fast scroll: no flap
        try await Task.sleep(nanoseconds: 60_000_000)
        #expect((sent) == ([]))
        track.setVisible(false)
        try await Task.sleep(nanoseconds: 60_000_000)
        #expect((sent) == ([.off]))
        track.setVisible(true)
        #expect((sent) == ([.off, .auto]), "resumes at once")
    }

    @MainActor
    @Test func testAudioTracksNeverSendLayerUpdates() {
        let track = RemoteTrack(trackId: "a", kind: .microphone, participantId: "bob", isMuted: false, isSimulcast: false,
                                mediaStreamTrack: nil, adaptiveStream: true, autoSubscribe: true)
        var sent: [SubscriptionLayer] = []
        track.layerSink = { sent.append($0) }
        track.setEnabled(false)
        #expect((sent) == ([]))
    }

    @Test func testDynacastRidMatchingAcceptsBothSpellings() {
        let frame = [LayerActivity(rid: "q", active: true), LayerActivity(rid: "h", active: false), LayerActivity(rid: "f", active: false)]
        #expect((Simulcast.activity(for: ["low", "medium", "high"], frame: frame)) == (["low": true, "medium": false, "high": false]))
        let exact = [LayerActivity(rid: "low", active: false), LayerActivity(rid: "high", active: true)]
        #expect((Simulcast.activity(for: ["low", "medium", "high"], frame: exact)) == (["low": false, "high": true]))
        #expect((Simulcast.activity(for: ["x"], frame: frame)) == ([:]))
    }

    @Test func testSimulcastLadderMatchesWebSDK() {
        #expect((Simulcast.layers.map(\.rid)) == (["low", "medium", "high"]))
        #expect((Simulcast.layers.map(\.scaleResolutionDownBy)) == ([4, 2, 1]))
        #expect((Simulcast.layers.map(\.maxBitrateBps)) == ([150_000, 500_000, 1_500_000]))
    }

    private let sdp = [
        "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0", "a=msid:alice-stream alice-mic",
        "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1", "a=msid:bob bob-cam",
        "a=rid:low send", "a=rid:medium send", "a=rid:high send", "a=simulcast:send low;medium;high",
        "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:2", "a=msid:bob bob-screen", "",
    ].joined(separator: "\r\n")

    @Test func testMsidLookupByMid() {
        #expect((SDPUtilities.msidTrackId(forMid: "1", in: sdp)) == ("bob-cam"))
        #expect((SDPUtilities.msidTrackId(forMid: "2", in: sdp)) == ("bob-screen"))
        #expect((SDPUtilities.msidTrackId(forMid: "9", in: sdp)) == nil)
    }

    @Test func testSimulcastDetectionInSDP() {
        #expect(SDPUtilities.negotiatesSimulcast(sdp))
        #expect(!(SDPUtilities.negotiatesSimulcast(sdp.replacingOccurrences(of: "a=rid:medium send\r\n", with: ""))))
    }
}
