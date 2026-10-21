package io.swalvo.rtc.internal.signaling

import io.swalvo.rtc.DisconnectReason
import io.swalvo.rtc.Logger
import io.swalvo.rtc.RtcErrorCode
import io.swalvo.rtc.RtcException
import io.swalvo.rtc.RtcWarningCode
import io.swalvo.rtc.internal.protocol.ClientMessage
import io.swalvo.rtc.internal.protocol.ServerMessage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** Fixed jitter so backoff delays are exact: delay = 0.5 × ceiling. */
private class FixedRandom(private val value: Double) : Random() {
    override fun nextBits(bitCount: Int): Int = 0
    override fun nextDouble(): Double = value
}

@OptIn(ExperimentalCoroutinesApi::class)
class SignalingClientTest {

    private class Harness(
        val scope: TestScope,
        refresh: (suspend () -> String)? = null,
        autoReconnect: Boolean = true,
        token: String = testToken(),
        autoSubscribe: Boolean = true,
    ) {
        val transport = FakeTransport()
        val events = mutableListOf<SignalingEvent>()
        var refreshCalls = 0
        val client = SignalingClient(
            options = SignalingClient.Options(
                endpoint = "wss://api.test/v1/rtc",
                token = token,
                roomId = "room_123",
                autoReconnect = autoReconnect,
                refreshToken = refresh?.let { r -> suspend { refreshCalls++; r() } },
                autoSubscribe = autoSubscribe,
            ),
            transport = transport,
            scope = scope.backgroundScope,
            logger = Logger.SILENT,
            random = FixedRandom(0.5),
            clock = { scope.testScheduler.currentTime },
            listener = { events += it },
        )

        inline fun <reified T : SignalingEvent> eventsOf(): List<T> = events.filterIsInstance<T>()
    }

