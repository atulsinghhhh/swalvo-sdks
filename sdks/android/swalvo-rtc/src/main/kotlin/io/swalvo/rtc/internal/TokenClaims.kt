package io.swalvo.rtc.internal

import io.swalvo.rtc.ParticipantPermissions
import io.swalvo.rtc.RtcErrorCode
import io.swalvo.rtc.RtcException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * The few RTC-token claims the client reads (never verifies: the server
 * does). `rid` room id, `rnm` room name, `sub` identity, `exp` expiry,
 * `perms` grants, `e2ee` (phase5 §3.1).
 */
internal data class TokenClaims(
    val roomId: String?,
    val roomName: String?,
    val identity: String?,
    val expiresAtEpochSeconds: Long?,
    val permissions: ParticipantPermissions?,
    val e2ee: Boolean,
    /** phase7 §2: initial metadata (`md`) and attributes (`attrs`). */
    val metadata: String? = null,
    val attributes: Map<String, String> = emptyMap(),
) {
    companion object {
        fun decode(token: String): TokenClaims {
            val parts = token.split('.')
            if (parts.size != 3) {
                throw RtcException(RtcErrorCode.INVALID_TOKEN, "RTC token is malformed (expected a JWT with 3 parts)")
            }
            val obj = try {
                Json.parseToJsonElement(String(Base64Url.decode(parts[1]), Charsets.UTF_8)) as JsonObject
            } catch (e: Exception) {
                throw RtcException(RtcErrorCode.INVALID_TOKEN, "RTC token payload could not be decoded", e)
            }
            fun str(key: String) = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            val perms = obj["perms"] as? JsonObject
            return TokenClaims(
                roomId = str("rid"),
                roomName = str("rnm"),
                identity = str("sub"),
                expiresAtEpochSeconds = (obj["exp"] as? JsonPrimitive)?.longOrNull,
                permissions = perms?.let {
                    fun flag(key: String) = (it[key] as? JsonPrimitive)?.booleanOrNull
                    ParticipantPermissions(
                        subscribe = flag("subscribe") != false,
                        publish = flag("publish") == true,
                        publishAudio = flag("publishAudio") == true,
                        publishVideo = flag("publishVideo") == true,
                        publishScreen = flag("publishScreen") == true,
                        publishData = flag("publishData") == true,
                        updateOwnMetadata = flag("updateOwnMetadata") == true,
                    )
                },
                e2ee = (obj["e2ee"] as? JsonPrimitive)?.booleanOrNull == true,
                metadata = str("md"),
                attributes = (obj["attrs"] as? JsonObject)?.mapNotNull { (k, v) ->
                    (v as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.let { k to it }
                }?.toMap().orEmpty(),
            )
        }

        fun decodeOrNull(token: String): TokenClaims? = try {
            decode(token)
        } catch (_: RtcException) {
            null
        }
    }
}

/** RFC 4648 §5 base64url, padding optional. Hand-written: java.util.Base64 is API 26+, android.util.Base64 is stubbed on the JVM. */
internal object Base64Url {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val LOOKUP = IntArray(128) { -1 }.also { table ->
        ALPHABET.forEachIndexed { i, c -> table[c.code] = i }
        table['+'.code] = 62
        table['/'.code] = 63
    }

    fun decode(input: String): ByteArray {
        val clean = input.trimEnd('=')
        val out = java.io.ByteArrayOutputStream(clean.length * 3 / 4)
        var buffer = 0
        var bits = 0
        for (c in clean) {
            val v = if (c.code < 128) LOOKUP[c.code] else -1
            require(v >= 0) { "invalid base64url character" }
            buffer = (buffer shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buffer shr bits) and 0xFF)
            }
        }
        return out.toByteArray()
    }

    fun encode(bytes: ByteArray): String {
        val sb = StringBuilder()
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i].toInt() and 0xFF
            val b1 = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xFF else 0
            val b2 = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xFF else 0
            sb.append(ALPHABET[b0 shr 2])
            sb.append(ALPHABET[((b0 and 3) shl 4) or (b1 shr 4)])
            if (i + 1 < bytes.size) sb.append(ALPHABET[((b1 and 15) shl 2) or (b2 shr 6)])
            if (i + 2 < bytes.size) sb.append(ALPHABET[b2 and 63])
            i += 3
        }
        return sb.toString()
    }
}
