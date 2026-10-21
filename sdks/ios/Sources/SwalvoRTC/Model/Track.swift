import Foundation
import LiveKitWebRTC

/// What a track is of. Same vocabulary as the web SDK's `TrackKind`.
public enum TrackKind: String, Sendable, CaseIterable {
    case camera, microphone, screenShare, unknown
    /// Phase 7 §3: a screen share's audio. Plays like any audio track.
    case screenShareAudio

    init(source: String) {
        self = TrackKind(rawValue: source) ?? .unknown
    }

    init(source: TrackSource) {
        switch source {
        case .camera: self = .camera
        case .microphone: self = .microphone
        case .screenShare: self = .screenShare
        case .screenShareAudio: self = .screenShareAudio
        }
    }

    public var mediaKind: MediaKind {
        switch self {
        case .microphone, .screenShareAudio: return .audio
        case .camera, .screenShare: return .video
        case .unknown: return .unknown
        }
    }
}

public enum MediaKind: String, Sendable {
    case audio, video, unknown
}

/// A layer the SFU is forwarding, as `subscription.state` reports it.
public enum ForwardedLayer: String, Sendable {
    case low, medium, high, off
}

/// The simulcast layers `RemoteTrack.setLayer(_:)` accepts.
public enum VideoLayer: String, Sendable {
    case low, medium, high, auto

    var subscriptionLayer: SubscriptionLayer {
        switch self {
        case .low: return .low
        case .medium: return .medium
        case .high: return .high
        case .auto: return .auto
        }
    }
}

/// Fields local and remote tracks share.
@MainActor
public class Track {
    /// The id the SFU knows this track by (the SDP msid track id).
    public internal(set) var trackId: String
    public let kind: TrackKind
    public internal(set) var isMuted: Bool
    /// The underlying WebRTC track. Render a video with
    /// `videoTrack?.add(renderer)` or `SwalvoVideoView`.
    public internal(set) var mediaStreamTrack: RTCMediaStreamTrack?

    public var mediaKind: MediaKind { kind.mediaKind }
    public var videoTrack: RTCVideoTrack? { mediaStreamTrack as? RTCVideoTrack }
    public var audioTrack: RTCAudioTrack? { mediaStreamTrack as? RTCAudioTrack }

    init(trackId: String, kind: TrackKind, isMuted: Bool, mediaStreamTrack: RTCMediaStreamTrack?) {
        self.trackId = trackId
        self.kind = kind
        self.isMuted = isMuted
        self.mediaStreamTrack = mediaStreamTrack
    }
}

/// A track this device captures and publishes.
@MainActor
public final class LocalTrack: Track {
    public let source: TrackSource
    /// Set by the room while the track is published.
    weak var room: Room?
    /// Stops whatever feeds the track (camera capturer, ReplayKit, ...).
    var stopCapture: (() -> Void)?
    /// Video sources fed by a capturer (camera, screen share).
    var videoSource: RTCVideoSource?

    init(trackId: String, source: TrackSource, mediaStreamTrack: RTCMediaStreamTrack?) {
        self.source = source
        super.init(trackId: trackId, kind: TrackKind(source: source), isMuted: false, mediaStreamTrack: mediaStreamTrack)
    }

    /// Stops sending media without unpublishing (`track.mute`). Subscribers
    /// keep the tile; unmuting is immediate.
    public func mute() async {
        await setMuted(true)
    }

    public func unmute() async {
        await setMuted(false)
    }

    /// Mutes or unmutes; the form CallKit's mute action wants.
    public func setMuted(_ muted: Bool) async {
        guard isMuted != muted else { return }
        isMuted = muted
        mediaStreamTrack?.isEnabled = !muted
        await room?.sendLocalMute(self, muted: muted)
    }

    /// Stops capture. Unpublish first if published (`room.unpublish`).
    public func stop() {
        stopCapture?()
        stopCapture = nil
        mediaStreamTrack?.isEnabled = false
    }
}

/// A track subscribed from a remote participant.
@MainActor
public final class RemoteTrack: Track {
    /// The publisher's identity.
    public let participantId: String
    public let isSimulcast: Bool

    /// What the SFU is actually doing with this subscription (phase 2 §4).
    /// Drive a "paused for bandwidth" badge from this, not from the layer
    /// you requested.
    public internal(set) var subscriptionState: TrackSubscriptionState = .active
    /// The layer being forwarded, when the server said.
    public internal(set) var layer: ForwardedLayer?

    /// Sends `subscription.update` for this track. Set by the room.
    var layerSink: ((SubscriptionLayer) -> Void)?
    var adaptiveStream: Bool
    var autoSubscribe: Bool

