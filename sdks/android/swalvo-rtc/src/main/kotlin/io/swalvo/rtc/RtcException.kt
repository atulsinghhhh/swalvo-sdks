package io.swalvo.rtc

/** Error codes. Same vocabulary as the web SDK's `RTCErrorCode`, plus the Android-only media ones. */
public enum class RtcErrorCode {
    INVALID_TOKEN,
    TOKEN_EXPIRED,
    TOKEN_REVOKED,
    USAGE_LIMIT_EXCEEDED,
    ROOM_NOT_FOUND,
    PERMISSION_DENIED,
    CONNECTION_FAILED,
    NETWORK_ERROR,
    SIGNALING_ERROR,
    TIMEOUT,
    MEDIA_ERROR,
    CAMERA_PERMISSION_DENIED,
    MICROPHONE_PERMISSION_DENIED,
    SCREEN_SHARE_PERMISSION_DENIED,
    /** The room requires end-to-end encryption (phase5 §3.1) and none is configured, or it failed. */
    E2EE_ERROR,
    /** An argument broke a documented limit (data payload, topic or destination length, metadata or attribute size). */
    INVALID_ARGUMENT,
}

/** Every error the SDK throws or reports through [RoomEvent.Error]. */
public class RtcException(
    public val code: RtcErrorCode,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause) {
    override fun toString(): String = "RtcException($code): $message"
}
