package io.swalvo.rtc.internal.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/*
 * Swalvo's signaling wire protocol (docs/rtc/signaling.md), as the client
 * sees it. Mirrors packages/sdk/src/internal/signaling/protocol.ts and
 * sdks/flutter/swalvo_rtc/lib/src/internal/protocol.dart.
 *
 * Every message is a JSON text frame with a `type` discriminator. Unknown
 * message types and unknown fields are ignored, never treated as errors
 * (signaling.md "Versioning"): an additive server change must not break a
 * shipped app.
 */

// --- Shared shapes ----------------------------------------------------------

@Serializable
internal data class WireTrack(
    val trackId: String,
    val kind: String,
    val source: String = "",
    val muted: Boolean = false,
    val simulcast: Boolean = false,
    val layers: List<String>? = null,
)

@Serializable
internal data class WireParticipant(
    val id: String,
    val tracks: List<WireTrack>? = null,
    /** phase7 §2: opaque, at most 4 KiB. Absent from older servers. */
    val metadata: String? = null,
    /** phase7 §2: at most 32 keys. Absent from older servers. */
    val attributes: Map<String, String>? = null,
)

@Serializable
internal data class WirePermissions(
    val subscribe: Boolean = true,
    val publish: Boolean = false,
    val publishAudio: Boolean = false,
    val publishVideo: Boolean = false,
    /** Screen-share, independent of publishVideo (agora-parity audit, phase 2). */
    val publishScreen: Boolean = false,
    val publishData: Boolean = false,
    /** phase7 §2. Absent means "unchanged": older servers do not send it. */
    val updateOwnMetadata: Boolean? = null,
)

@Serializable
internal data class WireSpeaker(val participantId: String, val level: Double)

@Serializable
internal data class WireQualityUpdate(val participantId: String, val quality: String)

@Serializable
internal data class WireLayerActivity(val rid: String, val active: Boolean)

@Serializable
internal data class ResumeRequest(val token: String)

// --- Client → server ----------------------------------------------------------

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
internal sealed class ClientMessage {
    @Serializable
    @SerialName("room.join")
    data class RoomJoin(
        val roomId: String? = null,
        val region: String? = null,
        val resume: ResumeRequest? = null,
        /** Sent only as `false` (phase2 §4); absent means the server default, true. */
        val autoSubscribe: Boolean? = null,
    ) : ClientMessage()

    @Serializable
    @SerialName("room.leave")
    data object RoomLeave : ClientMessage()

    @Serializable
    @SerialName("token.refresh")
    data class TokenRefresh(val token: String) : ClientMessage()

    @Serializable
    @SerialName("sdp.answer")
    data class SdpAnswer(val sdp: String) : ClientMessage()

    @Serializable
    @SerialName("sdp.offer")
    data class SdpOffer(val sdp: String) : ClientMessage()

    @Serializable
    @SerialName("ice.candidate")
    data class IceCandidate(
        val candidate: String,
        val sdpMid: String? = null,
        val sdpMLineIndex: Int? = null,
        val usernameFragment: String? = null,
    ) : ClientMessage()

    @Serializable
    @SerialName("track.publish")
    data class TrackPublish(val trackId: String, val source: String) : ClientMessage()

    @Serializable
    @SerialName("track.mute")
    data class TrackMute(val trackId: String, val muted: Boolean) : ClientMessage()

    @Serializable
    @SerialName("subscription.update")
    data class SubscriptionUpdate(
        val publisherId: String,
        val trackId: String,
        val layer: String,
    ) : ClientMessage()

    @Serializable
    @SerialName("ping")
    data object Ping : ClientMessage()

    /** phase7 §2: needs the token grant `perms.updateOwnMetadata`. Absent fields are left as they are. */
    @Serializable
    @SerialName("participant.update")
    data class ParticipantUpdate(
        val metadata: String? = null,
        val attributes: Map<String, String>? = null,
    ) : ClientMessage()
}

// --- Server → client ----------------------------------------------------------

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
internal sealed class ServerMessage {
    @Serializable
    @SerialName("room.joined")
    data class RoomJoined(
        val roomId: String,
        val participants: List<WireParticipant> = emptyList(),
        val rtcServer: String? = null,
        val region: String? = null,
        val clientRegion: String? = null,
        val resumeToken: String? = null,
        val resumed: Boolean? = null,
        /** phase5 §3.1: the room requires end-to-end encrypted media. */
        val e2ee: Boolean? = null,
        /** phase7 §1.6: e.g. `["data.v2"]`. Older servers omit it. */
        val capabilities: List<String>? = null,
    ) : ServerMessage()

    @Serializable
    @SerialName("room.left")
    data class RoomLeft(val roomId: String? = null, val reason: String? = null) : ServerMessage()

    @Serializable
    @SerialName("room.resume_token")
    data class RoomResumeToken(val resumeToken: String) : ServerMessage()

