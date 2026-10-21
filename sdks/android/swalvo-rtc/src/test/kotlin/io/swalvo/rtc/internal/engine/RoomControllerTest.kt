package io.swalvo.rtc.internal.engine

import io.swalvo.rtc.ConnectionQuality
import io.swalvo.rtc.ConnectionState
import io.swalvo.rtc.DisconnectReason
import io.swalvo.rtc.ForwardedLayer
import io.swalvo.rtc.LocalMediaHandle
import io.swalvo.rtc.LocalParticipant
import io.swalvo.rtc.LocalTrack
import io.swalvo.rtc.Logger
import io.swalvo.rtc.ParticipantEvent
import io.swalvo.rtc.ParticipantPermissions
import io.swalvo.rtc.RemoteMediaHandle
import io.swalvo.rtc.RemoteTrack
import io.swalvo.rtc.RoomEvent
import io.swalvo.rtc.TrackKind
import io.swalvo.rtc.TrackSubscriptionState
import io.swalvo.rtc.VideoLayer
import io.swalvo.rtc.internal.protocol.ClientMessage
import io.swalvo.rtc.internal.protocol.ProtocolJson
import io.swalvo.rtc.internal.signaling.JoinedPayload
import io.swalvo.rtc.internal.signaling.SignalingEvent
import io.swalvo.rtc.internal.protocol.WireParticipant
import io.swalvo.rtc.internal.protocol.WireTrack
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.webrtc.MediaStreamTrack

private class FakeRemoteHandle(val name: String) : RemoteMediaHandle {
    override val track: MediaStreamTrack? = null
}

private class FakeLocalHandle : LocalMediaHandle {
    var isOn = true
    var disposed = false
    override val track: MediaStreamTrack? = null
    override fun setEnabled(enabled: Boolean) { isOn = enabled }
    override fun dispose() { disposed = true }
}

/** Records what the controller asks of the media side. */
private class FakeMediaEngine(private val listener: () -> MediaEngine.Listener) : MediaEngine {
    val calls = mutableListOf<String>()
    val published = mutableListOf<LocalTrack>()
    override var peerState: PeerState = PeerState.NEW
    override var hasPeerConnection: Boolean = false
    override val publishedTracks: List<LocalTrack> get() = published.toList()
    override fun applyOffer(sdp: String) { calls += "offer:$sdp"; hasPeerConnection = true }
    override fun applyAnswer(sdp: String) { calls += "answer:$sdp" }
    override fun addRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?) { calls += "candidate:$candidate:$sdpMid:$sdpMLineIndex" }
    override fun applyPublisherLayers(trackId: String, layers: List<Pair<String, Boolean>>) { calls += "layers:$trackId:" + layers.joinToString(",") { "${it.first}=${it.second}" } }
    override fun discardConnection() { calls += "discard"; hasPeerConnection = false }
    override fun restorePublications() { calls += "restore" }
    override suspend fun unpublish(track: LocalTrack) {
        calls += "unpublish:${track.kind}"
        published.remove(track)
        listener().onLocalTrackUnpublished(track)
    }
    override fun onSubscribed(handle: RemoteMediaHandle, participantId: String) { calls += "subscribed:$participantId" }
    override fun openDataChannels() { calls += "dataChannels" }
    override fun close() { calls += "close" }
}

@OptIn(ExperimentalCoroutinesApi::class)
class RoomControllerTest {

    private class Harness(scope: TestScope, autoSubscribe: Boolean = true, adaptiveStream: Boolean = true) {
        val events = mutableListOf<RoomEvent>()
        val sent = mutableListOf<ClientMessage>()
        var rejoins = 0
        val local = LocalParticipant("me")
        lateinit var controller: RoomController
        val engine = FakeMediaEngine { controller }

        init {
            controller = RoomController(
                localParticipant = local,
                scope = scope.backgroundScope,
                logger = Logger.SILENT,
                options = RoomController.Options(autoSubscribe = autoSubscribe, adaptiveStream = adaptiveStream),
                send = { sent += it; true },
                emit = { events += it },
                requestRejoin = { rejoins++ },
            )
            controller.engine = engine
        }

        fun server(json: String) = controller.onSignalingEvent(SignalingEvent.Message(ProtocolJson.decodeServer(json)!!))

        fun join(
            participants: List<WireParticipant> = emptyList(),
            resumed: Boolean = false,
            e2ee: Boolean = false,
            capabilities: List<String> = emptyList(),
        ) = controller.onSignalingEvent(SignalingEvent.Joined(JoinedPayload("room_123", participants, "sfu-1", null, null, resumed, e2ee, capabilities)))

        inline fun <reified T : RoomEvent> eventsOf(): List<T> = events.filterIsInstance<T>()

        fun localTrack(kind: TrackKind, id: String): LocalTrack =
            LocalTrack(kind, id, FakeLocalHandle()) { _, _ -> }.also { engine.published += it }
    }

    private val bobCam = WireTrack("bob-cam", "video", "camera", muted = false, simulcast = true, layers = listOf("low", "medium", "high"))
    private val bobMic = WireTrack("bob-mic", "audio", "microphone")

