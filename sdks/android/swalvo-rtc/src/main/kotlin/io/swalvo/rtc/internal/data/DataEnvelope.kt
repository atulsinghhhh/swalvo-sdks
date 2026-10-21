package io.swalvo.rtc.internal.data

import io.swalvo.rtc.RtcErrorCode
import io.swalvo.rtc.RtcException
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * Data messages v2 (docs/architecture/phase7-contracts.md §1.2-1.3).
 *
 * Client → SFU:
 * `0x52 0x02 | flags | topicLen | topic | destCount | destCount × (idLen | identity) | payload`
 *
 * SFU → client:
 * `0x52 0x03 | senderLen | sender | topicLen | topic | payload`
 *
 * Anything else that arrives (including a truncated delivery frame or one
 * with invalid UTF-8) is a legacy message: the whole input is the payload.
 * Checked byte for byte against docs/architecture/data-envelope-vectors.json.
 */
internal object DataEnvelope {
    const val MAGIC: Int = 0x52
    const val VERSION_CLIENT: Int = 0x02
    const val VERSION_DELIVERY: Int = 0x03
    const val MAX_TOPIC_BYTES: Int = 255
    const val MAX_DESTINATIONS: Int = 64
    const val MAX_IDENTITY_BYTES: Int = 255
    const val MAX_RELIABLE_PAYLOAD_BYTES: Int = 64 * 1024
    const val MAX_LOSSY_PAYLOAD_BYTES: Int = 1200

    /**
     * Throws [RtcException] with [RtcErrorCode.INVALID_ARGUMENT] when a
     * payload is over its channel's limit: the same code every other SDK
     * uses for it (not `MEDIA_ERROR`, which is for media failures).
     */
    fun checkPayloadSize(size: Int, reliable: Boolean) {
        val limit = if (reliable) MAX_RELIABLE_PAYLOAD_BYTES else MAX_LOSSY_PAYLOAD_BYTES
        if (size > limit) {
            val channel = if (reliable) "reliable" else "lossy"
            throw invalid("Data payload is $size bytes, over the $limit-byte $channel limit")
        }
    }

    /** A received message. [legacy] messages have no sender and no topic; `senderIdentity == ""` is the server. */
    class Decoded(val payload: ByteArray, val senderIdentity: String?, val topic: String?, val legacy: Boolean)

    /** Builds a client → SFU envelope. Throws [RtcException] with [RtcErrorCode.INVALID_ARGUMENT] past the limits. */
    fun encode(payload: ByteArray, topic: String? = null, destinationIdentities: List<String> = emptyList()): ByteArray {
        val topicBytes = (topic ?: "").toByteArray(Charsets.UTF_8)
        if (topicBytes.size > MAX_TOPIC_BYTES) {
            throw invalid("Data topic is ${topicBytes.size} bytes of UTF-8, over the $MAX_TOPIC_BYTES-byte limit")
        }
        if (destinationIdentities.size > MAX_DESTINATIONS) {
            throw invalid("Data messages go to at most $MAX_DESTINATIONS identities, not ${destinationIdentities.size}")
        }
        val ids = destinationIdentities.map { identity ->
            val bytes = identity.toByteArray(Charsets.UTF_8)
            if (bytes.isEmpty()) throw invalid("A destination identity cannot be empty")
            if (bytes.size > MAX_IDENTITY_BYTES) {
                throw invalid("Destination identity is ${bytes.size} bytes of UTF-8, over the $MAX_IDENTITY_BYTES-byte limit")
            }
            bytes
        }
        val out = ByteArrayOutputStream(5 + topicBytes.size + ids.sumOf { it.size + 1 } + payload.size)
        out.write(MAGIC)
        out.write(VERSION_CLIENT)
        out.write(0) // flags: reserved, all zero
        out.write(topicBytes.size)
        out.write(topicBytes)
        out.write(ids.size)
        for (id in ids) {
            out.write(id.size)
            out.write(id)
        }
        out.write(payload)
        return out.toByteArray()
    }

    /** Parses an SFU → client frame. Never throws: anything that is not a well-formed delivery frame is legacy. */
    fun decode(bytes: ByteArray): Decoded {
        val legacy = Decoded(bytes, null, null, legacy = true)
        if (bytes.size < 2 || (bytes[0].toInt() and 0xFF) != MAGIC || (bytes[1].toInt() and 0xFF) != VERSION_DELIVERY) return legacy
        var offset = 2
        if (offset >= bytes.size) return legacy
        val senderLen = bytes[offset++].toInt() and 0xFF
        if (offset + senderLen > bytes.size) return legacy
        val sender = utf8(bytes, offset, senderLen) ?: return legacy
        offset += senderLen
        if (offset >= bytes.size) return legacy
        val topicLen = bytes[offset++].toInt() and 0xFF
        if (offset + topicLen > bytes.size) return legacy
        val topic = utf8(bytes, offset, topicLen) ?: return legacy
        offset += topicLen
        return Decoded(bytes.copyOfRange(offset, bytes.size), sender, topic, legacy = false)
    }

    /** Strict UTF-8: malformed input is reported, never replaced with U+FFFD. */
    private fun utf8(bytes: ByteArray, offset: Int, length: Int): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes, offset, length))
            .toString()
    } catch (_: CharacterCodingException) {
        null
    }

    private fun invalid(message: String) = RtcException(RtcErrorCode.INVALID_ARGUMENT, message)
}