    @Serializable
    @SerialName("participant.joined")
    data class ParticipantJoined(val participant: WireParticipant) : ServerMessage()

    @Serializable
    @SerialName("participant.left")
    data class ParticipantLeft(val participant: WireParticipant) : ServerMessage()

    /**
     * phase7 §2. The fields are [JsonElement]s so "absent" (keep) and an
     * explicit `null` (cleared) stay distinguishable.
     */
    @Serializable
    @SerialName("participant.updated")
    data class ParticipantUpdated(
        val participantId: String,
        val metadata: JsonElement? = null,
        val attributes: JsonElement? = null,
    ) : ServerMessage()

    /** phase7 §1.4: the SFU dropped some of our data messages on `channel` (`reliable` or `lossy`). */
    @Serializable
    @SerialName("data.throttled")
    data class DataThrottled(val channel: String = "reliable") : ServerMessage()

    @Serializable
    @SerialName("participant.permissions_updated")
    data class PermissionsUpdated(val permissions: WirePermissions) : ServerMessage()

    @Serializable
    @SerialName("track.published")
    data class TrackPublished(val participantId: String, val track: WireTrack) : ServerMessage()

    @Serializable
    @SerialName("track.unpublished")
    data class TrackUnpublished(val participantId: String, val trackId: String) : ServerMessage()

    @Serializable
    @SerialName("track.muted")
    data class TrackMuted(
        val participantId: String,
        val trackId: String,
        val byServer: Boolean? = null,
    ) : ServerMessage()

    @Serializable
    @SerialName("track.unmuted")
    data class TrackUnmuted(
        val participantId: String,
        val trackId: String,
        val byServer: Boolean? = null,
    ) : ServerMessage()

    @Serializable
    @SerialName("sdp.offer")
    data class SdpOffer(val sdp: String) : ServerMessage()

    @Serializable
    @SerialName("sdp.answer")
    data class SdpAnswer(val sdp: String) : ServerMessage()

    @Serializable
    @SerialName("ice.candidate")
    data class IceCandidate(
        val candidate: String,
        val sdpMid: String? = null,
        val sdpMLineIndex: Int? = null,
        val usernameFragment: String? = null,
    ) : ServerMessage()

    @Serializable
    @SerialName("connection.state")
    data class ConnectionState(val iceState: String = "", val peerState: String = "") : ServerMessage()

    @Serializable
    @SerialName("error")
    data class Error(val code: String, val message: String = "") : ServerMessage()

    @Serializable
    @SerialName("pong")
    data object Pong : ServerMessage()

    @Serializable
    @SerialName("token.expiring")
    data class TokenExpiring(val expiresAt: String) : ServerMessage()

    @Serializable
    @SerialName("token.refreshed")
    data class TokenRefreshed(val expiresAt: String) : ServerMessage()

    @Serializable
    @SerialName("speakers.changed")
    data class SpeakersChanged(val speakers: List<WireSpeaker> = emptyList()) : ServerMessage()

    @Serializable
    @SerialName("quality.changed")
    data class QualityChanged(val updates: List<WireQualityUpdate> = emptyList()) : ServerMessage()

    @Serializable
    @SerialName("subscription.state")
    data class SubscriptionState(
        val publisherId: String,
        val trackId: String,
        val state: String,
        val layer: String? = null,
    ) : ServerMessage()

    @Serializable
    @SerialName("publisher.layers")
    data class PublisherLayers(
        val trackId: String,
        val layers: List<WireLayerActivity> = emptyList(),
    ) : ServerMessage()

    /** phase6 §4.1: a live caption. `transcriptionId` is null for an agent's own speech with no transcription running. */
    @Serializable
    @SerialName("transcription.segment")
    data class TranscriptionSegment(
        val transcriptionId: String? = null,
        val agentId: String? = null,
        val participantId: String,
        val segmentId: String,
        val text: String,
        @SerialName("final") val isFinal: Boolean,
        val language: String = "",
        val startMs: Long = 0,
        val endMs: Long = 0,
    ) : ServerMessage()

    /** phase6 §4.3. `status` is kept as a string; an unknown value is dropped by the room. */
    @Serializable
    @SerialName("transcription.state")
    data class TranscriptionState(
        val transcriptionId: String,
        val status: String,
        val language: String = "",
    ) : ServerMessage()

    /** phase6 §4.2. `state` is kept as a string; an unknown value is dropped by the room. */
    @Serializable
    @SerialName("agent.state")
    data class AgentState(
        val agentId: String = "",
        val participantId: String,
        val state: String,
    ) : ServerMessage()

    /** A message type this SDK does not know. Ignored by design (signaling.md "Versioning"). */
    data class Unknown(val type: String?, val raw: JsonObject) : ServerMessage()
}