    private fun joined(resumeToken: String? = "rt_1", resumed: Boolean? = null, participants: String = "[]"): String {
        val rt = resumeToken?.let { ""","resumeToken":"$it"""" } ?: ""
        val rs = resumed?.let { ""","resumed":$it""" } ?: ""
        return """{"type":"room.joined","roomId":"room_123","rtcServer":"sfu-1","participants":$participants$rt$rs}"""
    }

    /** Opens the first socket, answers the join, returns the payload. */
    private suspend fun TestScope.connect(h: Harness, joinedJson: String = joined()): JoinedPayload {
        val result = async { h.client.connect() }
        runCurrent()
        h.transport.last.open()
        runCurrent()
        h.transport.last.receive(joinedJson)
        runCurrent()
        return result.await()
    }

    /** Lets a scheduled reconnect fire, opens its socket and answers its join. */
    private fun TestScope.completeReconnect(h: Harness, afterMs: Long, joinedJson: String) {
        advanceTimeBy(afterMs + 1)
        runCurrent()
        h.transport.last.open()
        runCurrent()
        h.transport.last.receive(joinedJson)
        runCurrent()
    }

    // --- Join -------------------------------------------------------------------------

    @Test
    fun joinSendsRoomJoinFirstAndResolvesOnRoomJoined() = runTest {
        val h = Harness(this)
        val payload = connect(h, joined(participants = """[{"id":"bob","tracks":[]}]"""))

        val socket = h.transport.sockets.single()
        assertTrue(socket.url.startsWith("wss://api.test/v1/rtc?token="))
        assertEquals(testToken(), socket.token)
        val join = socket.sentObjects().first()
        assertEquals("room.join", join["type"]!!.jsonPrimitive.content)
        assertEquals("room_123", join["roomId"]!!.jsonPrimitive.content)
        assertNull("a first join never asks to resume", join["resume"])
        assertNull("autoSubscribe is only sent as false", join["autoSubscribe"])

        assertEquals("room_123", payload.roomId)
        assertEquals("bob", payload.participants.single().id)
        assertFalse(payload.resumed)
        assertTrue(h.client.isJoined)
        assertEquals(1, h.eventsOf<SignalingEvent.Joined>().size)
        assertEquals("rt_1", h.client.heldResumeToken)
    }

    @Test
    fun autoSubscribeFalseIsSentOnJoin() = runTest {
        val h = Harness(this, autoSubscribe = false)
        connect(h)
        val join = h.transport.last.sentObjects().first()
        assertEquals(false, join["autoSubscribe"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun aFatalErrorOnTheFirstJoinThrowsAndNeverRetries() = runTest {
        val h = Harness(this)
        val result = async { runCatching { h.client.connect() } }
        runCurrent()
        h.transport.last.open()
        runCurrent()
        h.transport.last.receive("""{"type":"error","code":"INVALID_TOKEN","message":"bad signature"}""")
        runCurrent()
        val error = result.await().exceptionOrNull()
        assertTrue(error is RtcException)
        assertEquals(RtcErrorCode.INVALID_TOKEN, (error as RtcException).code)
        advanceTimeBy(60_000)
        assertEquals(1, h.transport.sockets.size)
    }

    @Test
    fun anUnreachableServerFailsTheFirstJoin() = runTest {
        val h = Harness(this)
        val result = async { runCatching { h.client.connect() } }
        runCurrent()
        h.transport.last.drop()
        runCurrent()
        assertEquals(RtcErrorCode.NETWORK_ERROR, (result.await().exceptionOrNull() as RtcException).code)
    }

    @Test
    fun joinTimesOutWhenTheServerNeverAnswers() = runTest {
        val h = Harness(this)
        val result = async { runCatching { h.client.connect() } }
        runCurrent()
        h.transport.last.open()
        advanceTimeBy(SignalingClient.JOIN_TIMEOUT_MS + 1)
        runCurrent()
        assertEquals(RtcErrorCode.TIMEOUT, (result.await().exceptionOrNull() as RtcException).code)
        assertEquals(1000, h.transport.last.closedWith)
    }

    @Test
    fun serverMessagesAfterTheJoinAreForwardedAndUnknownOnesDropped() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.receive("""{"type":"sdp.offer","sdp":"v=0"}""")
        h.transport.last.receive("""{"type":"something.new","x":1}""")
        h.transport.last.receive("""{"type":"speakers.changed","speakers":[]}""")
        runCurrent()
        val forwarded = h.eventsOf<SignalingEvent.Message>().map { it.message }
        assertEquals(listOf(ServerMessage.SdpOffer("v=0"), ServerMessage.SpeakersChanged(emptyList())), forwarded)
    }

    // --- Resume -------------------------------------------------------------------------

    @Test
    fun close1012ReconnectsWithinTheJitterAndResumes() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.receive("""{"type":"room.resume_token","resumeToken":"rt_2"}""")
        runCurrent()

        h.transport.last.serverClose(1012, "server restarting")
        runCurrent()
        assertEquals(listOf(SignalingEvent.Reconnecting(resuming = true)), h.eventsOf<SignalingEvent.Reconnecting>())
        assertFalse(h.client.isJoined)

        // 1012 uses a 0–2 s jitter (0.5 → 1000 ms), not the normal backoff.
        advanceTimeBy(999)
        runCurrent()
        assertEquals(1, h.transport.sockets.size)
        advanceTimeBy(2)
        runCurrent()
        assertEquals(2, h.transport.sockets.size)

        h.transport.last.open()
        runCurrent()
        val join = h.transport.last.sentObjects().first()
        assertEquals("rt_2", join["resume"]!!.jsonObject["token"]!!.jsonPrimitive.content)

        h.transport.last.receive(joined(resumeToken = "rt_3", resumed = true))
        runCurrent()
        val rejoined = h.eventsOf<SignalingEvent.Joined>().last().payload
        assertTrue(rejoined.resumed)
        assertTrue(h.client.isJoined)
        assertEquals("rt_3", h.client.heldResumeToken)
    }

    @Test
    fun resumedFalseIsReportedAsAFreshJoin() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.drop() // abnormal close (1006)
        runCurrent()
        assertTrue(h.eventsOf<SignalingEvent.Reconnecting>().single().resuming)
        // attempt 1: ceiling 300 ms × 0.5 = 150 ms
        completeReconnect(h, 150, joined(resumeToken = "rt_9", resumed = false))
        assertTrue(h.transport.last.sentObjects().first().containsKey("resume"))
        assertFalse(h.eventsOf<SignalingEvent.Joined>().last().payload.resumed)
    }

    @Test
    fun aResumedFlagIsIgnoredWhenTheJoinDidNotAskToResume() = runTest {
        val h = Harness(this)
        connect(h, joined(resumeToken = null))
        h.transport.last.drop()
        runCurrent()
        assertFalse("nothing to resume", h.eventsOf<SignalingEvent.Reconnecting>().single().resuming)
        completeReconnect(h, 150, joined(resumed = true))
        assertNull(h.transport.last.sentObjects().first()["resume"])
        assertFalse(h.eventsOf<SignalingEvent.Joined>().last().payload.resumed)
    }

    @Test
    fun aStaleResumeTokenIsNotSent() = runTest {
        val h = Harness(this)
        connect(h)
        advanceTimeBy(SignalingClient.RESUME_TOKEN_MAX_AGE_MS + 1)
        h.transport.last.drop()
        runCurrent()
        assertFalse(h.eventsOf<SignalingEvent.Reconnecting>().single().resuming)
        completeReconnect(h, 150, joined())
        assertNull(h.transport.last.sentObjects().first()["resume"])
    }

    @Test
    fun close4004RejoinsWithoutResume() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.serverClose(4004)
        runCurrent()
        assertFalse(h.eventsOf<SignalingEvent.Reconnecting>().single().resuming)
        completeReconnect(h, 150, joined())
        assertNull(h.transport.last.sentObjects().first()["resume"])
    }