    @Test
    fun joinRosterBecomesParticipantJoinedAndTrackPublished() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", listOf(bobCam, bobMic)), WireParticipant("me", emptyList())))
        val joined = h.eventsOf<RoomEvent.ParticipantJoined>()
        assertEquals(listOf("bob"), joined.map { it.participant.identity })
        assertEquals(listOf(TrackKind.CAMERA, TrackKind.MICROPHONE), h.eventsOf<RoomEvent.TrackPublished>().map { it.kind })
        assertEquals(listOf("restore"), h.engine.calls)
        assertEquals(1, h.controller.remoteParticipants.size)
    }

    @Test
    fun trackPublishedThenMediaCompletesTheSubscription() = runTest {
        val h = Harness(this)
        h.join()
        h.server("""{"type":"participant.joined","participant":{"id":"bob","tracks":[]}}""")
        h.server("""{"type":"track.published","participantId":"bob","track":{"trackId":"bob-cam","kind":"video","source":"camera","muted":false,"simulcast":true}}""")
        assertTrue(h.eventsOf<RoomEvent.TrackSubscribed>().isEmpty())

        h.controller.onRemoteMedia("bob-cam", FakeRemoteHandle("cam"))
        val subscribed = h.eventsOf<RoomEvent.TrackSubscribed>().single()
        assertEquals("bob", subscribed.participant.identity)
        assertEquals("bob-cam", subscribed.track.trackId)
        assertEquals(TrackKind.CAMERA, subscribed.track.kind)
        assertEquals(listOf(subscribed.track), subscribed.participant.tracks)
        assertTrue("e2ee hook is told who it belongs to", "subscribed:bob" in h.engine.calls)
    }

    @Test
    fun mediaBeforeTheAnnouncementIsParkedThenCompleted() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", emptyList())))
        h.controller.onRemoteMedia("bob-screen", FakeRemoteHandle("screen"))
        assertTrue(h.eventsOf<RoomEvent.TrackSubscribed>().isEmpty())
        h.server("""{"type":"track.published","participantId":"bob","track":{"trackId":"bob-screen","kind":"video","source":"screenShare","muted":false,"simulcast":false}}""")
        val subscribed = h.eventsOf<RoomEvent.TrackSubscribed>().single()
        assertEquals(TrackKind.SCREEN_SHARE, subscribed.track.kind)
        // published fires before subscribed
        val order = h.events.filter { it is RoomEvent.TrackPublished || it is RoomEvent.TrackSubscribed }
        assertTrue(order[0] is RoomEvent.TrackPublished && order[1] is RoomEvent.TrackSubscribed)
    }

    @Test
    fun muteUnmuteAndUnpublishAreMapped() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", listOf(bobMic))))
        h.controller.onRemoteMedia("bob-mic", FakeRemoteHandle("mic"))
        val track = h.eventsOf<RoomEvent.TrackSubscribed>().single().track

        h.server("""{"type":"track.muted","participantId":"bob","trackId":"bob-mic"}""")
        assertTrue(track.isMuted)
        assertEquals(TrackKind.MICROPHONE, h.eventsOf<RoomEvent.TrackMuted>().single().kind)
        h.server("""{"type":"track.unmuted","participantId":"bob","trackId":"bob-mic"}""")
        assertFalse(track.isMuted)
        assertEquals(1, h.eventsOf<RoomEvent.TrackUnmuted>().size)

        h.server("""{"type":"track.unpublished","participantId":"bob","trackId":"bob-mic"}""")
        assertEquals(1, h.eventsOf<RoomEvent.TrackUnpublished>().size)
        assertSame(track, h.eventsOf<RoomEvent.TrackUnsubscribed>().single().track)
        assertTrue(h.controller.remoteParticipants["bob"]!!.tracks.isEmpty())
    }

    @Test
    fun participantLeftUnsubscribesItsTracksFirst() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", listOf(bobCam))))
        h.controller.onRemoteMedia("bob-cam", FakeRemoteHandle("cam"))
        h.server("""{"type":"participant.left","participant":{"id":"bob"}}""")
        val tail = h.events.takeLast(2)
        assertTrue(tail[0] is RoomEvent.TrackUnsubscribed)
        assertTrue(tail[1] is RoomEvent.ParticipantLeft)
        assertTrue(h.controller.remoteParticipants.isEmpty())
    }

    @Test
    fun speakersQualityAndSubscriptionStateAreMapped() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", listOf(bobCam))))
        val bob = h.controller.remoteParticipants["bob"]!!
        val bobEvents = mutableListOf<ParticipantEvent>()
        val job = backgroundScope.launchCollect(bob) { bobEvents += it }

        h.server("""{"type":"speakers.changed","speakers":[{"participantId":"me","level":1.7},{"participantId":"bob","level":0.4},{"participantId":"ghost","level":0.9}]}""")
        val speakers = h.eventsOf<RoomEvent.ActiveSpeakersChanged>().single().speakers
        assertEquals(listOf("me", "bob"), speakers.map { it.identity })
        assertTrue(h.local.isSpeaking)
        assertEquals(1.0f, h.local.audioLevel)
        assertTrue(bob.isSpeaking)

        h.server("""{"type":"speakers.changed","speakers":[]}""")
        assertFalse(bob.isSpeaking)
        assertTrue(h.eventsOf<RoomEvent.ActiveSpeakersChanged>().last().speakers.isEmpty())

        assertEquals(ConnectionQuality.UNKNOWN, bob.connectionQuality)
        h.server("""{"type":"quality.changed","updates":[{"participantId":"bob","quality":"poor"},{"participantId":"me","quality":"stellar"}]}""")
        h.server("""{"type":"quality.changed","updates":[{"participantId":"bob","quality":"poor"}]}""")
        val quality = h.eventsOf<RoomEvent.ConnectionQualityChanged>().single()
        assertSame(bob, quality.participant)
        assertEquals(ConnectionQuality.POOR, quality.quality)

        // subscription.state before the track exists is parked, then applied.
        h.server("""{"type":"subscription.state","publisherId":"bob","trackId":"bob-cam","state":"paused_bandwidth"}""")
        assertTrue(h.eventsOf<RoomEvent.TrackSubscriptionStateChanged>().isEmpty())
        h.controller.onRemoteMedia("bob-cam", FakeRemoteHandle("cam"))
        val track = h.eventsOf<RoomEvent.TrackSubscribed>().single().track
        assertEquals(TrackSubscriptionState.PAUSED_BANDWIDTH, track.subscriptionState)
        assertEquals(ForwardedLayer.OFF, track.layer)

        h.server("""{"type":"subscription.state","publisherId":"bob","trackId":"bob-cam","state":"active","layer":"medium"}""")
        assertEquals(TrackSubscriptionState.ACTIVE, track.subscriptionState)
        assertEquals(ForwardedLayer.MEDIUM, track.layer)
        assertEquals(1, h.eventsOf<RoomEvent.TrackSubscriptionStateChanged>().size)
        runCurrent()
        job.cancel()
        assertTrue(bobEvents.contains(ParticipantEvent.IsSpeakingChanged(true)))
        assertTrue(bobEvents.contains(ParticipantEvent.ConnectionQualityChanged(ConnectionQuality.POOR)))
    }

    @Test
    fun serverMuteOfOwnTrackMutesLocallyAndEmitsLocalTrackMutedByServer() = runTest {
        val h = Harness(this)
        h.join()
        val mic = h.localTrack(TrackKind.MICROPHONE, "my-mic")
        h.server("""{"type":"track.muted","participantId":"me","trackId":"my-mic","byServer":true}""")
        assertTrue(mic.isMuted)
        assertFalse((mic.handle as FakeLocalHandle).isOn)
        assertSame(mic, h.eventsOf<RoomEvent.LocalTrackMutedByServer>().single().track)

        // A server *unmute* is not acted on.
        h.server("""{"type":"track.unmuted","participantId":"me","trackId":"my-mic","byServer":true}""")
        assertTrue(mic.isMuted)
    }

    @Test
    fun withdrawnPublishRightsStopTheAffectedPublications() = runTest {
        val h = Harness(this)
        h.join()
        h.localTrack(TrackKind.CAMERA, "my-cam")
        h.localTrack(TrackKind.MICROPHONE, "my-mic")
        h.server("""{"type":"participant.permissions_updated","permissions":{"subscribe":true,"publish":true,"publishAudio":true,"publishVideo":false,"publishData":false}}""")
        runCurrent()
        assertEquals(listOf("unpublish:CAMERA"), h.engine.calls.filter { it.startsWith("unpublish") })
        assertEquals(TrackKind.CAMERA, h.eventsOf<RoomEvent.LocalTrackUnpublished>().single().track.kind)
        val permissions = h.eventsOf<RoomEvent.PermissionsChanged>().single().permissions
        assertEquals(ParticipantPermissions(subscribe = true, publish = true, publishAudio = true), permissions)
        assertEquals(permissions, h.controller.permissions)
        assertTrue("withdrawal is not an error", h.eventsOf<RoomEvent.Error>().isEmpty())
    }

    @Test
    fun withdrawingPublishScreenStopsScreenShareIndependentlyOfCamera() = runTest {
        // agora-parity audit, phase 2: publishScreen gates screen share
        // independently of publishVideo.
        val h = Harness(this)
        h.join()
        h.localTrack(TrackKind.CAMERA, "my-cam")
        h.localTrack(TrackKind.SCREEN_SHARE, "my-screen")
        h.server(
            """{"type":"participant.permissions_updated","permissions":{"subscribe":true,"publish":true,"publishAudio":true,"publishVideo":true,"publishScreen":false,"publishData":false}}""",
        )
        runCurrent()
        assertEquals(listOf("unpublish:SCREEN_SHARE"), h.engine.calls.filter { it.startsWith("unpublish") })
        assertEquals(TrackKind.SCREEN_SHARE, h.eventsOf<RoomEvent.LocalTrackUnpublished>().single().track.kind)
        val permissions = h.eventsOf<RoomEvent.PermissionsChanged>().single().permissions
        assertEquals(
            ParticipantPermissions(subscribe = true, publish = true, publishAudio = true, publishVideo = true),
            permissions,
        )
        assertTrue("withdrawal is not an error", h.eventsOf<RoomEvent.Error>().isEmpty())
    }

    @Test
    fun negotiationFramesGoToTheEngine() = runTest {
        val h = Harness(this)
        h.join()
        h.server("""{"type":"sdp.offer","sdp":"OFFER"}""")
        h.server("""{"type":"sdp.answer","sdp":"ANSWER"}""")
        h.server("""{"type":"ice.candidate","candidate":"cand","sdpMid":"0","sdpMLineIndex":0}""")
        h.server("""{"type":"publisher.layers","trackId":"my-cam","layers":[{"rid":"q","active":true},{"rid":"f","active":false}]}""")
        h.server("""{"type":"error","code":"NEGOTIATION_GLARE","message":"in flight"}""")
        assertEquals(listOf("restore", "offer:OFFER", "answer:ANSWER", "candidate:cand:0:0", "layers:my-cam:q=true,f=false"), h.engine.calls)
        assertTrue("glare is retryable, not an error", h.eventsOf<RoomEvent.Error>().isEmpty())
    }

    @Test
    fun layerControlFollowsThePhase2Precedence() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", listOf(bobCam))))
        h.controller.onRemoteMedia("bob-cam", FakeRemoteHandle("cam"))
        val track: RemoteTrack = h.eventsOf<RoomEvent.TrackSubscribed>().single().track
        fun layers() = h.sent.filterIsInstance<ClientMessage.SubscriptionUpdate>().map { it.layer }

        track.setVisible(false)
        runCurrent()
        assertTrue("hiding is debounced", layers().isEmpty())
        advanceTimeBy(LayerPolicy.HIDE_DEBOUNCE_MS + 1)
        runCurrent()
        assertEquals(listOf("off"), layers())

        track.setVisible(true)
        runCurrent()
        assertEquals("showing resumes at once", listOf("off", "auto"), layers())

        track.setLayer(VideoLayer.LOW)
        runCurrent()
        track.setEnabled(false)
        runCurrent()
        assertEquals(listOf("off", "auto", "low", "off"), layers())

        // Pinned + invisible: the pin wins; nothing changes while disabled.
        track.setVisible(false)
        advanceTimeBy(1_000)
        runCurrent()
        track.setEnabled(true)
        runCurrent()
        assertEquals(listOf("off", "auto", "low", "off", "low"), layers())
        val update = h.sent.filterIsInstance<ClientMessage.SubscriptionUpdate>().last()
        assertEquals("bob", update.publisherId)
        assertEquals("bob-cam", update.trackId)
    }

    @Test
    fun hidingThenShowingWithinTheDebounceSendsNothing() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", listOf(bobCam))))
        h.controller.onRemoteMedia("bob-cam", FakeRemoteHandle("cam"))
        val track = h.eventsOf<RoomEvent.TrackSubscribed>().single().track
        track.setVisible(false)
        runCurrent()
        advanceTimeBy(200)
        track.setVisible(true)
        runCurrent()
        advanceTimeBy(1_000)
        runCurrent()
        assertTrue(h.sent.filterIsInstance<ClientMessage.SubscriptionUpdate>().isEmpty())
    }

    @Test
    fun autoSubscribeFalseStartsVideoPausedUntilWanted() = runTest {
        val h = Harness(this, autoSubscribe = false)
        h.join(listOf(WireParticipant("bob", listOf(bobCam, bobMic))))
        h.controller.onRemoteMedia("bob-cam", FakeRemoteHandle("cam"))
        h.controller.onRemoteMedia("bob-mic", FakeRemoteHandle("mic"))
        val (cam, mic) = h.eventsOf<RoomEvent.TrackSubscribed>().map { it.track }
        assertEquals(TrackSubscriptionState.PAUSED_CLIENT, cam.subscriptionState)
        assertEquals(ForwardedLayer.OFF, cam.layer)
        assertEquals("audio always flows", TrackSubscriptionState.ACTIVE, mic.subscriptionState)

        cam.setEnabled(true)
        runCurrent()
        assertEquals(listOf("auto"), h.sent.filterIsInstance<ClientMessage.SubscriptionUpdate>().map { it.layer })
    }

    @Test
    fun connectionLifecycleMapsToConnectedReconnectingReconnected() = runTest {
        val h = Harness(this)
        h.controller.markConnecting()
        h.join()
        h.server("""{"type":"sdp.offer","sdp":"O"}""")
        h.controller.onPeerState(PeerState.CONNECTED)
        h.engine.peerState = PeerState.CONNECTED
        assertEquals(ConnectionState.CONNECTED, h.controller.connectionState)
        assertEquals(1, h.eventsOf<RoomEvent.Connected>().size)

        // Socket drop with a resume token: the PeerConnection is kept.
        h.controller.onSignalingEvent(SignalingEvent.Reconnecting(resuming = true))
        assertEquals(ConnectionState.RECONNECTING, h.controller.connectionState)
        assertFalse("discard" in h.engine.calls)
        h.join(resumed = true)
        assertFalse("a resumed session keeps its PeerConnection", "discard" in h.engine.calls)
        assertEquals(ConnectionState.CONNECTED, h.controller.connectionState)
        assertEquals(1, h.eventsOf<RoomEvent.Reconnecting>().size)
        assertEquals(1, h.eventsOf<RoomEvent.Reconnected>().size)
        assertEquals(1, h.eventsOf<RoomEvent.Connected>().size)
        assertEquals(
            listOf(ConnectionState.CONNECTING, ConnectionState.CONNECTED, ConnectionState.RECONNECTING, ConnectionState.CONNECTED),
            h.eventsOf<RoomEvent.ConnectionStateChanged>().map { it.state },
        )
    }

    @Test
    fun resumedFalseRebuildsTheMediaConnection() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", listOf(bobCam))))
        h.server("""{"type":"sdp.offer","sdp":"O"}""")
        h.controller.onRemoteMedia("bob-cam", FakeRemoteHandle("cam"))
        h.controller.onSignalingEvent(SignalingEvent.Reconnecting(resuming = true))
        h.join(listOf(WireParticipant("bob", listOf(bobCam))), resumed = false)
        assertTrue("discard" in h.engine.calls)
        assertEquals(2, h.engine.calls.count { it == "restore" })
        assertEquals(1, h.eventsOf<RoomEvent.TrackUnsubscribed>().size)
        assertEquals("bob is still there: no leave/join flash", 1, h.eventsOf<RoomEvent.ParticipantJoined>().size)
        h.controller.onRemoteMedia("bob-cam", FakeRemoteHandle("cam2"))
        assertEquals(2, h.eventsOf<RoomEvent.TrackSubscribed>().size)
    }

    @Test
    fun reconnectingWithoutResumeDiscardsAtOnce() = runTest {
        val h = Harness(this)
        h.join()
        h.server("""{"type":"sdp.offer","sdp":"O"}""")
        h.controller.onSignalingEvent(SignalingEvent.Reconnecting(resuming = false))
        assertTrue("discard" in h.engine.calls)
    }

    @Test
    fun aRejoinRosterReconcilesParticipants() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", emptyList()), WireParticipant("carol", emptyList())))
        h.controller.onSignalingEvent(SignalingEvent.Reconnecting(resuming = false))
        h.join(listOf(WireParticipant("carol", emptyList()), WireParticipant("dave", emptyList())))
        assertEquals(listOf("bob"), h.eventsOf<RoomEvent.ParticipantLeft>().map { it.participant.identity })
        assertEquals(listOf("bob", "carol", "dave"), h.eventsOf<RoomEvent.ParticipantJoined>().map { it.participant.identity })
    }

    @Test
    fun endedAndFailedAreTerminalDisconnects() = runTest {
        val h = Harness(this)
        h.join()
        h.controller.onSignalingEvent(SignalingEvent.Ended(DisconnectReason.REMOVED))
        h.controller.onSignalingEvent(SignalingEvent.Closed)
        assertEquals(listOf(DisconnectReason.REMOVED), h.eventsOf<RoomEvent.Disconnected>().map { it.reason })
        assertEquals(ConnectionState.DISCONNECTED, h.controller.connectionState)
        assertTrue("close" in h.engine.calls)
    }

    @Test
    fun leavingReportsClientInitiated() = runTest {
        val h = Harness(this)
        h.join()
        h.controller.markIntentionalDisconnect()
        h.controller.onSignalingEvent(SignalingEvent.Closed)
        assertEquals(DisconnectReason.CLIENT_INITIATED, h.eventsOf<RoomEvent.Disconnected>().single().reason)
    }

    @Test
    fun aFailedMediaConnectionRejoinsAFewTimesThenFails() = runTest {
        val h = Harness(this)
        h.join()
        repeat(RoomController.MAX_MEDIA_REJOIN_ATTEMPTS) { h.controller.onPeerState(PeerState.FAILED) }
        assertEquals(RoomController.MAX_MEDIA_REJOIN_ATTEMPTS, h.rejoins)
        assertTrue(h.eventsOf<RoomEvent.Disconnected>().isEmpty())
        h.controller.onPeerState(PeerState.FAILED)
        assertEquals(DisconnectReason.CONNECTION_FAILED, h.eventsOf<RoomEvent.Disconnected>().single().reason)
        assertEquals(ConnectionState.FAILED, h.controller.connectionState)
    }

    @Test
    fun e2eeFlagFromJoinIsSticky() = runTest {
        val h = Harness(this)
        h.join(e2ee = true)
        assertTrue(h.controller.roomRequiresE2ee)
        h.join(e2ee = false)
        assertTrue(h.controller.roomRequiresE2ee)
    }

    @Test
    fun dataAndE2eeStateAreForwarded() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", emptyList())))
        h.controller.onDataReceived(byteArrayOf(1, 2, 3))
        assertEquals(3, h.eventsOf<RoomEvent.DataReceived>().single().payload.size)
        h.controller.onE2eeState("bob", io.swalvo.rtc.E2eeState.DECRYPT_FAILED)
        val e2ee = h.eventsOf<RoomEvent.E2eeStateChanged>().single()
        assertEquals("bob", e2ee.participant.identity)
        assertEquals(io.swalvo.rtc.E2eeState.DECRYPT_FAILED, e2ee.state)
    }

    // --- phase7 ---------------------------------------------------------------------------

    private fun hex(value: String): ByteArray = ByteArray(value.length / 2) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun dataV2CapabilityIsReadOnEveryJoin() = runTest {
        val h = Harness(this)
        h.join(capabilities = listOf("data.v2"))
        assertTrue(h.controller.supportsDataV2)
        h.join(capabilities = emptyList())
        assertFalse(h.controller.supportsDataV2)
    }

    @Test
    fun v2JoinWithoutPublishDataOpensNoChannelAndAGrantLaterOpensThem() = runTest {
        // A live-stream viewer: opening a channel is an offer the API refuses, failing the whole connection.
        val h = Harness(this)
        h.controller.permissions = ParticipantPermissions(subscribe = true)
        h.join(capabilities = listOf("data.v2"))
        assertEquals(0, h.engine.calls.count { it == "dataChannels" })

        h.server("""{"type":"participant.permissions_updated","permissions":{"subscribe":true,"publish":false,"publishAudio":false,"publishVideo":false,"publishData":true}}""")
        assertEquals(1, h.engine.calls.count { it == "dataChannels" })
    }

    @Test
    fun v2JoinOpensBothDataChannelsEagerly() = runTest {
        val h = Harness(this)
        h.join(capabilities = listOf("data.v2"))
        assertEquals(1, h.engine.calls.count { it == "dataChannels" })
        // A resume re-checks (the engine skips channels that are still open).
        h.join(resumed = true, capabilities = listOf("data.v2"))
        assertEquals(2, h.engine.calls.count { it == "dataChannels" })
    }

    @Test
    fun withoutTheCapabilityNoChannelIsOpenedAtJoin() = runTest {
        val h = Harness(this)
        h.join()
        h.join(resumed = true)
        assertTrue(h.engine.calls.none { it == "dataChannels" })
    }

    @Test
    fun bothChannelsCarryTheV2Protocol() {
        val reliable = PeerConnectionEngine.dataChannelInit(lossy = false)
        assertEquals("raven.v2", reliable.protocol)
        assertTrue(reliable.ordered)
        assertEquals(-1, reliable.maxRetransmits)
        val lossy = PeerConnectionEngine.dataChannelInit(lossy = true)
        assertEquals("raven.v2", lossy.protocol)
        assertFalse(lossy.ordered)
        assertEquals(0, lossy.maxRetransmits)
        assertEquals("raven-data", PeerConnectionEngine.DATA_CHANNEL_LABEL)
        assertEquals("raven-data-lossy", PeerConnectionEngine.LOSSY_DATA_CHANNEL_LABEL)
    }

    @Test
    fun dataReceivedCarriesSenderAndTopic() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("alice", emptyList())), capabilities = listOf("data.v2"))
        // 0x52 0x03 | "alice" | "chat" | "hello"
        h.controller.onDataReceived(hex("520305616c696365046368617468656c6c6f"))
        // From the server: empty sender.
        h.controller.onDataReceived(hex("5203000068656c6c6f"))
        // Legacy bytes.
        h.controller.onDataReceived(hex("68656c6c6f"))
        // From someone not (or no longer) in the room.
        h.controller.onDataReceived(hex("520303626f620068656c6c6f"))
        val received = h.eventsOf<RoomEvent.DataReceived>()
        assertEquals(4, received.size)
        assertEquals("alice", received[0].participant?.identity)
        assertEquals("chat", received[0].topic)
        assertEquals("hello", String(received[0].payload))
        for (event in received.drop(1)) {
            assertEquals(null, event.participant)
            assertEquals(null, event.topic)
            assertEquals("hello", String(event.payload))
        }
    }

    @Test
    fun dataThrottledBecomesAnEvent() = runTest {
        val h = Harness(this)
        h.join()
        h.server("""{"type":"data.throttled","channel":"lossy"}""")
        h.server("""{"type":"data.throttled","channel":"reliable"}""")
        assertEquals(
            listOf(io.swalvo.rtc.DataChannelKind.LOSSY, io.swalvo.rtc.DataChannelKind.RELIABLE),
            h.eventsOf<RoomEvent.DataThrottled>().map { it.channel },
        )
    }

    @Test
    fun metadataComesFromTheRosterAndJoins() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", emptyList(), metadata = "m-bob", attributes = mapOf("team" to "blue"))))
        val bob = h.controller.remoteParticipants.getValue("bob")
        assertEquals("m-bob", bob.metadata)
        assertEquals(mapOf("team" to "blue"), bob.attributes)
        h.server("""{"type":"participant.joined","participant":{"id":"carol","tracks":[],"metadata":"m-carol","attributes":{"a":"1"}}}""")
        val carol = h.controller.remoteParticipants.getValue("carol")
        assertEquals("m-carol", carol.metadata)
        assertEquals(mapOf("a" to "1"), carol.attributes)
        // Initial values are not "changes".
        assertTrue(h.eventsOf<RoomEvent.ParticipantMetadataChanged>().isEmpty())
    }

    @Test
    fun participantUpdatedReplacesPresentFieldsAndEmitsOnlyOnChange() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("bob", emptyList(), metadata = "old", attributes = mapOf("k" to "v"))))
        val bob = h.controller.remoteParticipants.getValue("bob")
        val participantEvents = mutableListOf<ParticipantEvent>()
        val job = launchCollect(bob) { participantEvents += it }

        h.server("""{"type":"participant.updated","participantId":"bob","attributes":{"k":"w","x":"y"}}""")
        assertEquals("old", bob.metadata)
        assertEquals(mapOf("k" to "w", "x" to "y"), bob.attributes)
        val change = h.eventsOf<RoomEvent.ParticipantMetadataChanged>().single()
        assertSame(bob, change.participant)
        assertEquals("old", change.previousMetadata)
        assertEquals(mapOf("k" to "v"), change.previousAttributes)

        // The same values again: no event.
        h.server("""{"type":"participant.updated","participantId":"bob","metadata":"old","attributes":{"k":"w","x":"y"}}""")
        assertEquals(1, h.eventsOf<RoomEvent.ParticipantMetadataChanged>().size)

        // An explicit null clears the metadata.
        h.server("""{"type":"participant.updated","participantId":"bob","metadata":null}""")
        assertEquals(null, bob.metadata)
        assertEquals(2, h.eventsOf<RoomEvent.ParticipantMetadataChanged>().size)
        runCurrent()
        assertEquals(2, participantEvents.filterIsInstance<ParticipantEvent.MetadataChanged>().size)
        job.cancel()
    }

    @Test
    fun participantUpdatedForTheLocalParticipant() = runTest {
        val h = Harness(this)
        h.join()
        h.server("""{"type":"participant.updated","participantId":"me","metadata":"mine"}""")
        assertEquals("mine", h.local.metadata)
        assertSame(h.local, h.eventsOf<RoomEvent.ParticipantMetadataChanged>().single().participant)
    }

    @Test
    fun setMetadataNeedsTheGrant() = runTest {
        val h = Harness(this)
        h.join()
        h.controller.permissions = ParticipantPermissions(publishData = true)
        val denied = runCatching { h.controller.updateLocalMetadata("x", null) }.exceptionOrNull() as io.swalvo.rtc.RtcException
        assertEquals(io.swalvo.rtc.RtcErrorCode.PERMISSION_DENIED, denied.code)
        assertTrue(h.sent.none { it is ClientMessage.ParticipantUpdate })

        h.controller.permissions = ParticipantPermissions(updateOwnMetadata = true)
        h.controller.updateLocalMetadata("x", null)
        h.controller.updateLocalMetadata(null, mapOf("hand" to "up"))
        assertEquals(
            listOf(ClientMessage.ParticipantUpdate(metadata = "x"), ClientMessage.ParticipantUpdate(attributes = mapOf("hand" to "up"))),
            h.sent.filterIsInstance<ClientMessage.ParticipantUpdate>(),
        )
        // Not optimistic: nothing changes until the server says so.
        assertEquals(null, h.local.metadata)
    }

    @Test
    fun permissionsUpdatedKeepsTheMetadataGrantWhenAbsent() = runTest {
        val h = Harness(this)
        h.join()
        h.controller.permissions = ParticipantPermissions(updateOwnMetadata = true)
        h.server("""{"type":"participant.permissions_updated","permissions":{"subscribe":true,"publish":false,"publishAudio":false,"publishVideo":false,"publishData":false}}""")
        assertTrue(h.controller.permissions!!.updateOwnMetadata)
        h.server("""{"type":"participant.permissions_updated","permissions":{"subscribe":true,"publish":false,"publishAudio":false,"publishVideo":false,"publishData":false,"updateOwnMetadata":false}}""")
        assertFalse(h.controller.permissions!!.updateOwnMetadata)
    }

    @Test
    fun metadataLimitsAreChecked() = runTest {
        val h = Harness(this)
        h.join()
        h.controller.permissions = ParticipantPermissions(updateOwnMetadata = true)
        fun code(block: () -> Unit) = (runCatching(block).exceptionOrNull() as io.swalvo.rtc.RtcException).code
        val invalid = io.swalvo.rtc.RtcErrorCode.INVALID_ARGUMENT
        assertEquals(invalid, code { h.controller.updateLocalMetadata("x".repeat(4097), null) })
        assertEquals(invalid, code { h.controller.updateLocalMetadata(null, (0..32).associate { "k$it" to "v" }) })
        assertEquals(invalid, code { h.controller.updateLocalMetadata(null, mapOf("k".repeat(65) to "v")) })
        assertEquals(invalid, code { h.controller.updateLocalMetadata(null, mapOf("" to "v")) })
        assertEquals(invalid, code { h.controller.updateLocalMetadata(null, mapOf("k" to "v".repeat(1025))) })
        // At the limits: fine.
        h.controller.updateLocalMetadata("x".repeat(4096), null)
        h.controller.updateLocalMetadata(null, (0 until 32).associate { "k".repeat(62) + "%02d".format(it) to "v".repeat(1024) })
        assertEquals(2, h.sent.filterIsInstance<ClientMessage.ParticipantUpdate>().size)
    }

    @Test
    fun screenShareAudioSourceIsUnderstood() {
        assertEquals(TrackKind.SCREEN_SHARE_AUDIO, TrackKind.fromWire("screenShareAudio", "audio"))
        assertEquals("screenShareAudio", TrackKind.SCREEN_SHARE_AUDIO.wire)
        assertEquals(io.swalvo.rtc.MediaKind.AUDIO, TrackKind.SCREEN_SHARE_AUDIO.mediaKind)
    }

    // --- phase6: transcription and AI agents ---------------------------------------

    @Test
    fun transcriptionSegmentsAreDeliveredIncludingAnEmptyFinal() = runTest {
        val h = Harness(this)
        h.join()
        h.server("""{"type":"transcription.segment","transcriptionId":"trx_1","participantId":"alice","segmentId":"seg_1","text":"hello every","final":false,"language":"en","startMs":120340,"endMs":121010}""")
        h.server("""{"type":"transcription.segment","transcriptionId":"trx_1","participantId":"alice","segmentId":"seg_1","text":"","final":true,"language":"en","startMs":120340,"endMs":121010}""")
        h.server("""{"type":"transcription.segment","transcriptionId":null,"agentId":"agt_1","participantId":"agent-agt_1","segmentId":"seg_2","text":"Hi!","final":true,"language":"en","startMs":0,"endMs":500}""")
        val segments = h.eventsOf<RoomEvent.TranscriptionSegment>().map { it.segment }
        assertEquals(3, segments.size)
        assertEquals("hello every", segments[0].text)
        assertFalse(segments[0].isFinal)
        assertEquals("trx_1", segments[0].transcriptionId)
        assertEquals(120340L, segments[0].startMs)
        assertTrue(segments[1].isFinal)
        assertEquals("", segments[1].text)
        assertEquals(null, segments[2].transcriptionId)
        assertEquals("agt_1", segments[2].agentId)
        assertEquals("agent-agt_1", segments[2].participantId)
    }

    @Test
    fun malformedTranscriptionFramesAreIgnored() = runTest {
        val h = Harness(this)
        h.join()
        h.server("""{"type":"transcription.segment","participantId":"alice","final":true}""")
        h.server("""{"type":"transcription.state","transcriptionId":"trx_1","status":"PAUSED","language":"en"}""")
        h.server("""{"type":"agent.state","agentId":"agt_1","participantId":"agent-agt_1","state":"dancing"}""")
        assertTrue(h.eventsOf<RoomEvent.TranscriptionSegment>().isEmpty())
        assertTrue(h.eventsOf<RoomEvent.TranscriptionStateChanged>().isEmpty())
        assertTrue(h.eventsOf<RoomEvent.AgentStateChanged>().isEmpty())
    }

    @Test
    fun transcriptionStateBecomesAnEvent() = runTest {
        val h = Harness(this)
        h.join()
        h.server("""{"type":"transcription.state","transcriptionId":"trx_1","status":"ACTIVE","language":"en"}""")
        val state = h.eventsOf<RoomEvent.TranscriptionStateChanged>().single().state
        assertEquals(io.swalvo.rtc.TranscriptionState("trx_1", io.swalvo.rtc.TranscriptionStatus.ACTIVE, "en"), state)
    }

    @Test
    fun agentStateResolvesTheParticipantAndIsStored() = runTest {
        val h = Harness(this)
        h.join(listOf(WireParticipant("agent-agt_1"), WireParticipant("transcriber-trx_1"), WireParticipant("bob")))
        val agent = h.controller.remoteParticipants.getValue("agent-agt_1")
        assertTrue(agent.isAgent)
        assertFalse(agent.isTranscriber)
        assertTrue(h.controller.remoteParticipants.getValue("transcriber-trx_1").isTranscriber)
        assertFalse(h.controller.remoteParticipants.getValue("bob").isAgent)
        assertEquals(null, agent.agentState)

        h.server("""{"type":"agent.state","agentId":"agt_1","participantId":"agent-agt_1","state":"thinking"}""")
        val event = h.eventsOf<RoomEvent.AgentStateChanged>().single()
        assertSame(agent, event.participant)
        assertEquals(io.swalvo.rtc.AgentState.THINKING, event.state)
        assertEquals(io.swalvo.rtc.AgentState.THINKING, agent.agentState)
        assertEquals(io.swalvo.rtc.AgentState.THINKING, agent.agentStateFlow.value)
    }

    @Test
    fun agentStateBeforeTheJoinIsHeldAndEndedForAStrangerIsDropped() = runTest {
        val h = Harness(this)
        h.join()
        h.server("""{"type":"agent.state","agentId":"agt_1","participantId":"agent-agt_1","state":"listening"}""")
        h.server("""{"type":"agent.state","agentId":"agt_9","participantId":"agent-agt_9","state":"ended"}""")
        assertTrue(h.eventsOf<RoomEvent.AgentStateChanged>().isEmpty())

        h.server("""{"type":"participant.joined","participant":{"id":"agent-agt_1","tracks":[]}}""")
        val joinedAt = h.events.indexOfFirst { it is RoomEvent.ParticipantJoined }
        val stateAt = h.events.indexOfFirst { it is RoomEvent.AgentStateChanged }
        assertTrue(joinedAt in 0 until stateAt)
        val event = h.eventsOf<RoomEvent.AgentStateChanged>().single()
        assertEquals("agent-agt_1", event.participant.identity)
        assertEquals(io.swalvo.rtc.AgentState.LISTENING, event.state)

        h.server("""{"type":"participant.joined","participant":{"id":"agent-agt_9","tracks":[]}}""")
        assertEquals(1, h.eventsOf<RoomEvent.AgentStateChanged>().size)
    }
}

private fun kotlinx.coroutines.CoroutineScope.launchCollect(
    participant: io.swalvo.rtc.Participant,
    block: (ParticipantEvent) -> Unit,
) = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { participant.events.collect { block(it) } }
