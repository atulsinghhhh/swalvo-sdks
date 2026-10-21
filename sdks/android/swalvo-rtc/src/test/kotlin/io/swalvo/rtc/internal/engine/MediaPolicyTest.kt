package io.swalvo.rtc.internal.engine

import io.swalvo.rtc.RtcErrorCode
import io.swalvo.rtc.RtcException
import io.swalvo.rtc.VideoLayer
import io.swalvo.rtc.internal.TokenClaims
import io.swalvo.rtc.internal.signaling.testToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MediaPolicyTest {
    private val sdp = listOf(
        "v=0",
        "o=- 1 2 IN IP4 127.0.0.1",
        "s=-",
        "a=group:BUNDLE 0 1 2",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        "a=mid:0",
        "a=msid:alice-stream alice-mic",
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "a=mid:1",
        "a=msid:alice-stream alice-cam",
        "a=rid:low send",
        "a=rid:medium send",
        "a=rid:high send",
        "a=simulcast:send low;medium;high",
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "a=mid:2",
        "a=msid:bob-stream  bob-screen",
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
        "a=mid:3",
    ).joinToString("\r\n") + "\r\n"

    @Test
    fun msidIsFoundByMidNotByScanning() {
        assertEquals("alice-mic", SdpUtils.msidTrackIdForMid(sdp, "0"))
        assertEquals("alice-cam", SdpUtils.msidTrackIdForMid(sdp, "1"))
        assertEquals("bob-screen", SdpUtils.msidTrackIdForMid(sdp, "2"))
        assertNull("no msid on the data section", SdpUtils.msidTrackIdForMid(sdp, "3"))
        assertNull(SdpUtils.msidTrackIdForMid(sdp, "9"))
        assertNull(SdpUtils.msidTrackIdForMid(sdp.replace("\r\n", "\n").replace("a=msid:alice-stream alice-cam", "a=msid:only-stream"), "1"))
        assertEquals("alice-cam", SdpUtils.msidTrackIdForMid(sdp.replace("\r\n", "\n"), "1"))
    }

    @Test
    fun simulcastIsDetectedOnlyWithAllThreeRids() {
        assertTrue(SdpUtils.negotiatesSimulcast(sdp))
        assertFalse(SdpUtils.negotiatesSimulcast(sdp.replace("a=rid:high send\r\n", "")))
    }

    @Test
    fun publisherLayerRidsMatchExactlyAndByAlias() {
        assertTrue(Simulcast.ridMatches("low", "low"))
        assertTrue(Simulcast.ridMatches("low", "q"))
        assertTrue(Simulcast.ridMatches("medium", "h"))
        assertTrue(Simulcast.ridMatches("f", "high"))
        assertFalse(Simulcast.ridMatches("low", "h"))
        assertFalse(Simulcast.ridMatches(null, "q"))

        val activity = Simulcast.activityFor(
            listOf("low", "medium", "high"),
            listOf("q" to true, "h" to false, "f" to false),
        )
        assertEquals(mapOf(0 to true, 1 to false, 2 to false), activity)
        // Encodings a frame does not mention are left alone.
        assertEquals(mapOf(0 to false), Simulcast.activityFor(listOf("low", "medium"), listOf("low" to false)))
    }

    @Test
    fun simulcastLadderMatchesTheWebSdk() {
        assertEquals(listOf("low", "medium", "high"), Simulcast.LAYERS.map { it.rid })
        assertEquals(listOf(4.0, 2.0, 1.0), Simulcast.LAYERS.map { it.scaleResolutionDownBy })
        assertEquals(listOf(150_000, 500_000, 1_500_000), Simulcast.LAYERS.map { it.maxBitrateBps })
    }

    @Test
    fun layerPrecedence() {
        assertEquals("off", LayerPolicy.effectiveLayer(enabled = false, pinned = VideoLayer.HIGH, adaptiveStream = true, visible = true))
        assertEquals("high", LayerPolicy.effectiveLayer(enabled = true, pinned = VideoLayer.HIGH, adaptiveStream = true, visible = false))
        assertEquals("off", LayerPolicy.effectiveLayer(enabled = true, pinned = null, adaptiveStream = true, visible = false))
        assertEquals("auto", LayerPolicy.effectiveLayer(enabled = true, pinned = null, adaptiveStream = false, visible = false))
        assertEquals("auto", LayerPolicy.effectiveLayer(enabled = true, pinned = null, adaptiveStream = true, visible = true))
    }

    @Test
    fun tokenClaimsAreRead() {
        val claims = TokenClaims.decode(
            testToken(sub = "ada", rid = "room_9", exp = 1_900_000_000, extra = ""","e2ee":true,"perms":{"publish":true,"publishAudio":true}"""),
        )
        assertEquals("ada", claims.identity)
        assertEquals("room_9", claims.roomId)
        assertEquals("standup", claims.roomName)
        assertEquals(1_900_000_000L, claims.expiresAtEpochSeconds)
        assertTrue(claims.e2ee)
        val perms = claims.permissions!!
        assertTrue(perms.subscribe && perms.publish && perms.publishAudio)
        assertFalse(perms.publishVideo)

        try {
            TokenClaims.decode("not-a-jwt")
            fail("expected INVALID_TOKEN")
        } catch (e: RtcException) {
            assertEquals(RtcErrorCode.INVALID_TOKEN, e.code)
        }
    }
}