internal object ServerMessageTypes {
    val known: Set<String> = setOf(
        "room.joined", "room.left", "room.resume_token",
        "participant.joined", "participant.left", "participant.permissions_updated",
        "participant.updated", "data.throttled",
        "track.published", "track.unpublished", "track.muted", "track.unmuted",
        "sdp.offer", "sdp.answer", "ice.candidate", "connection.state", "error", "pong",
        "token.expiring", "token.refreshed",
        "speakers.changed", "quality.changed", "subscription.state", "publisher.layers",
        "transcription.segment", "transcription.state", "agent.state",
    )
}

/** Signaling error codes (signaling.md "error"). Unknown codes are kept as strings. */
internal object SignalingErrorCodes {
    const val INVALID_TOKEN = "INVALID_TOKEN"
    const val TOKEN_EXPIRED = "TOKEN_EXPIRED"
    const val TOKEN_REVOKED = "TOKEN_REVOKED"
    const val TOKEN_INVALID = "TOKEN_INVALID"
    const val UNAUTHORIZED = "UNAUTHORIZED"
    const val PERMISSION_DENIED = "PERMISSION_DENIED"
    const val ORIGIN_NOT_ALLOWED = "ORIGIN_NOT_ALLOWED"
    const val ROOM_NOT_FOUND = "ROOM_NOT_FOUND"
    const val ROOM_FULL = "ROOM_FULL"
    const val ROOM_CLOSED = "ROOM_CLOSED"
    const val USAGE_LIMIT_EXCEEDED = "USAGE_LIMIT_EXCEEDED"
    const val NOT_IN_ROOM = "NOT_IN_ROOM"
    const val NO_RTC_CAPACITY = "NO_RTC_CAPACITY"
    const val RTC_SERVER_UNREACHABLE = "RTC_SERVER_UNREACHABLE"
    const val NEGOTIATION_GLARE = "NEGOTIATION_GLARE"
    const val NEGOTIATION_FAILED = "NEGOTIATION_FAILED"
    const val RATE_LIMITED = "RATE_LIMITED"

    /**
     * "The credential (or the account) is the problem": reconnecting on the
     * same token cannot help. Same set as the web SDK's FATAL_ERROR_CODES.
     */
    val FATAL: Set<String> = setOf(
        INVALID_TOKEN, TOKEN_EXPIRED, TOKEN_REVOKED, UNAUTHORIZED, ROOM_NOT_FOUND,
        PERMISSION_DENIED, ORIGIN_NOT_ALLOWED, USAGE_LIMIT_EXCEEDED,
    )
}

/** WebSocket close codes the client acts on (signaling.md "Close codes"). */
internal object CloseCodes {
    const val NORMAL = 1000
    const val ABNORMAL = 1006
    const val SERVICE_RESTART = 1012
    const val AUTH_FAILED = 4001
    const val REPLACED = 4002
    const val REMOVED = 4003
    const val NODE_LOST = 4004
    const val RATE_LIMITED = 4029
}

/** JSON codec for the wire protocol. */
internal object ProtocolJson {
    @OptIn(ExperimentalSerializationApi::class)
    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = false
        isLenient = false
        coerceInputValues = true
    }

    fun encode(message: ClientMessage): String = json.encodeToString(ClientMessage.serializer(), message)

    fun encodeServer(message: ServerMessage): String {
        require(message !is ServerMessage.Unknown) { "an unknown message has no encoding" }
        return json.encodeToString(ServerMessage.serializer(), message)
    }

    fun decodeClient(text: String): ClientMessage = json.decodeFromString(ClientMessage.serializer(), text)

    /**
     * Parses one server frame. Returns null for a frame that is not a JSON
     * object (logged and dropped by the caller); an object with an
     * unrecognised `type` decodes to [ServerMessage.Unknown]. A known type
     * whose required fields are missing also decodes to Unknown rather
     * than throwing, so one malformed frame cannot take the session down.
     */
    fun decodeServer(text: String): ServerMessage? {
        val element = try {
            json.parseToJsonElement(text)
        } catch (_: Exception) {
            return null
        }
        val obj = (element as? JsonObject) ?: return null
        val type = (obj["type"] as? JsonPrimitive)?.contentOrNull
        if (type == null || type !in ServerMessageTypes.known) {
            return ServerMessage.Unknown(type, obj)
        }
        if (type == "participant.updated") {
            // Decoded by hand: the serializer would fold an explicit `null` into "absent".
            val id = (obj["participantId"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
                ?: return ServerMessage.Unknown(type, obj)
            return ServerMessage.ParticipantUpdated(id, obj["metadata"], obj["attributes"])
        }
        return try {
            json.decodeFromJsonElement(ServerMessage.serializer(), obj)
        } catch (_: Exception) {
            ServerMessage.Unknown(type, element.jsonObject)
        }
    }
}
