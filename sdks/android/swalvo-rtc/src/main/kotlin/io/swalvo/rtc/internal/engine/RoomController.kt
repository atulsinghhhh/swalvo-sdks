package io.swalvo.rtc.internal.engine

import io.swalvo.rtc.AgentState
import io.swalvo.rtc.ConnectionQuality
import io.swalvo.rtc.ConnectionState
import io.swalvo.rtc.DataChannelKind
import io.swalvo.rtc.DisconnectReason
import io.swalvo.rtc.E2eeState
import io.swalvo.rtc.ForwardedLayer
import io.swalvo.rtc.LocalParticipant
import io.swalvo.rtc.LocalTrack
import io.swalvo.rtc.Logger
import io.swalvo.rtc.MediaKind
import io.swalvo.rtc.Participant
import io.swalvo.rtc.ParticipantPermissions
import io.swalvo.rtc.RemoteMediaHandle
import io.swalvo.rtc.RemoteParticipant
import io.swalvo.rtc.RemoteTrack
import io.swalvo.rtc.RemoteTrackControl
import io.swalvo.rtc.RoomEvent
import io.swalvo.rtc.RtcErrorCode
import io.swalvo.rtc.RtcException
import io.swalvo.rtc.TrackKind
import io.swalvo.rtc.TrackSubscriptionState
import io.swalvo.rtc.TranscriptionSegment
import io.swalvo.rtc.TranscriptionState
import io.swalvo.rtc.TranscriptionStatus
import io.swalvo.rtc.internal.data.DataEnvelope
import io.swalvo.rtc.internal.protocol.ClientMessage
import io.swalvo.rtc.internal.protocol.ServerMessage
import io.swalvo.rtc.internal.protocol.SignalingErrorCodes
import io.swalvo.rtc.internal.protocol.WireTrack
import io.swalvo.rtc.internal.signaling.JoinedPayload
import io.swalvo.rtc.internal.signaling.SignalingEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * The room's control plane: turns signaling events into room state and
 * [RoomEvent]s, and drives a [MediaEngine]. Free of libwebrtc, so the whole
 * event mapping is exercised by JVM unit tests with a fake engine.
 *
 * Mirrors the message handling of packages/sdk/src/internal/sfu/swalvo-adapter.ts.
 * Runs entirely on [scope] (confined to one thread).
 */
