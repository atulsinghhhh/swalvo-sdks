package io.swalvo.rtc.internal.engine

import io.swalvo.rtc.LocalMediaHandle
import io.swalvo.rtc.LocalTrack
import io.swalvo.rtc.Logger
import io.swalvo.rtc.RemoteMediaHandle
import io.swalvo.rtc.RtcErrorCode
import io.swalvo.rtc.RtcException
import io.swalvo.rtc.TrackKind
import io.swalvo.rtc.e2ee.E2eeManager
import io.swalvo.rtc.internal.protocol.ClientMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.FrameCryptor
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The single PeerConnection to the SFU (signaling.md: "a client now has
 * exactly one peer").
 *
 * - The SFU offers first, on join and whenever the room's track set changes;
 *   we answer. ICE-restart offers (phase1 §2.6) are answered the same way.
 * - Publishing adds a send-only transceiver, declares the source with
 *   `track.publish` *before* negotiating, and offers.
 * - Glare resolves politely: the SFU's offer wins, ours is rolled back and
 *   re-offered after its round. A `NEGOTIATION_GLARE` refusal lands in the
 *   same path.
 * - Remote ICE candidates that arrive before a remote description are
 *   buffered and flushed after it is set.
 * - The DTLS role is never touched: libwebrtc answers the SFU's `actpass`
 *   with `active` and the SFU answers our offers `passive`, so the client is
 *   always the DTLS client, as the protocol requires.
 *
 * Every negotiation step runs on one FIFO queue so `signalingState` cannot
 * change between a check and the description it guards.
 */
internal class PeerConnectionEngine(
    private val factory: PeerConnectionFactory,
    private val iceServers: List<PeerConnection.IceServer>,
    private val scope: CoroutineScope,
    private val logger: Logger,
    private val send: (ClientMessage) -> Boolean,
    private val listener: MediaEngine.Listener,
    private val localIdentity: () -> String,
    /** The E2EE manager, when this room's media must be encrypted right now. */
    private val e2eeProvider: () -> E2eeManager?,
    private val preferredVideoCodec: String?,
) : MediaEngine {

    companion object {
        // legacy: kept for wire compatibility (the SFU matches these labels).
        const val DATA_CHANNEL_LABEL = "raven-data"
        /** phase7 §1.1: unordered, no retransmits. */
        const val LOSSY_DATA_CHANNEL_LABEL = "raven-data-lossy"
        /** phase7 §1.1/§1.3: the channel protocol that tells the SFU this client reads `0x52 0x03` framing. */
        const val DATA_CHANNEL_PROTOCOL = "raven.v2"

        /** Both channels carry [DATA_CHANNEL_PROTOCOL], even against an older server (it ignores it). */
        fun dataChannelInit(lossy: Boolean): DataChannel.Init = DataChannel.Init().apply {
            ordered = !lossy
            if (lossy) maxRetransmits = 0
            protocol = DATA_CHANNEL_PROTOCOL
        }
        const val MAX_DATA_PAYLOAD_BYTES = 64 * 1024
    }

    private class Publication(
        val kind: TrackKind,
        val track: LocalTrack,
        var transceiver: RtpTransceiver? = null,
        var cryptor: FrameCryptor? = null,
        var layers: List<Pair<String, Boolean>>? = null,
    )

    internal class WebRtcRemoteHandle(val receiver: RtpReceiver, val transceiver: RtpTransceiver) : RemoteMediaHandle {
        var cryptor: FrameCryptor? = null
        override val track: MediaStreamTrack? get() = runCatching { receiver.track() }.getOrNull()
    }

    private var pc: PeerConnection? = null
    private val publications = LinkedHashMap<TrackKind, Publication>()
    private val remoteHandles = mutableListOf<WebRtcRemoteHandle>()
    private val bufferedCandidates = mutableListOf<IceCandidate>()
    private var negotiationNeeded = false
    private var negotiationScheduled = false
    private var closed = false
    /** One data channel and what waits for it to open. */
    private class DataLane(val label: String, val ordered: Boolean) {
        var channel: DataChannel? = null
        val queue = ArrayDeque<ByteArray>()
        var opened: CompletableDeferred<Unit>? = null
    }

    private val reliableLane = DataLane(DATA_CHANNEL_LABEL, ordered = true)
    private val lossyLane = DataLane(LOSSY_DATA_CHANNEL_LABEL, ordered = false)

    private val ops = Channel<suspend () -> Unit>(Channel.UNLIMITED)

    override var peerState: PeerState = PeerState.NEW
        private set

    override val hasPeerConnection: Boolean get() = pc != null

    override val publishedTracks: List<LocalTrack> get() = publications.values.map { it.track }

    init {
        scope.launch {
            for (op in ops) {
                try {
                    op()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    logger.e("negotiation step failed", e)
                }
            }
        }
    }

    private fun enqueue(op: suspend () -> Unit) {
        ops.trySend(op)
    }

    // --- PeerConnection lifecycle -------------------------------------------------

    private fun ensurePeerConnection(): PeerConnection {
        pc?.let { return it }
        check(!closed) { "engine closed" }
        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.ENABLED
            keyType = PeerConnection.KeyType.ECDSA
        }
        var created: PeerConnection? = null
        val observer = Observer { created }
        created = factory.createPeerConnection(config, observer)
            ?: throw RtcException(RtcErrorCode.MEDIA_ERROR, "Could not create a PeerConnection")
        pc = created
        peerState = PeerState.NEW
        return created
    }

    /** Callbacks arrive on libwebrtc's signaling thread; every one hops onto the room scope and ignores a stale connection. */
    private inner class Observer(private val self: () -> PeerConnection?) : PeerConnection.Observer {
        private fun onScope(block: (PeerConnection) -> Unit) {
            scope.launch {
                val connection = self() ?: return@launch
                if (connection === pc) block(connection)
            }
        }

        override fun onIceCandidate(candidate: IceCandidate) = onScope {
            send(ClientMessage.IceCandidate(candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex))
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) = onScope {
            peerState = when (newState) {
                PeerConnection.PeerConnectionState.NEW -> PeerState.NEW
                PeerConnection.PeerConnectionState.CONNECTING -> PeerState.CONNECTING
                PeerConnection.PeerConnectionState.CONNECTED -> PeerState.CONNECTED
                PeerConnection.PeerConnectionState.DISCONNECTED -> PeerState.DISCONNECTED
                PeerConnection.PeerConnectionState.FAILED -> PeerState.FAILED
                PeerConnection.PeerConnectionState.CLOSED -> PeerState.CLOSED
            }
            logger.d("peer connection state $peerState")
            listener.onPeerState(peerState)
        }

        override fun onRenegotiationNeeded() = onScope {
            negotiationNeeded = true
            scheduleNegotiation()
        }

        override fun onTrack(transceiver: RtpTransceiver) = onScope { connection ->
            val receiver = transceiver.receiver
            val handle = WebRtcRemoteHandle(receiver, transceiver)
            remoteHandles.add(handle)
            // The SFU stamps the *publisher's* track id into the msid; the local track id is meaningless.
            val mid = transceiver.mid
            val sdp = connection.remoteDescription?.description
            val trackId = if (mid != null && sdp != null) SdpUtils.msidTrackIdForMid(sdp, mid) else null
            listener.onRemoteMedia(trackId ?: runCatching { receiver.track()?.id() }.getOrNull(), handle)
        }

        override fun onDataChannel(channel: DataChannel) = onScope {
            when (channel.label()) {
                DATA_CHANNEL_LABEL -> attachDataChannel(reliableLane, channel)
                LOSSY_DATA_CHANNEL_LABEL -> attachDataChannel(lossyLane, channel)
            }
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
    }

    override fun discardConnection() {
        val connection = pc ?: return
        pc = null
        peerState = PeerState.CLOSED
        bufferedCandidates.clear()
        negotiationNeeded = false
        negotiationScheduled = false
        reliableLane.channel = null
        lossyLane.channel = null
        for (handle in remoteHandles) handle.cryptor?.let { e2eeProvider()?.release(it) }
        remoteHandles.clear()
        for (publication in publications.values) {
            publication.cryptor?.let { e2eeProvider()?.release(it) }
            publication.cryptor = null
            publication.transceiver = null
        }
        runCatching { connection.close() }
        runCatching { connection.dispose() }
    }

    override fun close() {
        if (closed) return
        discardConnection()
        closed = true
        for (publication in publications.values) publication.track.handle.dispose()
        publications.clear()
        for (lane in listOf(reliableLane, lossyLane)) {
            lane.opened?.completeExceptionally(RtcException(RtcErrorCode.CONNECTION_FAILED, "The room closed"))
        }
        ops.close()
    }

    // --- Negotiation ----------------------------------------------------------------

    private fun scheduleNegotiation() {
        if (negotiationScheduled) return
        negotiationScheduled = true
        enqueue {
            negotiationScheduled = false
            runNegotiation()
        }
    }

    /** A publication whose transceiver has never been negotiated needs an offer of ours. */
    private fun unnegotiatedPublications(): Boolean = publications.values.any { it.transceiver != null && it.transceiver?.mid == null }

    private suspend fun runNegotiation() {
        val connection = pc ?: return
        if (!negotiationNeeded && !unnegotiatedPublications()) return
        if (connection.signalingState() != PeerConnection.SignalingState.STABLE) {
            logger.d("negotiation deferred until the current round ends")
            return
        }
        negotiationNeeded = false
        try {
            val offer = connection.awaitCreate(offer = true)
            connection.awaitSetLocal(offer)
            reconcilePublicationIds(connection)
            send(ClientMessage.SdpOffer(connection.localDescription?.description ?: offer.description))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            negotiationNeeded = true
            logger.e("could not offer", e)
            listener.onMediaError(RtcException(RtcErrorCode.MEDIA_ERROR, "Could not negotiate the published track", e))
        }
    }

    override fun applyOffer(sdp: String) = enqueue {
        val connection = ensurePeerConnection()
        try {
            if (connection.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER) {
                logger.d("glare: rolling our offer back and answering the sfu")
                runCatching { connection.awaitSetLocal(SessionDescription(SessionDescription.Type.ROLLBACK, "")) }
                negotiationNeeded = true
            }
            connection.awaitSetRemote(SessionDescription(SessionDescription.Type.OFFER, sdp))
            flushCandidates(connection)
            val answer = connection.awaitCreate(offer = false)
            connection.awaitSetLocal(answer)
            reconcilePublicationIds(connection)
            send(ClientMessage.SdpAnswer(connection.localDescription?.description ?: answer.description))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.e("failed to answer offer", e)
            listener.onMediaError(RtcException(RtcErrorCode.MEDIA_ERROR, "Could not answer the server's offer: ${e.message}", e))
            return@enqueue
        }
        afterRoundTrip()
    }

    override fun applyAnswer(sdp: String) = enqueue {
        val connection = pc ?: return@enqueue
        if (connection.signalingState() != PeerConnection.SignalingState.HAVE_LOCAL_OFFER) {
            logger.d("discarding an answer for a superseded offer")
            afterRoundTrip()
            return@enqueue
        }
        try {
            connection.awaitSetRemote(SessionDescription(SessionDescription.Type.ANSWER, sdp))
            flushCandidates(connection)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.e("failed to apply answer", e)
        }
        afterRoundTrip()
    }

    override fun addRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?) = enqueue {
        val connection = pc
        val ice = IceCandidate(sdpMid ?: "", sdpMLineIndex ?: 0, candidate)
        if (connection == null || connection.remoteDescription == null) {
            bufferedCandidates.add(ice)
            return@enqueue
        }
        if (!connection.addIceCandidate(ice)) logger.d("ignoring ICE candidate")
    }

    private fun flushCandidates(connection: PeerConnection) {
        if (bufferedCandidates.isEmpty()) return
        val pending = bufferedCandidates.toList()
        bufferedCandidates.clear()
        for (candidate in pending) connection.addIceCandidate(candidate)
    }

    private fun afterRoundTrip() {
        for (publication in publications.values) applyLayerActivity(publication)
        if (negotiationNeeded || unnegotiatedPublications()) scheduleNegotiation()
    }

    /**
     * The SFU keys a publication on the `msid` track id in *our* SDP. If
     * libwebrtc reused a transceiver whose m-section kept another id, re-declare
     * under the id actually on the wire, before the description goes out.
     */
    private fun reconcilePublicationIds(connection: PeerConnection) {
        val sdp = connection.localDescription?.description ?: return
        for (publication in publications.values) {
            val mid = publication.transceiver?.mid ?: continue
            val onWire = SdpUtils.msidTrackIdForMid(sdp, mid) ?: continue
            if (onWire == publication.track.trackId) continue
            logger.i("re-declaring ${publication.kind} as $onWire (was ${publication.track.trackId})")
            publication.track.trackId = onWire
            send(ClientMessage.TrackPublish(onWire, publication.kind.wire))
        }
    }

    // --- Publishing ------------------------------------------------------------------

    /** Must be called on the room scope. */
    fun publish(kind: TrackKind, handle: LocalMediaHandle, trackId: String, muteSink: suspend (LocalTrack, Boolean) -> Unit): LocalTrack {
        check(!closed) { "engine closed" }
        val track = LocalTrack(kind, trackId, handle, muteSink)
        val publication = Publication(kind, track)
        publications[kind] = publication
        attach(publication)
        listener.onLocalTrackPublished(track)
        return track
    }

    fun publicationFor(kind: TrackKind): LocalTrack? = publications[kind]?.track

    private fun attach(publication: Publication) {
        val connection = ensurePeerConnection()
        val mediaTrack = publication.track.handle.track ?: return
        val streamIds = listOf("${localIdentity()}-${UUID.randomUUID()}")
        val encodings = if (publication.kind == TrackKind.CAMERA) {
            Simulcast.LAYERS.map { layer ->
                RtpParameters.Encoding(layer.rid, true, layer.scaleResolutionDownBy).apply {
                    maxBitrateBps = layer.maxBitrateBps
                    maxFramerate = layer.maxFramerate
                }
            }
        } else {
            emptyList()
        }
        val init = RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, streamIds, encodings)
        val transceiver = connection.addTransceiver(mediaTrack, init)
            ?: throw RtcException(RtcErrorCode.MEDIA_ERROR, "Could not add a transceiver for ${publication.kind}")
        if (publication.track.kind.mediaKind == io.swalvo.rtc.MediaKind.VIDEO) applyCodecPreference(transceiver)
        publication.transceiver = transceiver
        publication.layers = null
        // Declared before negotiating, so the source is known by the time media arrives.
        send(ClientMessage.TrackPublish(publication.track.trackId, publication.kind.wire))
        e2eeProvider()?.let { publication.cryptor = it.attachSender(transceiver.sender, localIdentity()) }
        scheduleNegotiation()
    }

    private fun applyCodecPreference(transceiver: RtpTransceiver) {
        val preferred = preferredVideoCodec?.lowercase() ?: return
        val caps = runCatching { factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO) }.getOrNull() ?: return
        val mime = "video/$preferred"
        val (first, rest) = caps.codecs.partition { it.mimeType.equals(mime, ignoreCase = true) }
        if (first.isEmpty()) {
            logger.w("this device cannot send $preferred; publishing with the default codec order")
            return
        }
        runCatching { transceiver.setCodecPreferences(first + rest) }
    }

    override fun restorePublications() {
        for (publication in publications.values) {
            if (publication.transceiver != null) continue
            attach(publication)
        }
    }

    override suspend fun unpublish(track: LocalTrack) {
        val entry = publications.entries.firstOrNull { it.value.track === track } ?: return
        publications.remove(entry.key)
        val publication = entry.value
        publication.cryptor?.let { e2eeProvider()?.release(it) }
        publication.transceiver?.let { transceiver ->
            pc?.let { connection ->
                runCatching { connection.removeTrack(transceiver.sender) }
            }
        }
        track.handle.dispose()
        listener.onLocalTrackUnpublished(track)
    }

    // --- Dynacast ----------------------------------------------------------------------

    override fun applyPublisherLayers(trackId: String, layers: List<Pair<String, Boolean>>) {
        val publication = publications.values.firstOrNull { it.track.trackId == trackId } ?: run {
            logger.d("publisher.layers for a track we do not publish: $trackId")
            return
        }
        publication.layers = layers
        applyLayerActivity(publication)
    }

    private fun applyLayerActivity(publication: Publication) {
        val layers = publication.layers ?: return
        val sender = publication.transceiver?.sender ?: return
        try {
            val parameters = sender.parameters
            val activity = Simulcast.activityFor(parameters.encodings.map { it.rid }, layers)
            var changed = false
            for ((index, active) in activity) {
                val encoding = parameters.encodings[index]
                if (encoding.active != active) {
                    encoding.active = active
                    changed = true
                }
            }
            if (changed && !sender.setParameters(parameters)) logger.w("setParameters refused the layer change")
        } catch (e: Exception) {
            logger.d("could not apply publisher.layers: ${e.message}")
        }
    }

    // --- Remote tracks --------------------------------------------------------------------

    override fun onSubscribed(handle: RemoteMediaHandle, participantId: String) {
        val webrtc = handle as? WebRtcRemoteHandle ?: return
        val manager = e2eeProvider() ?: return
        if (webrtc.cryptor == null) webrtc.cryptor = manager.attachReceiver(webrtc.receiver, participantId)
    }

    // --- Data ---------------------------------------------------------------------------------

    /**
     * Sends bytes that are already framed (legacy payload or phase7
     * envelope) on the reliable channel, or on `raven-data-lossy` when
     * [lossy]. Each channel is created on first use and the send waits for
     * it to open.
     */
    suspend fun sendData(payload: ByteArray, lossy: Boolean = false) {
        val lane = if (lossy) lossyLane else reliableLane
        val channel = lane.channel ?: openDataChannel(lane)
        if (channel.state() == DataChannel.State.OPEN) {
            sendOn(channel, payload)
            return
        }
        lane.queue.addLast(payload)
        val waiter = lane.opened ?: CompletableDeferred<Unit>().also { lane.opened = it }
        waiter.await()
    }

    override fun openDataChannels() {
        if (closed) return
        for (lane in listOf(reliableLane, lossyLane)) {
            if (lane.channel != null) continue
            try {
                openDataChannel(lane)
            } catch (e: RtcException) {
                logger.w("could not open ${lane.label}: ${e.message}")
            }
        }
    }

    private fun openDataChannel(lane: DataLane): DataChannel {
        val connection = ensurePeerConnection()
        val channel = connection.createDataChannel(lane.label, dataChannelInit(lossy = !lane.ordered))
            ?: throw RtcException(RtcErrorCode.CONNECTION_FAILED, "Could not open the ${lane.label} data channel")
        attachDataChannel(lane, channel)
        return channel
    }

    private fun attachDataChannel(lane: DataLane, channel: DataChannel) {
        lane.channel = channel
        channel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {
                scope.launch {
                    if (channel.state() == DataChannel.State.OPEN) flushData(lane, channel)
                    if (channel.state() == DataChannel.State.CLOSED && lane.channel === channel) lane.channel = null
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                scope.launch { listener.onDataReceived(bytes) }
            }
        })
        if (channel.state() == DataChannel.State.OPEN) flushData(lane, channel)
    }

    private fun flushData(lane: DataLane, channel: DataChannel) {
        while (lane.queue.isNotEmpty()) sendOn(channel, lane.queue.removeFirst())
        lane.opened?.complete(Unit)
        lane.opened = null
    }

    private fun sendOn(channel: DataChannel, payload: ByteArray) {
        if (!channel.send(DataChannel.Buffer(ByteBuffer.wrap(payload), true))) {
            throw RtcException(RtcErrorCode.PERMISSION_DENIED, "Could not send data; check the token grants publishData")
        }
    }

    // --- libwebrtc callback → coroutine bridges ------------------------------------------------

    private suspend fun PeerConnection.awaitCreate(offer: Boolean): SessionDescription = suspendCancellableCoroutine { cont ->
        val observer = object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) = cont.resume(description)
            override fun onCreateFailure(error: String?) = cont.resumeWithException(RtcException(RtcErrorCode.MEDIA_ERROR, error ?: "create failed"))
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String?) {}
        }
        if (offer) createOffer(observer, MediaConstraints()) else createAnswer(observer, MediaConstraints())
    }

    private suspend fun PeerConnection.awaitSetLocal(description: SessionDescription): Unit = suspendCancellableCoroutine { cont ->
        setLocalDescription(setObserver(cont), description)
    }

    private suspend fun PeerConnection.awaitSetRemote(description: SessionDescription): Unit = suspendCancellableCoroutine { cont ->
        setRemoteDescription(setObserver(cont), description)
    }

    private fun setObserver(cont: kotlinx.coroutines.CancellableContinuation<Unit>) = object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription?) {}
        override fun onCreateFailure(error: String?) {}
        override fun onSetSuccess() = cont.resume(Unit)
        override fun onSetFailure(error: String?) = cont.resumeWithException(RtcException(RtcErrorCode.MEDIA_ERROR, error ?: "set description failed"))
    }
}