    private var appEnabled: Bool?
    private var pinnedLayer: VideoLayer?
    private var visible: Bool?
    private var effectiveVisible: Bool?
    private var viewSize: CGSize?
    private var lastSent: SubscriptionLayer
    private var hideTask: Task<Void, Never>?
    /// The debounce before a hidden view pauses its video (phase 2 §4).
    static var hideDebounceNanoseconds: UInt64 = 500_000_000

    init(trackId: String, kind: TrackKind, participantId: String, isMuted: Bool, isSimulcast: Bool,
         mediaStreamTrack: RTCMediaStreamTrack?, adaptiveStream: Bool, autoSubscribe: Bool) {
        self.participantId = participantId
        self.isSimulcast = isSimulcast
        self.adaptiveStream = adaptiveStream
        self.autoSubscribe = autoSubscribe
        // With autoSubscribe off the SFU starts video paused, so that is
        // what we last "asked" for, and the state is known from the start.
        self.lastSent = autoSubscribe ? .auto : .off
        super.init(trackId: trackId, kind: kind, isMuted: isMuted, mediaStreamTrack: mediaStreamTrack)
        if !autoSubscribe && kind.mediaKind == .video {
            subscriptionState = .pausedClient
            layer = .off
        }
    }

    /// Whether the application wants this video (see `setEnabled`).
    public var isEnabled: Bool { appEnabled ?? autoSubscribe }

    /// Pauses (`false`) or resumes this video. Paused, the SFU stops
    /// forwarding it (layer `off`) but keeps the subscription, so resuming
    /// is instant with no renegotiation. Audio is not affected.
    public func setEnabled(_ enabled: Bool) {
        appEnabled = enabled
        updateLayer()
    }

    /// Pins a simulcast layer, overriding adaptive stream. `.auto` asks for
    /// as high as bandwidth allows.
    public func setLayer(_ layer: VideoLayer) {
        pinnedLayer = layer
        updateLayer()
    }

    /// Clears a pinned layer, handing control back to adaptive stream.
    public func clearPinnedLayer() {
        pinnedLayer = nil
        updateLayer()
    }

    /// Tells adaptive stream whether a view of this track is on screen.
    /// Becoming visible resumes at once; becoming hidden pauses after a
    /// 500 ms debounce, so a fast scroll does not flap the subscription.
    /// `SwalvoVideoView` calls this for you.
    public func setVisible(_ isVisible: Bool) {
        visible = isVisible
        hideTask?.cancel()
        if isVisible {
            effectiveVisible = true
            updateLayer()
        } else {
            hideTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: Self.hideDebounceNanoseconds)
                guard let self, !Task.isCancelled, self.visible == false else { return }
                self.effectiveVisible = false
                self.updateLayer()
            }
        }
    }

    /// Tells adaptive stream how large the track is rendered, in pixels,
    /// so it can ask for the smallest layer that covers it.
    public func setVideoSize(_ size: CGSize) {
        viewSize = size
        updateLayer()
    }

    /// The layer to request, by the client-layer precedence of phase 2 §4.
    var desiredLayer: SubscriptionLayer {
        RemoteTrack.desiredLayer(enabled: appEnabled, pinned: pinnedLayer, adaptive: adaptiveStream,
                                 visible: effectiveVisible, size: viewSize, autoSubscribe: autoSubscribe)
    }

    nonisolated static func desiredLayer(enabled: Bool?, pinned: VideoLayer?, adaptive: Bool, visible: Bool?, size: CGSize?,
                             autoSubscribe: Bool) -> SubscriptionLayer {
        if enabled == false { return .off }
        if let pinned { return pinned.subscriptionLayer }
        if adaptive, let visible {
            guard visible else { return .off }
            if let size { return layerFor(size: size) }
            return .auto
        }
        // autoSubscribe off: nothing is wanted until something asks.
        if !autoSubscribe && enabled != true { return .off }
        return .auto
    }

    /// The smallest layer that covers a view of `size` pixels.
    nonisolated static func layerFor(size: CGSize) -> SubscriptionLayer {
        let longest = max(size.width, size.height)
        if longest <= 0 { return .auto }
        if longest <= 320 { return .low }
        if longest <= 720 { return .medium }
        return .high
    }

    func updateLayer() {
        guard kind.mediaKind == .video else { return }
        let next = desiredLayer
        guard next != lastSent else { return }
        lastSent = next
        layerSink?(next)
    }

    /// Applies `subscription.state`. Returns whether anything changed.
    func applySubscriptionState(_ state: TrackSubscriptionState, layer: String?) -> Bool {
        let newLayer = layer.flatMap(ForwardedLayer.init(rawValue:))
        guard state != subscriptionState || newLayer != self.layer else { return false }
        subscriptionState = state
        self.layer = newLayer
        return true
    }
}
