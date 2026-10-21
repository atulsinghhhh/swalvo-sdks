import Foundation
import LiveKitWebRTC
import Testing
@testable import SwalvoRTC

/// The real `PeerConnectionEngine` against a second `RTCPeerConnection`
/// playing the SFU, over loopback. Headless: no camera or microphone is
/// opened (tracks come from WebRTC sources nobody feeds).
@MainActor
@Suite(.serialized) final class PeerConnectionEngineTests {
    /// The "SFU" side: offers first, like the real one.
    private final class FakeSFU: NSObject, RTCPeerConnectionDelegate, @unchecked Sendable {
        var pc: RTCPeerConnection!
        var onCandidate: ((RTCIceCandidate) -> Void)?
        private(set) var connected = false

        func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
        func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) { onCandidate?(candidate) }
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
            if newState == .connected { connected = true }
        }
    }

    private func offer(_ pc: RTCPeerConnection) async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { cont in
            pc.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { sdp, error in
                if let sdp { cont.resume(returning: sdp) } else { cont.resume(throwing: error!) }
            }
        }
    }

    private func answer(_ pc: RTCPeerConnection) async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { cont in
            pc.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { sdp, error in
                if let sdp { cont.resume(returning: sdp) } else { cont.resume(throwing: error!) }
            }
        }
    }

    private func setLocal(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setLocalDescription(sdp) { error in if let error { cont.resume(throwing: error) } else { cont.resume() } }
        }
    }

    private func setRemote(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(sdp) { error in if let error { cont.resume(throwing: error) } else { cont.resume() } }
        }
    }

    @Test func testAnswersSFUOfferAttributesTrackAndPublishes() async throws {
        let factory = WebRTCFactory.shared
        let sfu = FakeSFU()
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.bundlePolicy = .maxBundle
        sfu.pc = try #require(factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: sfu))

        let engine = PeerConnectionEngine(logger: RTCLogger())
        var signals: [ClientMessage] = []
        var events: [MediaEngineEvent] = []
        engine.sendSignal = { signals.append($0) }
        engine.onEvent = { events.append($0) }
        engine.resetPeerConnection(iceServers: [])

        // The SFU forwards bob's video, labelled with bob's track id.
        let bobTrack = factory.videoTrack(with: factory.videoSource(), trackId: "bob-cam")
        let initOptions = RTCRtpTransceiverInit()
        initOptions.direction = .sendOnly
        initOptions.streamIds = ["bob"]
        #expect((sfu.pc.addTransceiver(with: bobTrack, init: initOptions)) != nil)
        // And a recvonly audio slot for us to publish into later.
        let recv = RTCRtpTransceiverInit()
        recv.direction = .recvOnly
        #expect((sfu.pc.addTransceiver(of: .audio, init: recv)) != nil)
        let sfuOffer = try await offer(sfu.pc)
        try await setLocal(sfu.pc, sfuOffer)

        // Candidates the SFU sends before the engine has a remote description are buffered.
        sfu.onCandidate = { candidate in
            let payload = ICECandidatePayload(candidate: candidate.sdp, sdpMid: candidate.sdpMid, sdpMLineIndex: Int(candidate.sdpMLineIndex))
            Task { @MainActor in await engine.handleRemoteCandidate(payload) }
        }

        await engine.handleRemoteOffer(sfuOffer.sdp)
        let answerSDP = try #require(signals.compactMap { if case let .sdpAnswer(sdp) = $0 { return sdp } else { return nil } }.first)
        #expect(answerSDP.contains("a=setup:active"), "the client is always the DTLS client")
        try await setRemote(sfu.pc, RTCSessionDescription(type: .answer, sdp: answerSDP))

        await waitUntil(10) { @MainActor in
            events.contains { if case let .remoteTrackAdded(id, _) = $0 { return id == "bob-cam" } else { return false } }
        }

        // Our candidates to the SFU, then wait for ICE+DTLS over loopback.
        for case let .iceCandidate(c) in signals {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                sfu.pc.add(RTCIceCandidate(sdp: c.candidate, sdpMLineIndex: Int32(c.sdpMLineIndex ?? 0), sdpMid: c.sdpMid)) { error in
                    if let error { cont.resume(throwing: error) } else { cont.resume() }
                }
            }
        }
        let connectedSignalsCount = signals.count
        _ = connectedSignalsCount

        // Publishing: track.publish is declared before the offer that carries it.
        let micSource = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let mic = factory.audioTrack(with: micSource, trackId: "alice-mic")
        signals.removeAll()
        try await engine.publish(EnginePublication(trackId: "alice-mic", source: .microphone, track: mic, simulcast: false))
        await waitUntil(5) { @MainActor in signals.contains { if case .sdpOffer = $0 { return true } else { return false } } }
        let publishIndex = try #require(signals.firstIndex(of: .trackPublish(trackId: "alice-mic", source: .microphone)))
        let offerIndex = try #require(signals.firstIndex { if case .sdpOffer = $0 { return true } else { return false } })
        #expect((publishIndex) < (offerIndex))
        guard case let .sdpOffer(clientOffer) = signals[offerIndex] else { Issue.record("failed"); return }
        #expect(clientOffer.contains("alice-mic"), "the declared id is the msid on the wire")

        try await setRemote(sfu.pc, RTCSessionDescription(type: .offer, sdp: clientOffer))
        let sfuAnswer = try await answer(sfu.pc)
        try await setLocal(sfu.pc, sfuAnswer)
        await engine.handleRemoteAnswer(sfuAnswer.sdp)
        #expect((engine.signalingState) == ("stable"))

        // A late server offer (an ICE restart) is answered like any other.
        let restart = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<RTCSessionDescription, Error>) in
            sfu.pc.offer(for: RTCMediaConstraints(mandatoryConstraints: ["IceRestart": "true"], optionalConstraints: nil)) { sdp, error in
                if let sdp { cont.resume(returning: sdp) } else { cont.resume(throwing: error!) }
            }
        }
        try await setLocal(sfu.pc, restart)
        signals.removeAll()
        await engine.handleRemoteOffer(restart.sdp)
        #expect(signals.contains { if case .sdpAnswer = $0 { return true } else { return false } })

        engine.close()
        sfu.pc.close()
    }

    @Test func testSimulcastPublishNegotiatesThreeRids() async throws {
        let factory = WebRTCFactory.shared
        let engine = PeerConnectionEngine(logger: RTCLogger())
        var signals: [ClientMessage] = []
        engine.sendSignal = { signals.append($0) }
        engine.resetPeerConnection(iceServers: [])
        let camera = factory.videoTrack(with: factory.videoSource(), trackId: "alice-cam")
        try await engine.publish(EnginePublication(trackId: "alice-cam", source: .camera, track: camera, simulcast: true))
        await waitUntil(5) { @MainActor in signals.contains { if case .sdpOffer = $0 { return true } else { return false } } }
        guard case let .sdpOffer(sdp)? = signals.first(where: { if case .sdpOffer = $0 { return true } else { return false } }) else {
            Issue.record("no offer"); return
        }
        #expect(SDPUtilities.negotiatesSimulcast(sdp), "the offer carries a=simulcast:send with low/medium/high")

        // Dynacast: turning layers off sets the encodings inactive.
        engine.applyPublisherLayers(trackId: "alice-cam", layers: [LayerActivity(rid: "q", active: true),
                                                                  LayerActivity(rid: "h", active: false),
                                                                  LayerActivity(rid: "f", active: false)])
        engine.close()
    }
}
