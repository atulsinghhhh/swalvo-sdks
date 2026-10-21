import Foundation

/// Configuration for joining a room. Mirrors the web SDK's `RTCClientConfig`.
public struct RoomOptions: Sendable {
    /// The `iceServers` from the same token-mint response as the token.
    /// Without them there is no TURN relay, and calls on mobile data often fail.
    public var iceServers: [ICEServer] = []
    /// Reconnect automatically on network loss. Default true.
    public var autoReconnect = true
    /// Returns a fresh RTC token from your backend for the same room and
    /// identity. Called on `token.expiring` (refreshed in place, no
    /// reconnect), before a reconnect that would present an expired token,
    /// and after the server closes with 4001. A failure is not fatal; the
    /// room emits a `TOKEN_REFRESH_FAILED` warning.
    public var refreshToken: (@Sendable () async throws -> String)?
    /// Keep each subscribed video on the smallest layer covering its view,
    /// and pause videos that are off screen. Default true.
    public var adaptiveStream = true
    /// Default true. When false, video subscriptions start paused
    /// (`paused_client`) until wanted. Audio is always forwarded.
    public var autoSubscribe = true
    /// Publish the camera as a three-layer simulcast ladder. Default true.
    public var simulcast = true
    /// Video codec to offer first: `"H264"`, `"VP8"`, `"VP9"` or `"AV1"`.
    public var preferredVideoCodec: String?
    /// A region preference for `room.join`; the server may fall back.
    public var region: String?
    /// Stop capture when a track is unpublished. Default true.
    public var stopLocalTrackOnUnpublish = true
    public var logLevel: LogLevel = .silent
    /// Keys for an E2EE room (phase 5 §3). See README, "End-to-end encryption".
    public var e2eeKeyProvider: E2EEKeyProvider?
    /// Signaling timings; the defaults match the web SDK.
    public var timings = SignalingTimings()

    public init() {}
}