    // --- Terminal closes --------------------------------------------------------------------

    @Test
    fun close4003EndsTheSessionAndNeverReconnects() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.receive("""{"type":"room.left","roomId":"room_123","reason":"REMOVED"}""")
        runCurrent()
        h.transport.last.serverClose(4003)
        runCurrent()
        assertEquals(listOf(SignalingEvent.Ended(DisconnectReason.REMOVED)), h.eventsOf<SignalingEvent.Ended>())
        advanceTimeBy(120_000)
        runCurrent()
        assertEquals(1, h.transport.sockets.size)
        assertTrue(h.eventsOf<SignalingEvent.Reconnecting>().isEmpty())
    }

    @Test
    fun bare4003WithoutRoomLeftStillMeansRemoved() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.serverClose(4003)
        runCurrent()
        assertEquals(DisconnectReason.REMOVED, h.eventsOf<SignalingEvent.Ended>().single().reason)
        advanceTimeBy(60_000)
        assertEquals(1, h.transport.sockets.size)
    }

    @Test
    fun roomClosedIsReportedAsRoomClosed() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.receive("""{"type":"room.left","roomId":"room_123","reason":"ROOM_CLOSED"}""")
        h.transport.last.receive("""{"type":"error","code":"ROOM_CLOSED","message":"closed"}""")
        runCurrent()
        h.transport.last.serverClose(4003)
        runCurrent()
        assertEquals(DisconnectReason.ROOM_CLOSED, h.eventsOf<SignalingEvent.Ended>().single().reason)
        assertTrue(h.eventsOf<SignalingEvent.Failed>().isEmpty())
    }

    @Test
    fun close4002IsReplacedAndNeverReconnects() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.serverClose(4002)
        runCurrent()
        assertEquals(DisconnectReason.REPLACED, h.eventsOf<SignalingEvent.Ended>().single().reason)
        advanceTimeBy(60_000)
        assertEquals(1, h.transport.sockets.size)
    }

    @Test
    fun clientCloseSendsRoomLeaveAndDoesNotReconnect() = runTest {
        val h = Harness(this)
        connect(h)
        h.client.close()
        runCurrent()
        assertEquals("room.leave", h.transport.last.sentTypes().last())
        assertEquals(1000, h.transport.last.closedWith)
        assertEquals(listOf<SignalingEvent>(SignalingEvent.Closed), h.events.filterNot { it is SignalingEvent.Joined })
        advanceTimeBy(60_000)
        assertEquals(1, h.transport.sockets.size)
    }

    // --- Auth / tokens ----------------------------------------------------------------------------

    @Test
    fun close4001WithRefreshFetchesANewTokenAndReconnectsWithoutResume() = runTest {
        val h = Harness(this, refresh = { testToken(extra = ""","v":2""") })
        connect(h)
        h.transport.last.receive("""{"type":"room.left","roomId":"room_123","reason":"TOKEN_EXPIRED"}""")
        h.transport.last.receive("""{"type":"error","code":"TOKEN_EXPIRED","message":"expired"}""")
        runCurrent()
        h.transport.last.serverClose(4001)
        runCurrent()
        assertEquals(1, h.refreshCalls)
        assertTrue(h.eventsOf<SignalingEvent.Failed>().isEmpty())
        completeReconnect(h, 150, joined())
        assertEquals(testToken(extra = ""","v":2"""), h.transport.last.token)
        assertNull("a credential failure discards the session", h.transport.last.sentObjects().first()["resume"])
        assertTrue(h.client.isJoined)
    }

    @Test
    fun close4001WithoutRefreshFailsWithTokenExpired() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.serverClose(4001)
        runCurrent()
        val failed = h.eventsOf<SignalingEvent.Failed>().single()
        assertEquals(DisconnectReason.TOKEN_EXPIRED, failed.reason)
        assertEquals(RtcErrorCode.TOKEN_EXPIRED, failed.error.code)
        advanceTimeBy(60_000)
        assertEquals(1, h.transport.sockets.size)
    }

    @Test
    fun aRevokedTokenWithRefreshReconnectsOnANewToken() = runTest {
        val h = Harness(this, refresh = { testToken(sub = "me", extra = ""","v":3""") })
        connect(h)
        h.transport.last.receive("""{"type":"room.left","reason":"TOKEN_REVOKED"}""")
        h.transport.last.receive("""{"type":"error","code":"TOKEN_REVOKED","message":"revoked"}""")
        h.transport.last.serverClose(4001)
        runCurrent()
        completeReconnect(h, 150, joined())
        assertEquals(testToken(sub = "me", extra = ""","v":3"""), h.transport.last.token)
    }

    @Test
    fun tokenExpiringRefreshesTheLiveSessionWithoutReconnecting() = runTest {
        val fresh = testToken(extra = ""","v":4""")
        val h = Harness(this, refresh = { fresh })
        connect(h)
        h.transport.last.receive("""{"type":"token.expiring","expiresAt":"2026-10-02T12:00:00.000Z"}""")
        runCurrent()
        val refresh = h.transport.last.sentObjects().last()
        assertEquals("token.refresh", refresh["type"]!!.jsonPrimitive.content)
        assertEquals(fresh, refresh["token"]!!.jsonPrimitive.content)
        assertEquals("not swapped until confirmed", testToken(), h.client.currentToken)

        h.transport.last.receive("""{"type":"token.refreshed","expiresAt":"2026-10-02T12:10:00.000Z"}""")
        runCurrent()
        assertEquals(fresh, h.client.currentToken)
        assertEquals(1, h.transport.sockets.size)
        assertTrue("token frames are consumed, not forwarded", h.eventsOf<SignalingEvent.Message>().isEmpty())
    }

    @Test
    fun aRefusedRefreshIsAWarningNotADisconnect() = runTest {
        val h = Harness(this, refresh = { testToken(extra = ""","v":5""") })
        connect(h)
        h.transport.last.receive("""{"type":"token.expiring","expiresAt":"x"}""")
        runCurrent()
        h.transport.last.receive("""{"type":"error","code":"TOKEN_INVALID","message":"different identity"}""")
        runCurrent()
        assertEquals(RtcWarningCode.TOKEN_REFRESH_FAILED, h.eventsOf<SignalingEvent.Warning>().single().warning.code)
        assertEquals(testToken(), h.client.currentToken)
        assertTrue(h.client.isJoined)
        assertTrue(h.eventsOf<SignalingEvent.Failed>().isEmpty())
    }

    @Test
    fun aThrowingRefreshCallbackIsAWarning() = runTest {
        val h = Harness(this, refresh = { throw IllegalStateException("backend down") })
        connect(h)
        h.transport.last.receive("""{"type":"token.expiring","expiresAt":"x"}""")
        runCurrent()
        assertEquals(RtcWarningCode.TOKEN_REFRESH_FAILED, h.eventsOf<SignalingEvent.Warning>().single().warning.code)
        assertTrue(h.client.isJoined)
    }

    @Test
    fun tokenExpiringWithoutRefreshWarns() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.receive("""{"type":"token.expiring","expiresAt":"2026-10-02T12:00:00.000Z"}""")
        runCurrent()
        val warning = h.eventsOf<SignalingEvent.Warning>().single().warning
        assertEquals(RtcWarningCode.TOKEN_EXPIRING, warning.code)
        assertEquals("2026-10-02T12:00:00.000Z", warning.expiresAt)
    }

    @Test
    fun aTokenAboutToExpireIsRefreshedBeforeAPlainReconnect() = runTest {
        // exp = 10 s from virtual time 0: within the 30 s skew.
        val h = Harness(this, token = testToken(exp = 10), refresh = { testToken(exp = 3600) })
        connect(h)
        h.transport.last.drop()
        runCurrent()
        completeReconnect(h, 150, joined())
        assertEquals(1, h.refreshCalls)
        assertEquals(testToken(exp = 3600), h.transport.last.token)
    }

    // --- Backoff --------------------------------------------------------------------------------------

    @Test
    fun backoffIsFullJitterExponentialAndCapped() = runTest {
        val h = Harness(this)
        val delays = (1..8).map { h.client.reconnectDelayMs(it, serviceRestart = false, rateLimited = false) }
        assertEquals(listOf(150L, 300L, 600L, 1200L, 2400L, 4800L, 5000L, 5000L), delays)
        assertEquals(1000L, h.client.reconnectDelayMs(1, serviceRestart = true, rateLimited = false))
        assertEquals(SignalingClient.RATE_LIMITED_MIN_DELAY_MS, h.client.reconnectDelayMs(1, serviceRestart = false, rateLimited = true))
    }

    @Test
    fun repeatedFailuresGiveUpAfterTheAttemptBudget() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.drop()
        runCurrent()
        repeat(SignalingClient.RECONNECT_MAX_ATTEMPTS) {
            advanceTimeBy(SignalingClient.RECONNECT_MAX_MS)
            runCurrent()
            h.transport.last.drop() // the server is unreachable
            runCurrent()
        }
        val failed = h.eventsOf<SignalingEvent.Failed>().single()
        assertEquals(DisconnectReason.CONNECTION_FAILED, failed.reason)
        assertEquals(1 + SignalingClient.RECONNECT_MAX_ATTEMPTS, h.transport.sockets.size)
        advanceTimeBy(120_000)
        assertEquals(1 + SignalingClient.RECONNECT_MAX_ATTEMPTS, h.transport.sockets.size)
    }

    @Test
    fun reconnectNowSkipsTheRemainingBackoff() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.drop()
        runCurrent()
        // Fail attempt 1 quickly so attempt 2 waits 300 ms.
        advanceTimeBy(151)
        runCurrent()
        h.transport.last.drop()
        runCurrent()
        val before = h.transport.sockets.size
        h.client.reconnectNow()
        runCurrent()
        assertEquals(before + 1, h.transport.sockets.size)
    }

    @Test
    fun sendIsDroppedWhileDisconnected() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.drop()
        runCurrent()
        assertFalse(h.client.send(ClientMessage.Ping))
    }

    @Test
    fun anErrorDuringAReconnectJoinThatIsFatalStops() = runTest {
        val h = Harness(this)
        connect(h)
        h.transport.last.drop()
        runCurrent()
        advanceTimeBy(151)
        runCurrent()
        h.transport.last.open()
        runCurrent()
        h.transport.last.receive("""{"type":"error","code":"USAGE_LIMIT_EXCEEDED","message":"out of minutes"}""")
        runCurrent()
        val failed = h.eventsOf<SignalingEvent.Failed>().single()
        assertEquals(RtcErrorCode.USAGE_LIMIT_EXCEEDED, failed.error.code)
        advanceTimeBy(60_000)
        assertEquals(2, h.transport.sockets.size)
    }
}
