package io.swalvo.rtc.internal.data

import io.swalvo.rtc.RtcErrorCode
import io.swalvo.rtc.RtcException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * Data messages v2 envelope vectors (docs/architecture/data-envelope-vectors.json,
 * shared by every client SDK). Reads the repo copy when built inside the
 * monorepo, else the bundled copy.
 */
class DataEnvelopeVectorsTest {
    private val vectors: JsonObject by lazy {
        val repoCopy = File("../../../docs/architecture/data-envelope-vectors.json")
        val text = if (repoCopy.isFile) repoCopy.readText() else javaClass.classLoader!!.getResource("data-envelope-vectors.json")!!.readText()
        Json.parseToJsonElement(text).jsonObject
    }

    private fun hex(value: String): ByteArray = ByteArray(value.length / 2) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private fun input(case: JsonObject): Triple<ByteArray, String, List<String>> {
        val input = case["input"]!!.jsonObject
        return Triple(
            hex(input["payloadHex"]!!.jsonPrimitive.content),
            input["topic"]!!.jsonPrimitive.content,
            input["destinationIdentities"]!!.jsonArray.map { it.jsonPrimitive.content },
        )
    }

    @Test
    fun encodesEveryVector() {
        val cases = vectors["encode"]!!.jsonArray
        assertTrue(cases.size >= 10)
        for (element in cases) {
            val case = element.jsonObject
            val (payload, topic, ids) = input(case)
            val name = case["name"]!!.jsonPrimitive.content
            assertEquals(name, case["expectedHex"]!!.jsonPrimitive.content, DataEnvelope.encode(payload, topic, ids).toHex())
        }
    }

    @Test
    fun rejectsEveryErrorVector() {
        for (element in vectors["encodeErrors"]!!.jsonArray) {
            val case = element.jsonObject
            val (payload, topic, ids) = input(case)
            val name = case["name"]!!.jsonPrimitive.content
            try {
                DataEnvelope.encode(payload, topic, ids)
                fail("expected an error: $name")
            } catch (e: RtcException) {
                assertEquals(name, RtcErrorCode.INVALID_ARGUMENT, e.code)
            }
        }
    }

    @Test
    fun oversizedPayloadIsInvalidArgument() {
        DataEnvelope.checkPayloadSize(64 * 1024, reliable = true)
        DataEnvelope.checkPayloadSize(1200, reliable = false)
        for ((size, reliable) in listOf(64 * 1024 + 1 to true, 1201 to false)) {
            try {
                DataEnvelope.checkPayloadSize(size, reliable)
                fail("expected an error for $size bytes, reliable=$reliable")
            } catch (e: RtcException) {
                assertEquals(RtcErrorCode.INVALID_ARGUMENT, e.code)
            }
        }
    }

    @Test
    fun decodesEveryVector() {
        val cases = vectors["decode"]!!.jsonArray
        assertTrue(cases.size >= 10)
        for (element in cases) {
            val case = element.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val expected = case["expected"]!!.jsonObject
            val decoded = DataEnvelope.decode(hex(case["inputHex"]!!.jsonPrimitive.content))
            assertEquals(name, expected["legacy"]!!.jsonPrimitive.boolean, decoded.legacy)
            assertEquals(name, expected["payloadHex"]!!.jsonPrimitive.content, decoded.payload.toHex())
            val sender = expected["senderIdentity"]!!
            if (sender is JsonNull) assertNull(name, decoded.senderIdentity) else assertEquals(name, sender.jsonPrimitive.content, decoded.senderIdentity)
            val topic = expected["topic"]!!
            if (topic is JsonNull) assertNull(name, decoded.topic) else assertEquals(name, topic.jsonPrimitive.content, decoded.topic)
        }
    }

    @Test
    fun limitsMatchTheVectors() {
        val limits = vectors["format"]!!.jsonObject["limits"]!!.jsonObject
        assertEquals(limits["maxTopicBytes"]!!.jsonPrimitive.int, DataEnvelope.MAX_TOPIC_BYTES)
        assertEquals(limits["maxDestinations"]!!.jsonPrimitive.int, DataEnvelope.MAX_DESTINATIONS)
        assertEquals(limits["maxIdentityBytes"]!!.jsonPrimitive.int, DataEnvelope.MAX_IDENTITY_BYTES)
        assertEquals(limits["maxReliablePayloadBytes"]!!.jsonPrimitive.int, DataEnvelope.MAX_RELIABLE_PAYLOAD_BYTES)
        assertEquals(limits["maxLossyPayloadBytes"]!!.jsonPrimitive.int, DataEnvelope.MAX_LOSSY_PAYLOAD_BYTES)
    }

    @Test
    fun bundledCopyMatchesTheRepo() {
        val repoCopy = File("../../../docs/architecture/data-envelope-vectors.json")
        if (!repoCopy.isFile) return
        val bundled = javaClass.classLoader!!.getResource("data-envelope-vectors.json")!!.readText()
        assertEquals(Json.parseToJsonElement(repoCopy.readText()), Json.parseToJsonElement(bundled))
    }

    @Test
    fun noOptionsMeansNoMagic() {
        // A legacy payload never gets a prefix: the room only envelopes when asked or when the server has data.v2.
        val decoded = DataEnvelope.decode(byteArrayOf(1, 2, 3))
        assertTrue(decoded.legacy)
        assertArrayEquals(byteArrayOf(1, 2, 3), decoded.payload)
        assertFalse(DataEnvelope.encode(byteArrayOf()).isEmpty())
    }
}
