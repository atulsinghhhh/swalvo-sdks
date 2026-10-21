package io.swalvo.rtc

/**
 * The room's connection lifecycle. Same values as the web SDK's
 * `ConnectionState`.
 */
public enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING, FAILED }

/**
 * The SFU's own score for a participant's connection (phase2 §3).
 * [UNKNOWN] until the server has scored them: there is no snapshot on join.
 */
public enum class ConnectionQuality(public val wire: String) {
    EXCELLENT("excellent"), GOOD("good"), POOR("poor"), LOST("lost"), UNKNOWN("unknown");

    public companion object {
        internal fun fromWire(value: String): ConnectionQuality? = entries.firstOrNull { it.wire == value && it != UNKNOWN }
    }
}

/**
 * Why a room ended up disconnected (or failed). Passed with
 * [RoomEvent.Disconnected].
 *
 * - [CLIENT_INITIATED]: `room.leave()` was called.
 * - [REMOVED]: removed by the server moderation API. Never rejoin automatically.
 * - [ROOM_CLOSED]: the room was closed. Never rejoin automatically.
 * - [TOKEN_EXPIRED]: the token expired (or was revoked) and could not be refreshed.
 * - [REPLACED]: another connection for the same identity took over (close 4002).
 *   Reconnecting would evict it, so the SDK does not.
 * - [CONNECTION_FAILED]: the network, the server, or a fatal signaling error.
 */
public enum class DisconnectReason { CLIENT_INITIATED, REMOVED, ROOM_CLOSED, TOKEN_EXPIRED, REPLACED, CONNECTION_FAILED }

/** What this participant may currently do, as the server last said (phase1 §1.4). */
public data class ParticipantPermissions(
    val subscribe: Boolean = true,
    val publish: Boolean = false,
    val publishAudio: Boolean = false,
    val publishVideo: Boolean = false,
    /**
     * Screen-share, independent of [publishVideo] (agora-parity audit,
     * phase 2). Granting camera video never implies this, and vice versa.
     */
    val publishScreen: Boolean = false,
    val publishData: Boolean = false,
    /** phase7 §2: may change its own metadata and attributes ([LocalParticipant.setMetadata]). Default false. */
    val updateOwnMetadata: Boolean = false,
) {
    /**
     * Whether a track of this media kind may be published right now. For
     * video this is [publishVideo] specifically (a camera check) — see
     * [mayPublishKind] for one that also knows about screen share.
     */
    public fun mayPublish(kind: MediaKind): Boolean =
        publish && if (kind == MediaKind.AUDIO) publishAudio else publishVideo

    /**
     * Whether a track of this declared [TrackKind] may be published right
     * now. Screen share gates on [publishScreen], not [publishVideo]; its
     * own audio companion is still just audio, gated on [publishAudio].
     */
    public fun mayPublishKind(kind: TrackKind): Boolean {
        if (!publish) return false
        return when (kind) {
            TrackKind.MICROPHONE, TrackKind.SCREEN_SHARE_AUDIO -> publishAudio
            TrackKind.SCREEN_SHARE -> publishScreen
            else -> publishVideo
        }
    }
}

/** Non-fatal conditions. Mirrors the web SDK's `RTCWarningCode`. */
public enum class RtcWarningCode { TOKEN_EXPIRING, TOKEN_REFRESH_FAILED }

/** Which data channel a message travels on (phase7 §1.1). */
public enum class DataChannelKind(public val wire: String) {
    /** `raven-data`: reliable and ordered, up to 64 KiB. */
    RELIABLE("reliable"),
    /** `raven-data-lossy`: unordered, no retransmits, up to 1,200 bytes. Latest value wins. */
    LOSSY("lossy"),
}

/**
 * Options for [Room.sendData] (phase7 §1.6). The defaults send exactly what
 * the SDK always sent: a reliable broadcast with no topic.
 */
public data class DataPublishOptions(
    /** Up to 255 bytes of UTF-8. Delivered to receivers as [RoomEvent.DataReceived.topic]. */
    val topic: String? = null,
    /** Empty means everyone. At most 64 identities; unknown ones are skipped by the SFU. */
    val destinationIdentities: List<String> = emptyList(),
    /** False sends on the lossy channel (needs a server with `data.v2`). Default true. */
    val reliable: Boolean = true,
)

public data class RtcWarning(
    val code: RtcWarningCode,
    val message: String,
    /** ISO timestamp the current token expires at, when the server said. */
    val expiresAt: String? = null,
    val cause: Throwable? = null,
)

/** End-to-end encryption state of one participant's media (phase5 §3.2). */
public enum class E2eeState { OK, MISSING_KEY, ENCRYPT_FAILED, DECRYPT_FAILED, KEY_RATCHETED, INTERNAL_ERROR }
