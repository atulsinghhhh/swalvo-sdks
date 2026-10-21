package io.swalvo.rtc

import io.swalvo.rtc.e2ee.E2eeOptions

/**
 * Client configuration. Mirrors the web SDK's `RTCClientConfig` minus the
 * fields `connect(...)` takes directly (token, endpoint, iceServers).
 */
public class SwalvoClientOptions(
    /** Reconnect automatically on network loss (default true). */
    public val autoReconnect: Boolean = true,
    /**
     * Returns a fresh RTC token from your backend for the same room,
     * identity, project and environment. Called on `token.expiring` (handed
     * to the live session with `token.refresh`, no reconnect), before a
     * reconnect that would present an expired token, and after the server
     * closes the session with 4001. A throw is not fatal: the room emits a
     * `TOKEN_REFRESH_FAILED` warning and carries on.
     */
    public val refreshToken: (suspend () -> String)? = null,
    /** Keep invisible videos switched off (`setVisible(false)` → layer `off`). Default true. */
    public val adaptiveStream: Boolean = true,
    /** False: every remote video starts paused (`paused_client`) until shown, enabled or pinned. Audio always flows. */
    public val autoSubscribe: Boolean = true,
    /** Video codec to offer first when publishing (`"h264"`, `"vp8"`, `"vp9"`, `"av1"`); null keeps libwebrtc's order. */
    public val preferredVideoCodec: String? = null,
    /** Region preference sent with `room.join`. */
    public val region: String? = null,
    /** End-to-end encryption. Required to publish into a room created with `e2ee: true`. */
    public val e2ee: E2eeOptions? = null,
    public val logLevel: LogLevel = LogLevel.WARN,
    public val logSink: LogSink? = null,
)

/** An ICE server from the token-mint response's `iceServers` array. */
public data class IceServer(
    val urls: List<String>,
    val username: String? = null,
    val credential: String? = null,
)

/** Camera capture options. */
public class CameraOptions(
    /** A Camera2 device name from [SwalvoClient.cameraDevices]; null picks by [facing]. */
    public val deviceName: String? = null,
    public val facing: CameraFacing = CameraFacing.FRONT,
    public val width: Int = 1280,
    public val height: Int = 720,
    public val fps: Int = 30,
)

public enum class CameraFacing { FRONT, BACK }

/** Screen-share capture options. */
public class ScreenShareOptions(
    public val width: Int = 1280,
    public val height: Int = 720,
    public val fps: Int = 15,
    /**
     * Also share what the device is playing (phase7 §3), with Android's
     * AudioPlaybackCapture: API 29+ only, needs `RECORD_AUDIO`, and only
     * captures apps that allow it (media, games and unknown usages; never
     * calls). With the microphone off it is published as its own
     * [TrackKind.SCREEN_SHARE_AUDIO] track; with the microphone on it is
     * mixed into the microphone track instead (libwebrtc has one recording
     * path). Ignored, with a warning, below API 29.
     */
    public val captureAudio: Boolean = false,
)
