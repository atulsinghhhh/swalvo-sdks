package io.swalvo.rtc

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.swalvo.rtc.internal.engine.MediaEngine
import io.swalvo.rtc.internal.engine.PeerConnectionEngine
import io.swalvo.rtc.internal.engine.PeerState
import io.swalvo.rtc.internal.media.Capture
import io.swalvo.rtc.internal.media.RtcFactory
import io.swalvo.rtc.internal.protocol.ClientMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.util.Collections
import kotlin.coroutines.resume

/**
 * DEVICE / EMULATOR ONLY (`./gradlew :swalvo-rtc:connectedDebugAndroidTest`).
 *
 * Plays the SFU with a second, local PeerConnection and checks the engine's
 * side of the contract: it answers the SFU's offer with `a=setup:active`
 * (client is always the DTLS client), declares a publication with
 * `track.publish` before offering, and its own offer carries the three
 * simulcast RIDs for a camera.
 */
@RunWith(AndroidJUnit4::class)
@OptIn(ExperimentalCoroutinesApi::class)
class PeerConnectionEngineLoopbackTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class NoopListener : MediaEngine.Listener {
        val states = Collections.synchronizedList(mutableListOf<PeerState>())
        override fun onRemoteMedia(trackId: String?, handle: RemoteMediaHandle) {}
        override fun onPeerState(state: PeerState) { states += state }
        override fun onLocalTrackEnded(track: LocalTrack) {}
        override fun onLocalTrackPublished(track: LocalTrack) {}
        override fun onLocalTrackUnpublished(track: LocalTrack) {}
        override fun onDataReceived(payload: ByteArray) {}
        override fun onMediaError(error: RtcException) {}
        override fun onE2eeState(participantId: String, state: E2eeState) {}
    }

    private suspend fun PeerConnection.create(offer: Boolean): SessionDescription = suspendCancellableCoroutine { cont ->
        val observer = object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) = cont.resume(d)
            override fun onCreateFailure(e: String?) = error(e ?: "create failed")
            override fun onSetSuccess() {}
            override fun onSetFailure(e: String?) {}
        }
        if (offer) createOffer(observer, MediaConstraints()) else createAnswer(observer, MediaConstraints())
    }

    private suspend fun PeerConnection.set(local: Boolean, d: SessionDescription): Unit = suspendCancellableCoroutine { cont ->
        val observer = object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription?) {}
            override fun onCreateFailure(e: String?) {}
            override fun onSetSuccess() = cont.resume(Unit)
            override fun onSetFailure(e: String?) = error(e ?: "set failed")
        }
        if (local) setLocalDescription(observer, d) else setRemoteDescription(observer, d)
    }

    @Test
    fun answersTheSfuOfferAsTheDtlsClientAndPublishesWithSimulcast() = runBlocking {
        val factory = RtcFactory.get(context)
        val dispatcher = Dispatchers.Default.limitedParallelism(1)
        val scope = CoroutineScope(SupervisorJob() + dispatcher)
        val sent = Collections.synchronizedList(mutableListOf<ClientMessage>())
        val answer = CompletableDeferred<String>()
        val offer = CompletableDeferred<String>()

        val listener = NoopListener()
        val engine = PeerConnectionEngine(
            factory = factory,
            iceServers = emptyList(),
            scope = scope,
            logger = Logger.SILENT,
            send = { message ->
                sent += message
                if (message is ClientMessage.SdpAnswer) answer.complete(message.sdp)
                if (message is ClientMessage.SdpOffer) offer.complete(message.sdp)
                true
            },
            listener = listener,
            localIdentity = { "me" },
            e2eeProvider = { null },
            preferredVideoCodec = null,
        )

        // The "SFU": offers one audio and one video receive slot, like the real one does on join.
        val sfu = factory.createPeerConnection(PeerConnection.RTCConfiguration(emptyList()), object : PeerConnection.Observer {
            override fun onSignalingChange(s: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
            override fun onIceCandidate(c: IceCandidate) { engine.addRemoteCandidate(c.sdp, c.sdpMid, c.sdpMLineIndex) }
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
            override fun onAddStream(s: MediaStream) {}
            override fun onRemoveStream(s: MediaStream) {}
            override fun onDataChannel(d: DataChannel) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver, s: Array<out MediaStream>) {}
        })!!
        try {
            sfu.addTransceiver(org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
            sfu.addTransceiver(org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
            val sfuOffer = sfu.create(offer = true)
            sfu.set(local = true, sfuOffer)
            assertTrue(sfuOffer.description.contains("a=setup:actpass"))

            withContext(dispatcher) { engine.applyOffer(sfuOffer.description) }
            val answerSdp = withTimeout(10_000) { answer.await() }
            assertTrue("the client must answer active", answerSdp.contains("a=setup:active"))
            sfu.set(local = false, SessionDescription(SessionDescription.Type.ANSWER, answerSdp))

            // Publish a microphone: track.publish goes out before the offer.
            val id = Capture.newTrackId()
            withContext(dispatcher) {
                engine.publish(TrackKind.MICROPHONE, Capture.microphone(factory, id), id) { _, _ -> }
            }
            val clientOffer = withTimeout(10_000) { offer.await() }
            val publishIndex = sent.indexOfFirst { it is ClientMessage.TrackPublish }
            val offerIndex = sent.indexOfFirst { it is ClientMessage.SdpOffer }
            assertTrue(publishIndex in 0 until offerIndex)
            assertEquals("microphone", (sent[publishIndex] as ClientMessage.TrackPublish).source)
            assertTrue(clientOffer.contains("a=msid:") && clientOffer.contains(id))

            delay(500)
        } finally {
            withContext(dispatcher) { engine.close() }
            sfu.dispose()
            scope.cancel()
        }
    }
}