internal class RoomController(
    val localParticipant: LocalParticipant,
    private val scope: CoroutineScope,
    private val logger: Logger,
    private val options: Options,
    private val send: (ClientMessage) -> Boolean,
    private val emit: (RoomEvent) -> Unit,
    private val requestRejoin: () -> Unit,
) : MediaEngine.Listener, RemoteTrackControl {

    data class Options(
        val autoSubscribe: Boolean = true,
        val adaptiveStream: Boolean = true,
        val autoReconnect: Boolean = true,
    )

    companion object {
        /** Media rebuilds (with signaling still up) before the room is reported failed. Reset on every `connected`. */
        const val MAX_MEDIA_REJOIN_ATTEMPTS = 3

        /** phase7 §1.6: the `room.joined.capabilities` entry for data messages v2. */
        const val CAPABILITY_DATA_V2 = "data.v2"

        // phase7 §2 limits.
        const val MAX_METADATA_BYTES = 4 * 1024
        const val MAX_ATTRIBUTE_KEYS = 32
        const val MAX_ATTRIBUTE_KEY_LENGTH = 64
        const val MAX_ATTRIBUTE_VALUE_BYTES = 1024
    }

    lateinit var engine: MediaEngine

    /** Mutated only on the room scope; synchronized so the app can snapshot it from any thread. */
    val remoteParticipants: MutableMap<String, RemoteParticipant> = java.util.Collections.synchronizedMap(LinkedHashMap())
    var connectionState: ConnectionState = ConnectionState.DISCONNECTED
        private set
    var permissions: ParticipantPermissions? = null
    var activeSpeakers: List<Participant> = emptyList()
        private set
    var disconnectReason: DisconnectReason? = null
        private set
    /** Token claim `e2ee` or `room.joined.e2ee` (phase5 §3.1); once true, stays true. */
    var roomRequiresE2ee: Boolean = false
    var rtcServer: String? = null
        private set
    var sfuIceState: String? = null
        private set
    /** `room.joined.capabilities` contained `data.v2` (phase7 §1.6). Refreshed on every join and resume. */
    var supportsDataV2: Boolean = false
        private set
    var sfuPeerState: String? = null
        private set

    private var signalingJoined = false
    private var awaitingResume = false
    private var everConnected = false
    private var inOutage = false
    private var intentionalDisconnect = false
    private var mediaRejoinAttempts = 0

    private val announced = LinkedHashMap<String, Pair<String, WireTrack>>()
    private val pendingMedia = HashMap<String, RemoteMediaHandle>()
    private val subscribed = LinkedHashMap<String, RemoteTrack>()
    private val parkedStates = HashMap<String, Pair<TrackSubscriptionState, ForwardedLayer?>>()
    private val sentLayers = HashMap<String, String>()
    private val hideJobs = HashMap<String, Job>()
    /** phase6 §4.2: an agent's state that arrived before its `participant.joined`; delivered once it joins. */
    private val pendingAgentStates = HashMap<String, AgentState>()

    private fun key(participantId: String, trackId: String) = "$participantId/$trackId"

    // --- Signaling events -------------------------------------------------------

    fun onSignalingEvent(event: SignalingEvent) {
        when (event) {
            is SignalingEvent.Joined -> onJoined(event.payload)
            is SignalingEvent.Message -> onMessage(event.message)
            is SignalingEvent.Reconnecting -> onReconnecting(event.resuming)
            is SignalingEvent.Failed -> {
                logger.e("signaling failed: ${event.error.message}")
                emit(RoomEvent.Error(event.error))
                finish(event.reason, ConnectionState.FAILED)
            }
            is SignalingEvent.Ended -> finish(event.reason, ConnectionState.DISCONNECTED)
            is SignalingEvent.Closed -> {
                if (disconnectReason == null) {
                    finish(
                        if (intentionalDisconnect) DisconnectReason.CLIENT_INITIATED else DisconnectReason.CONNECTION_FAILED,
                        if (intentionalDisconnect) ConnectionState.DISCONNECTED else ConnectionState.FAILED,
                    )
                }
            }
            is SignalingEvent.Warning -> emit(RoomEvent.Warning(event.warning))
        }
    }

    fun markConnecting() = setState(ConnectionState.CONNECTING)

    /** `room.leave()`: the Closed event that follows reports CLIENT_INITIATED. */
    fun markIntentionalDisconnect() {
        intentionalDisconnect = true
    }

    private fun finish(reason: DisconnectReason, state: ConnectionState) {
        if (disconnectReason != null) return
        disconnectReason = reason
        signalingJoined = false
        hideJobs.values.forEach { it.cancel() }
        hideJobs.clear()
        engine.close()
        setState(state)
        emit(RoomEvent.Disconnected(reason))
    }

    private fun onJoined(payload: JoinedPayload) {
        signalingJoined = true
        rtcServer = payload.rtcServer
        roomRequiresE2ee = roomRequiresE2ee || payload.e2ee
        supportsDataV2 = CAPABILITY_DATA_V2 in payload.capabilities
        val wasAwaitingResume = awaitingResume
        awaitingResume = false

        if (payload.resumed) {
            logger.i("session resumed; keeping the media connection")
            applyRoomState(payload, restorePublications = false)
            openDataChannelsIfV2()
            if (engine.peerState == PeerState.CONNECTED) markConnected()
            return
        }
        if (wasAwaitingResume) {
            logger.i("the server started a fresh session; rebuilding the media connection")
            discardMedia()
        }
        applyRoomState(payload, restorePublications = true)
        openDataChannelsIfV2()
    }

    /**
     * phase7 §1.1: a v2 server gets both channels at connect, so it frames deliveries to us. Older servers: unchanged, lazy.
     *
     * Only with publishData: opening a channel is an offer, which the API refuses (failing the connection) for a
     * participant that may neither publish nor publishData, e.g. a live-stream viewer; the SFU would close the
     * channel anyway. [applyPermissions] opens them if the grant arrives later.
     */
    private fun openDataChannelsIfV2() {
        if (supportsDataV2 && mayOpenDataChannels()) engine.openDataChannels()
    }

    /** Unknown permissions (no perms claim) keep the old behaviour. */
    private fun mayOpenDataChannels(): Boolean = permissions?.publishData != false

    private fun onReconnecting(resuming: Boolean) {
        signalingJoined = false
        if (!inOutage) {
            inOutage = true
            emit(RoomEvent.Reconnecting)
        }
        setState(ConnectionState.RECONNECTING)
        if (resuming && engine.hasPeerConnection) {
            // The server may re-bind our SFU session; this PeerConnection may never have stopped.
            awaitingResume = true
            return
        }
        awaitingResume = false
        discardMedia()
    }

    private fun discardMedia() {
        engine.discardConnection()
        for ((k, track) in subscribed.toList()) {
            val participant = remoteParticipants[track.participantId] ?: continue
            participant.trackList.remove(track)
            subscribed.remove(k)
            emit(RoomEvent.TrackUnsubscribed(track, participant))
        }
        pendingMedia.clear()
        sentLayers.clear()
        hideJobs.values.forEach { it.cancel() }
        hideJobs.clear()
    }

    /** Reconcile, don't append: leaves for anyone gone, joins for anyone new, everyone else untouched. */
    private fun applyRoomState(payload: JoinedPayload, restorePublications: Boolean) {
        val present = payload.participants.map { it.id }.toSet()
        for (participant in remoteParticipants.values.toList()) {
            if (participant.identity !in present) removeParticipant(participant)
        }
        if (restorePublications) engine.restorePublications()
        for (entry in payload.participants) {
            if (entry.id == localParticipant.identity) {
                applyWireMetadata(localParticipant, entry.metadata, entry.attributes, announce = true)
                continue
            }
            val existing = remoteParticipants[entry.id]
            if (existing == null) {
                val participant = RemoteParticipant(entry.id)
                applyWireMetadata(participant, entry.metadata, entry.attributes, announce = false)
                remoteParticipants[entry.id] = participant
                emit(RoomEvent.ParticipantJoined(participant))
                flushPendingAgentState(participant)
            } else {
                applyWireMetadata(existing, entry.metadata, entry.attributes, announce = true)
            }
            entry.tracks.orEmpty().forEach { announce(entry.id, it) }
        }
    }

    private fun onMessage(message: ServerMessage) {
        when (message) {
            is ServerMessage.RoomJoined -> {
                supportsDataV2 = CAPABILITY_DATA_V2 in message.capabilities.orEmpty()
                applyRoomState(
                    JoinedPayload(
                        message.roomId, message.participants, message.rtcServer, message.region, message.clientRegion, false,
                        message.e2ee == true, message.capabilities.orEmpty(),
                    ),
                    restorePublications = true,
                )
                openDataChannelsIfV2()
            }
            // Includes the SFU's ICE-restart offers (phase1 §2.6): answered like any other.
            is ServerMessage.SdpOffer -> engine.applyOffer(message.sdp)
            is ServerMessage.SdpAnswer -> engine.applyAnswer(message.sdp)
            is ServerMessage.IceCandidate -> engine.addRemoteCandidate(message.candidate, message.sdpMid, message.sdpMLineIndex)
            is ServerMessage.ParticipantJoined -> {
                val id = message.participant.id
                if (id == localParticipant.identity || remoteParticipants.containsKey(id)) return
                val participant = RemoteParticipant(id)
                applyWireMetadata(participant, message.participant.metadata, message.participant.attributes, announce = false)
                remoteParticipants[id] = participant
                emit(RoomEvent.ParticipantJoined(participant))
                flushPendingAgentState(participant)
                message.participant.tracks.orEmpty().forEach { announce(id, it) }
            }
            is ServerMessage.ParticipantUpdated -> onParticipantUpdated(message)
            is ServerMessage.DataThrottled -> {
                val channel = if (message.channel == DataChannelKind.LOSSY.wire) DataChannelKind.LOSSY else DataChannelKind.RELIABLE
                logger.w("the server is dropping this participant's ${channel.wire} data messages (rate limit)")
                emit(RoomEvent.DataThrottled(channel))
            }
            is ServerMessage.ParticipantLeft -> remoteParticipants[message.participant.id]?.let { removeParticipant(it) }
            is ServerMessage.PermissionsUpdated -> applyPermissions(
                ParticipantPermissions(
                    subscribe = message.permissions.subscribe,
                    publish = message.permissions.publish,
                    publishAudio = message.permissions.publishAudio,
                    publishVideo = message.permissions.publishVideo,
                    publishScreen = message.permissions.publishScreen,
                    publishData = message.permissions.publishData,
                    updateOwnMetadata = message.permissions.updateOwnMetadata ?: (permissions?.updateOwnMetadata == true),
                ),
            )
            is ServerMessage.TrackPublished -> announce(message.participantId, message.track)
            is ServerMessage.TrackUnpublished -> {
                val k = key(message.participantId, message.trackId)
                val announcement = announced.remove(k)
                pendingMedia.remove(message.trackId)
                parkedStates.remove(k)
                sentLayers.remove(k)
                hideJobs.remove(k)?.cancel()
                val participant = remoteParticipants[message.participantId] ?: return
                val track = subscribed.remove(k)
                if (track != null) {
                    participant.trackList.remove(track)
                    emit(RoomEvent.TrackUnpublished(track.kind, participant))
                    emit(RoomEvent.TrackUnsubscribed(track, participant))
                } else if (announcement != null) {
                    emit(RoomEvent.TrackUnpublished(TrackKind.fromWire(announcement.second.source, announcement.second.kind), participant))
                }
            }
            is ServerMessage.TrackMuted -> onMute(message.participantId, message.trackId, true, message.byServer == true)
            is ServerMessage.TrackUnmuted -> onMute(message.participantId, message.trackId, false, message.byServer == true)
            is ServerMessage.ConnectionState -> {
                sfuIceState = message.iceState
                sfuPeerState = message.peerState
            }
            is ServerMessage.SpeakersChanged -> applySpeakers(message)
            is ServerMessage.QualityChanged -> applyQuality(message)
            is ServerMessage.SubscriptionState -> applySubscriptionState(message)
            is ServerMessage.TranscriptionSegment -> emit(
                RoomEvent.TranscriptionSegment(
                    TranscriptionSegment(
                        transcriptionId = message.transcriptionId,
                        agentId = message.agentId,
                        participantId = message.participantId,
                        segmentId = message.segmentId,
                        // An empty final is relayed as is: it clears a withdrawn interim (phase6 §4.1).
                        text = message.text,
                        isFinal = message.isFinal,
                        language = message.language,
                        startMs = message.startMs,
                        endMs = message.endMs,
                    ),
                ),
            )
            is ServerMessage.TranscriptionState -> {
                val status = TranscriptionStatus.fromWire(message.status) ?: return
                emit(RoomEvent.TranscriptionStateChanged(TranscriptionState(message.transcriptionId, status, message.language)))
            }
            is ServerMessage.AgentState -> onAgentState(message.participantId, message.state)
            is ServerMessage.PublisherLayers -> engine.applyPublisherLayers(message.trackId, message.layers.map { it.rid to it.active })
            is ServerMessage.Error -> {
                if (message.code == SignalingErrorCodes.NEGOTIATION_GLARE) {
                    // Retryable: the SFU's own offer is on its way; answering it rolls ours back and
                    // the engine re-offers once the round ends.
                    logger.d("sfu refused our offer as glare; waiting for its offer")
                    return
                }
                emit(RoomEvent.Error(RtcException(RtcErrorCode.SIGNALING_ERROR, "${message.code}: ${message.message}")))
            }
            else -> Unit
        }
    }

    // --- AI agents (phase6 §4.2) -------------------------------------------------------

    private fun onAgentState(participantId: String, wire: String) {
        val state = AgentState.fromWire(wire) ?: return
        val participant = participantById(participantId)
        if (participant == null) {
            // Not in the roster yet: hold the latest state for its join. An `ended` for
            // someone we never saw has nobody to report it on.
            if (state == AgentState.ENDED) pendingAgentStates.remove(participantId) else pendingAgentStates[participantId] = state
            return
        }
        // A repeated frame is not a change (same as the JS, iOS and Flutter SDKs).
        if (participant.agentState == state) return
        participant.setAgentState(state)
        emit(RoomEvent.AgentStateChanged(participant, state))
    }

    private fun flushPendingAgentState(participant: Participant) {
        val state = pendingAgentStates.remove(participant.identity) ?: return
        participant.setAgentState(state)
        emit(RoomEvent.AgentStateChanged(participant, state))
    }

    // --- Participants and tracks ---------------------------------------------------

    private fun removeParticipant(participant: RemoteParticipant) {
        remoteParticipants.remove(participant.identity)
        for ((k, track) in subscribed.toList()) {
            if (track.participantId != participant.identity) continue
            subscribed.remove(k)
            sentLayers.remove(k)
            hideJobs.remove(k)?.cancel()
            emit(RoomEvent.TrackUnsubscribed(track, participant))
        }
        participant.trackList.clear()
        announced.keys.filter { it.startsWith("${participant.identity}/") }.forEach { announced.remove(it); parkedStates.remove(it) }
        if (activeSpeakers.contains(participant)) {
            activeSpeakers = activeSpeakers - participant
            emit(RoomEvent.ActiveSpeakersChanged(activeSpeakers))
        }
        emit(RoomEvent.ParticipantLeft(participant))
    }

    /** `track.published` and the arriving media race; whichever lands first is parked (signaling.md "Writing a client" #2). */
    private fun announce(participantId: String, track: WireTrack) {
        val k = key(participantId, track.trackId)
        val isNew = !announced.containsKey(k)
        announced[k] = participantId to track
        val participant = remoteParticipants[participantId] ?: return
        if (isNew) emit(RoomEvent.TrackPublished(TrackKind.fromWire(track.source, track.kind), participant))
        pendingMedia.remove(track.trackId)?.let { completeSubscription(participantId, track, it) }
    }

    override fun onRemoteMedia(trackId: String?, handle: RemoteMediaHandle) {
        val resolved = trackId
        val announcement = resolved?.let { id -> announced.values.firstOrNull { it.second.trackId == id } }
        if (announcement == null) {
            if (resolved != null) {
                logger.d("media arrived before its announcement: $resolved")
                pendingMedia[resolved] = handle
            } else {
                logger.w("a remote track arrived with no msid; it cannot be attributed")
            }
            return
        }
        completeSubscription(announcement.first, announcement.second, handle)
    }

    private fun completeSubscription(participantId: String, wire: WireTrack, handle: RemoteMediaHandle) {
        val participant = remoteParticipants[participantId] ?: return
        val k = key(participantId, wire.trackId)
        if (subscribed.containsKey(k)) return

        val mediaKind = if (wire.kind == "audio") MediaKind.AUDIO else MediaKind.VIDEO
        val track = RemoteTrack(wire.trackId, participantId, TrackKind.fromWire(wire.source, wire.kind), mediaKind, handle, this)
        track.mutedState.value = wire.muted

        val parked = parkedStates.remove(k)
        if (parked != null) {
            track.setSubscriptionState(parked.first, parked.second)
        } else if (mediaKind == MediaKind.VIDEO && !options.autoSubscribe) {
            // phase2 §4: the starting state is fixed by the join; show it without waiting.
            track.setSubscriptionState(TrackSubscriptionState.PAUSED_CLIENT, ForwardedLayer.OFF)
        }
        if (mediaKind == MediaKind.VIDEO) {
            sentLayers[k] = if (options.autoSubscribe) "auto" else "off"
            if (!options.autoSubscribe) track.initVisibility(false)
        }

        subscribed[k] = track
        participant.trackList.add(track)
        engine.onSubscribed(handle, participantId)
        emit(RoomEvent.TrackSubscribed(track, participant))
    }

    private fun onMute(participantId: String, trackId: String, muted: Boolean, byServer: Boolean) {
        if (participantId == localParticipant.identity) {
            // phase1 §1.6. A server *unmute* is not acted on: turning a microphone back on remotely
            // is not something an SDK should do behind its user's back.
            if (!muted || !byServer) return
            val track = engine.publishedTracks.firstOrNull { it.trackId == trackId }
            if (track == null) {
                logger.d("server muted a track we do not publish: $trackId")
                return
            }
            if (!track.isMuted) track.setMutedLocally(true)
            emit(RoomEvent.LocalTrackMutedByServer(track))
            return
        }
        val track = subscribed[key(participantId, trackId)]
        val participant = remoteParticipants[participantId]
        if (track == null || participant == null) {
            announced[key(participantId, trackId)]?.let { (pid, wire) -> announced[key(pid, trackId)] = pid to wire.copy(muted = muted) }
            return
        }
        track.mutedState.value = muted
        emit(if (muted) RoomEvent.TrackMuted(track.kind, participant) else RoomEvent.TrackUnmuted(track.kind, participant))
    }

    fun applyPermissions(next: ParticipantPermissions) {
        val hadDataGrant = mayOpenDataChannels()
        permissions = next
        // Granted mid-session: open what connect would have opened.
        if (!hadDataGrant && next.publishData) openDataChannelsIfV2()
        logger.i("permissions updated by the server: $next")
        for (track in engine.publishedTracks) {
            // Source-aware, not just audio/video: screen share gates on
            // publishScreen, independently of publishVideo (agora-parity
            // audit, phase 2).
            if (next.mayPublishKind(track.kind)) continue
            logger.i("publish right withdrawn; stopping the local ${track.kind} publication")
            // Not an error: the SFU already unpublished it (phase1 §1.4).
            scope.launch { engine.unpublish(track) }
        }
        emit(RoomEvent.PermissionsChanged(next))
    }

    // --- Phase 2 ---------------------------------------------------------------------

    private fun participantById(id: String): Participant? =
        if (id == localParticipant.identity) localParticipant else remoteParticipants[id]

    private fun applySpeakers(message: ServerMessage.SpeakersChanged) {
        val next = ArrayList<Participant>()
        val levels = HashMap<Participant, Float>()
        for (speaker in message.speakers.take(8)) {
            val participant = participantById(speaker.participantId) ?: continue
            if (participant in levels) continue
            next.add(participant)
            levels[participant] = speaker.level.coerceIn(0.0, 1.0).toFloat()
        }
        for (previous in activeSpeakers) if (previous !in levels) previous.setSpeaking(false, 0f)
        for ((participant, level) in levels) participant.setSpeaking(true, level)
        activeSpeakers = next
        emit(RoomEvent.ActiveSpeakersChanged(next.toList()))
    }

    private fun applyQuality(message: ServerMessage.QualityChanged) {
        for (update in message.updates) {
            val participant = participantById(update.participantId) ?: continue
            val quality = ConnectionQuality.fromWire(update.quality) ?: continue
            if (participant.setConnectionQuality(quality)) emit(RoomEvent.ConnectionQualityChanged(participant, quality))
        }
    }

    private fun applySubscriptionState(message: ServerMessage.SubscriptionState) {
        val state = TrackSubscriptionState.fromWire(message.state) ?: return
        val layer = ForwardedLayer.fromWire(message.layer) ?: if (state == TrackSubscriptionState.ACTIVE) null else ForwardedLayer.OFF
        val k = key(message.publisherId, message.trackId)
        val track = subscribed[k]
        val participant = remoteParticipants[message.publisherId]
        if (track == null || participant == null) {
            // Kept and applied when the track arrives (phase2 §4).
            parkedStates[k] = state to layer
            return
        }
        track.setSubscriptionState(state, layer)
        emit(RoomEvent.TrackSubscriptionStateChanged(track, participant))
    }

    // --- Layer control -------------------------------------------------------------

    override fun onLayerInputsChanged(track: RemoteTrack) {
        scope.launch { recomputeLayer(track, debounceHide = true) }
    }

    private fun recomputeLayer(track: RemoteTrack, debounceHide: Boolean) {
        if (track.mediaKind != MediaKind.VIDEO) return
        val k = key(track.participantId, track.trackId)
        if (subscribed[k] !== track) return
        val desired = LayerPolicy.effectiveLayer(track.isEnabled, track.pinnedLayer, options.adaptiveStream, track.visible)
        val hiddenOnly = desired == "off" && track.isEnabled && track.pinnedLayer == null
        if (hiddenOnly && debounceHide) {
            if (hideJobs[k]?.isActive == true) return
            hideJobs[k] = scope.launch {
                delay(LayerPolicy.HIDE_DEBOUNCE_MS)
                hideJobs.remove(k)
                recomputeLayer(track, debounceHide = false)
            }
            return
        }
        hideJobs.remove(k)?.cancel()
        if (sentLayers[k] == desired) return
        sentLayers[k] = desired
        send(ClientMessage.SubscriptionUpdate(track.participantId, track.trackId, desired))
    }

    // --- Media engine callbacks ---------------------------------------------------------

    override fun onPeerState(state: PeerState) {
        when (state) {
            PeerState.CONNECTED -> {
                mediaRejoinAttempts = 0
                if (signalingJoined) markConnected()
            }
            PeerState.FAILED -> {
                if (disconnectReason != null) return
                if (!options.autoReconnect) {
                    emit(RoomEvent.Error(RtcException(RtcErrorCode.CONNECTION_FAILED, "The media connection failed")))
                    finish(DisconnectReason.CONNECTION_FAILED, ConnectionState.FAILED)
                    return
                }
                if (mediaRejoinAttempts >= MAX_MEDIA_REJOIN_ATTEMPTS) {
                    emit(RoomEvent.Error(RtcException(RtcErrorCode.CONNECTION_FAILED, "The media connection could not be re-established")))
                    finish(DisconnectReason.CONNECTION_FAILED, ConnectionState.FAILED)
                    return
                }
                mediaRejoinAttempts++
                if (!inOutage) {
                    inOutage = true
                    emit(RoomEvent.Reconnecting)
                }
                setState(ConnectionState.RECONNECTING)
                // A fresh session: resuming would hand back the same dead PeerConnection.
                requestRejoin()
            }
            else -> Unit
        }
    }

    override fun onLocalTrackEnded(track: LocalTrack) {
        scope.launch { engine.unpublish(track) }
    }

    override fun onLocalTrackPublished(track: LocalTrack) {
        if (track !in localParticipant.trackList) localParticipant.trackList.add(track)
        emit(RoomEvent.LocalTrackPublished(track))
    }

    override fun onLocalTrackUnpublished(track: LocalTrack) {
        localParticipant.trackList.remove(track)
        emit(RoomEvent.LocalTrackUnpublished(track))
    }

    override fun onDataReceived(payload: ByteArray) {
        val decoded = DataEnvelope.decode(payload)
        // The sender comes from the SFU (phase7 §1.3), never from the sender itself. "" is the server.
        val sender = decoded.senderIdentity?.takeIf { it.isNotEmpty() }?.let { remoteParticipants[it] }
        emit(RoomEvent.DataReceived(decoded.payload, sender, decoded.topic?.takeIf { it.isNotEmpty() }))
    }

    // --- Participant metadata (phase7 §2) ------------------------------------------------

    private fun applyWireMetadata(participant: Participant, metadata: String?, attributes: Map<String, String>?, announce: Boolean) {
        val previous = participant.applyMetadata(metadata, clearMetadata = false, attributes = attributes) ?: return
        if (announce) emit(RoomEvent.ParticipantMetadataChanged(participant, previous.first, previous.second))
    }

    private fun onParticipantUpdated(message: ServerMessage.ParticipantUpdated) {
        val participant = participantById(message.participantId) ?: run {
            logger.d("participant.updated for someone not in the room: ${message.participantId}")
            return
        }
        val metadata = (message.metadata as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        val clear = message.metadata is JsonNull
        val attributes: Map<String, String>? = when (val raw: JsonElement? = message.attributes) {
            null -> null
            is JsonNull -> emptyMap()
            is JsonObject -> raw.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.let { k to it } }.toMap()
            else -> null
        }
        val previous = participant.applyMetadata(metadata, clear, attributes) ?: return
        emit(RoomEvent.ParticipantMetadataChanged(participant, previous.first, previous.second))
    }

    /**
     * `participant.update` for the local participant. Checks the token grant
     * and the limits before anything goes on the wire; the new values arrive
     * with the server's `participant.updated`, not optimistically.
     */
    fun updateLocalMetadata(metadata: String?, attributes: Map<String, String>?) {
        if (permissions?.updateOwnMetadata != true) {
            throw RtcException(
                RtcErrorCode.PERMISSION_DENIED,
                "This token may not update its own metadata; mint it with perms.updateOwnMetadata = true",
            )
        }
        validateMetadata(metadata, attributes)
        if (!send(ClientMessage.ParticipantUpdate(metadata, attributes))) {
            throw RtcException(RtcErrorCode.CONNECTION_FAILED, "The signaling connection is not open")
        }
    }

    private fun validateMetadata(metadata: String?, attributes: Map<String, String>?) {
        if (metadata != null) {
            val size = metadata.toByteArray(Charsets.UTF_8).size
            if (size > MAX_METADATA_BYTES) {
                throw RtcException(RtcErrorCode.INVALID_ARGUMENT, "Metadata is $size bytes of UTF-8, over the $MAX_METADATA_BYTES-byte limit")
            }
        }
        if (attributes != null) {
            if (attributes.size > MAX_ATTRIBUTE_KEYS) {
                throw RtcException(RtcErrorCode.INVALID_ARGUMENT, "At most $MAX_ATTRIBUTE_KEYS attributes, not ${attributes.size}")
            }
            for ((key, value) in attributes) {
                if (key.isEmpty() || key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
                    throw RtcException(RtcErrorCode.INVALID_ARGUMENT, "Attribute keys are 1 to $MAX_ATTRIBUTE_KEY_LENGTH characters: \"$key\"")
                }
                val size = value.toByteArray(Charsets.UTF_8).size
                if (size > MAX_ATTRIBUTE_VALUE_BYTES) {
                    throw RtcException(RtcErrorCode.INVALID_ARGUMENT, "Attribute \"$key\" is $size bytes, over the $MAX_ATTRIBUTE_VALUE_BYTES-byte limit")
                }
            }
        }
    }

    override fun onMediaError(error: RtcException) = emit(RoomEvent.Error(error))

    override fun onE2eeState(participantId: String, state: E2eeState) {
        val participant = participantById(participantId) ?: return
        emit(RoomEvent.E2eeStateChanged(participant, state))
    }

    private fun markConnected() {
        setState(ConnectionState.CONNECTED)
        if (!everConnected) {
            everConnected = true
            emit(RoomEvent.Connected)
        } else if (inOutage) {
            emit(RoomEvent.Reconnected)
        }
        inOutage = false
    }

    private fun setState(state: ConnectionState) {
        if (connectionState == state) return
        connectionState = state
        emit(RoomEvent.ConnectionStateChanged(state))
    }

    /** For tests and diagnostics. */
    internal fun sentLayerFor(participantId: String, trackId: String): String? = sentLayers[key(participantId, trackId)]
}
