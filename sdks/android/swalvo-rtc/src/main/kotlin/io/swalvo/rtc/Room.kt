package io.swalvo.rtc

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import io.swalvo.rtc.e2ee.E2eeManager
import io.swalvo.rtc.internal.TokenClaims
import io.swalvo.rtc.internal.data.DataEnvelope
import io.swalvo.rtc.internal.engine.PeerConnectionEngine
import io.swalvo.rtc.internal.engine.RoomController
import io.swalvo.rtc.internal.media.Capture
import io.swalvo.rtc.internal.media.RtcFactory
import io.swalvo.rtc.internal.media.ScreenAudioMixer
import io.swalvo.rtc.internal.media.VideoCaptureHandle
import io.swalvo.rtc.internal.protocol.ClientMessage
import io.swalvo.rtc.internal.signaling.OkHttpWebSocketTransport
import io.swalvo.rtc.internal.signaling.SignalingClient
import io.swalvo.rtc.internal.signaling.SignalingEvent
import io.swalvo.rtc.internal.signaling.WebSocketTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.webrtc.PeerConnection

/**
 * A joined room. Get one from [SwalvoClient.connect].
 *
 * Events arrive on [events] (a hot flow: collect it before or right after
 * `connect` returns; the state at that moment is on the properties).
 * Everything here is safe to call from any thread; suspend functions do
 * their work on the room's own confined dispatcher.
 */
public class Room internal constructor(
    private val context: Context,
    private val options: SwalvoClientOptions,
    token: String,
    endpoint: String,
    iceServers: List<IceServer>,
    /** The room id (`rid` claim) this session joined. */
    public val roomId: String,
    claims: TokenClaims,
    transport: WebSocketTransport = OkHttpWebSocketTransport(),
) {
    @OptIn(ExperimentalCoroutinesApi::class)
    private val dispatcher = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val logger = Logger(options.logLevel, options.logSink ?: Logger.LOGCAT)
    private val factory = RtcFactory.get(context)

    private val eventFlow = MutableSharedFlow<RoomEvent>(extraBufferCapacity = 1024)
    private val stateFlow = MutableStateFlow(ConnectionState.DISCONNECTED)

    /** Every [RoomEvent], in order. */
    public val events: SharedFlow<RoomEvent> = eventFlow.asSharedFlow()

    /** The connection state as a flow (also emitted as [RoomEvent.ConnectionStateChanged]). */
    public val connectionStateFlow: StateFlow<ConnectionState> = stateFlow.asStateFlow()

    public val localParticipant: LocalParticipant = LocalParticipant(claims.identity ?: "")

    private val signaling: SignalingClient
    private val controller: RoomController
    private val engine: PeerConnectionEngine

    /** E2EE controls (setKey / ratchetKey), present when [SwalvoClientOptions.e2ee] was given. */
    public val e2ee: E2eeManager? = options.e2ee?.let { e2eeOptions ->
        E2eeManager(factory, roomId, e2eeOptions) { pid, state ->
            scope.launch { controller.onE2eeState(pid, state) }
        }
    }

    init {
        signaling = SignalingClient(
            options = SignalingClient.Options(
                endpoint = endpoint,
                token = token,
                roomId = roomId,
                region = options.region,
                autoReconnect = options.autoReconnect,
                refreshToken = options.refreshToken,
                autoSubscribe = options.autoSubscribe,
            ),
            transport = transport,
            scope = scope,
            logger = logger,
        ) { event -> controller.onSignalingEvent(event) }

        controller = RoomController(
            localParticipant = localParticipant,
            scope = scope,
            logger = logger,
            options = RoomController.Options(options.autoSubscribe, options.adaptiveStream, options.autoReconnect),
            send = { signaling.send(it) },
            emit = ::emit,
            requestRejoin = { signaling.rejoin() },
        )
        controller.permissions = claims.permissions
        controller.roomRequiresE2ee = claims.e2ee
        localParticipant.applyMetadata(claims.metadata, clearMetadata = false, attributes = claims.attributes)
        localParticipant.updater = { metadata, attributes ->
            withContext(dispatcher) { controller.updateLocalMetadata(metadata, attributes) }
        }

        engine = PeerConnectionEngine(
            factory = factory,
            iceServers = iceServers.map { server ->
                PeerConnection.IceServer.builder(server.urls)
                    .apply { server.username?.let { setUsername(it) }; server.credential?.let { setPassword(it) } }
                    .createIceServer()
            },
            scope = scope,
            logger = logger,
            send = { signaling.send(it) },
            listener = controller,
            localIdentity = { localParticipant.identity },
            e2eeProvider = { e2ee?.takeIf { controller.roomRequiresE2ee } },
            preferredVideoCodec = options.preferredVideoCodec,
        )
        controller.engine = engine
    }

    private fun emit(event: RoomEvent) {
        if (event is RoomEvent.ConnectionStateChanged) stateFlow.value = event.state
        if (!eventFlow.tryEmit(event)) logger.w("room event buffer full; dropped $event")
    }

    internal suspend fun connect() = withContext(dispatcher) {
        controller.markConnecting()
        try {
            signaling.connect()
        } catch (e: RtcException) {
            controller.onSignalingEvent(SignalingEvent.Failed(e, DisconnectReason.CONNECTION_FAILED))
            scope.cancel()
            throw e
        }
    }

    // --- State --------------------------------------------------------------------

    public val connectionState: ConnectionState get() = stateFlow.value

    /** Everyone else in the room, in join order. */
    public val remoteParticipants: List<RemoteParticipant>
        get() = synchronized(controller.remoteParticipants) { controller.remoteParticipants.values.toList() }

    public fun getParticipant(identity: String): RemoteParticipant? = controller.remoteParticipants[identity]

    /** Loudest first, at most 8, possibly including [localParticipant]. */
    public val activeSpeakers: List<Participant> get() = controller.activeSpeakers

    /** What this participant may do right now (token grants, then live updates). */
    public val permissions: ParticipantPermissions? get() = controller.permissions

    /** Why the room disconnected, once it has. */
    public val disconnectReason: DisconnectReason? get() = controller.disconnectReason

    /** True when the room was created with `e2ee: true` (from `room.joined`). */
    public val isE2eeRequired: Boolean get() = controller.roomRequiresE2ee

    /** The SFU node's name, for support tickets. Never its address. */
    public val rtcServer: String? get() = controller.rtcServer

    /** Suspends until the media connection is up (or throws on timeout / disconnect). */
    public suspend fun waitUntilConnected(timeoutMs: Long = 15_000) {
        withTimeout(timeoutMs) {
            val state = stateFlow.first { it == ConnectionState.CONNECTED || it == ConnectionState.FAILED || it == ConnectionState.DISCONNECTED }
            if (state != ConnectionState.CONNECTED) {
                throw RtcException(RtcErrorCode.CONNECTION_FAILED, "The room ${state.name.lowercase()} before it connected")
            }
        }
    }

    // --- Publishing ------------------------------------------------------------------

    /** Captures the camera with Camera2 and publishes it with simulcast (low/medium/high). Idempotent. */
    public suspend fun enableCamera(cameraOptions: CameraOptions = CameraOptions()): LocalTrack = withContext(dispatcher) {
        engine.publicationFor(TrackKind.CAMERA)?.let { return@withContext it }
        requirePermission(Manifest.permission.CAMERA, RtcErrorCode.CAMERA_PERMISSION_DENIED)
        checkMayPublish(MediaKind.VIDEO)
        val id = Capture.newTrackId()
        engine.publish(TrackKind.CAMERA, Capture.camera(context, factory, cameraOptions, id), id, ::sendMute)
    }

    public suspend fun disableCamera(): Unit = unpublishKind(TrackKind.CAMERA)

    /** Switches between front and back cameras (or to [deviceName]). Returns false if there is no camera to switch. */
    public suspend fun switchCamera(deviceName: String? = null): Boolean {
        val handle = withContext(dispatcher) { engine.publicationFor(TrackKind.CAMERA)?.handle as? VideoCaptureHandle } ?: return false
        return handle.switchCamera(deviceName)
    }

    public suspend fun enableMicrophone(): LocalTrack = withContext(dispatcher) {
        engine.publicationFor(TrackKind.MICROPHONE)?.let { return@withContext it }
        requirePermission(Manifest.permission.RECORD_AUDIO, RtcErrorCode.MICROPHONE_PERMISSION_DENIED)
        checkMayPublish(MediaKind.AUDIO)
        val id = Capture.newTrackId()
        // One recording path (see ScreenAudioMixer): shared audio moves into the microphone track.
        if (ScreenAudioMixer.isActive) {
            ScreenAudioMixer.setMode(ScreenAudioMixer.Mode.MIX)
            engine.publicationFor(TrackKind.SCREEN_SHARE_AUDIO)?.let { engine.unpublish(it) }
        }
        engine.publish(TrackKind.MICROPHONE, Capture.microphone(factory, id), id, ::sendMute)
    }

    public suspend fun disableMicrophone(): Unit = withContext(dispatcher) {
        engine.publicationFor(TrackKind.MICROPHONE)?.let { engine.unpublish(it) }
        if (ScreenAudioMixer.isActive) publishScreenShareAudioTrack()
    }

    /**
     * Shares the screen with MediaProjection. [permissionResultData] is the
     * `Intent` your activity got back from
     * `MediaProjectionManager.createScreenCaptureIntent()`. On Android 14+
     * a foreground service of type `mediaProjection` must already be running
     * ([io.swalvo.rtc.call.SwalvoCallService]). Stopping the projection from
     * the system UI unpublishes the track ([RoomEvent.LocalTrackUnpublished]).
     *
     * With [ScreenShareOptions.captureAudio] on API 29+, the device's
     * playback audio is shared too (phase7 §3): as a
     * [TrackKind.SCREEN_SHARE_AUDIO] track while the microphone is off, mixed
     * into the microphone track while it is on. It stops with the screen
     * share, however that ends.
     */
    public suspend fun enableScreenShare(
        permissionResultData: Intent,
        screenOptions: ScreenShareOptions = ScreenShareOptions(),
    ): LocalTrack = withContext(dispatcher) {
        engine.publicationFor(TrackKind.SCREEN_SHARE)?.let { return@withContext it }
        checkMayPublishKind(TrackKind.SCREEN_SHARE)
        val wantsAudio = screenOptions.captureAudio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        if (screenOptions.captureAudio && !wantsAudio) {
            logger.w("screen-share audio needs Android 10 (API 29); sharing video only")
        }
        if (wantsAudio) requirePermission(Manifest.permission.RECORD_AUDIO, RtcErrorCode.MICROPHONE_PERMISSION_DENIED)
        val id = Capture.newTrackId()
        val handle = Capture.screen(context, factory, permissionResultData, screenOptions, id) {
            scope.launch { engine.publicationFor(TrackKind.SCREEN_SHARE)?.let { engine.unpublish(it) } }
        }
        // However the video ends (disable, system UI, permission withdrawn), the audio goes with it.
        handle.onDisposed = { scope.launch { stopScreenShareAudio() } }
        val track = engine.publish(TrackKind.SCREEN_SHARE, handle, id, ::sendMute)
        if (wantsAudio) startScreenShareAudio(handle.mediaProjection)
        track
    }

    public suspend fun disableScreenShare(): Unit = unpublishKind(TrackKind.SCREEN_SHARE)

    private suspend fun startScreenShareAudio(projection: android.media.projection.MediaProjection?) {
        if (projection == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            logger.w("no media projection to capture audio from; sharing video only")
            return
        }
        val granted = controller.permissions
        if (granted != null && !granted.mayPublish(MediaKind.AUDIO)) {
            logger.w("this token may not publish audio; sharing video only")
            return
        }
        val micOn = engine.publicationFor(TrackKind.MICROPHONE) != null
        ScreenAudioMixer.start(projection, if (micOn) ScreenAudioMixer.Mode.MIX else ScreenAudioMixer.Mode.REPLACE)
        if (micOn) {
            logger.i("the microphone is on: screen-share audio is mixed into the microphone track")
        } else {
            publishScreenShareAudioTrack()
        }
    }

    /** Must run on [dispatcher]. */
    private fun publishScreenShareAudioTrack() {
        if (engine.publicationFor(TrackKind.SCREEN_SHARE_AUDIO) != null) return
        ScreenAudioMixer.setMode(ScreenAudioMixer.Mode.REPLACE)
        val id = Capture.newTrackId()
        engine.publish(TrackKind.SCREEN_SHARE_AUDIO, Capture.screenShareAudio(factory, id), id, ::sendMute)
    }

    private suspend fun stopScreenShareAudio() {
        ScreenAudioMixer.stop()
        engine.publicationFor(TrackKind.SCREEN_SHARE_AUDIO)?.let { engine.unpublish(it) }
    }

    /** Stops sending [track] and releases its capture. */
    public suspend fun unpublish(track: LocalTrack): Unit = withContext(dispatcher) { engine.unpublish(track) }

    private suspend fun unpublishKind(kind: TrackKind) = withContext(dispatcher) {
        engine.publicationFor(kind)?.let { engine.unpublish(it) }
        Unit
    }

    private suspend fun sendMute(track: LocalTrack, muted: Boolean) {
        withContext(dispatcher) { signaling.send(ClientMessage.TrackMute(track.trackId, muted)) }
    }

    private fun requirePermission(permission: String, code: RtcErrorCode) {
        if (ContextCompat.checkSelfPermission(context, permission) != PackageManager.PERMISSION_GRANTED) {
            throw RtcException(code, "$permission has not been granted")
        }
    }

    private fun checkMayPublish(kind: MediaKind) {
        val granted = controller.permissions
        if (granted != null && !granted.mayPublish(kind)) {
            throw RtcException(RtcErrorCode.PERMISSION_DENIED, "This token may not publish ${kind.wire}")
        }
        checkE2ee()
    }

    /**
     * Same as [checkMayPublish], but source-aware: screen share gates on
     * [ParticipantPermissions.publishScreen], not [ParticipantPermissions.publishVideo]
     * (agora-parity audit, phase 2).
     */
    private fun checkMayPublishKind(kind: TrackKind) {
        val granted = controller.permissions
        if (granted != null && !granted.mayPublishKind(kind)) {
            throw RtcException(RtcErrorCode.PERMISSION_DENIED, "This token may not publish ${kind.wire}")
        }
        checkE2ee()
    }

    // phase5 §3.1: never publish plaintext into an E2EE room.
    private fun checkE2ee() {
        if (controller.roomRequiresE2ee && e2ee == null) {
            throw RtcException(RtcErrorCode.E2EE_ERROR, "This room requires end-to-end encryption; pass SwalvoClientOptions(e2ee = ...)")
        }
    }

    // --- Data ----------------------------------------------------------------------------

    /** True when the server supports data messages v2 (`room.joined.capabilities` has `data.v2`): topics, targeting, the lossy channel and sender identity. */
    public val supportsDataV2: Boolean get() = controller.supportsDataV2

    private var warnedLossyFallback = false

    /**
     * Sends a data message (phase7 §1). With the default [options] this is a
     * reliable broadcast of up to 64 KiB over `raven-data`, exactly as
     * before. [DataPublishOptions.topic] and
     * [DataPublishOptions.destinationIdentities] wrap the payload in a v2
     * envelope; `reliable = false` uses `raven-data-lossy` (at most 1,200
     * bytes, unordered, never retransmitted) when the server supports it,
     * and falls back to the reliable channel otherwise.
     *
     * Data messages are **not** end-to-end encrypted, even in an E2EE room.
     */
    public suspend fun sendData(payload: ByteArray, options: DataPublishOptions = DataPublishOptions()): Unit = withContext(dispatcher) {
        if (controller.permissions?.publishData == false) {
            // Checked up front: without publishData the channel's offer would be refused and fail the connection.
            throw RtcException(RtcErrorCode.PERMISSION_DENIED, "sendData() requires a token that grants publishData")
        }
        DataEnvelope.checkPayloadSize(payload.size, options.reliable)
        val v2 = controller.supportsDataV2
        val useEnvelope = v2 || !options.topic.isNullOrEmpty() || options.destinationIdentities.isNotEmpty() || !options.reliable
        val bytes = if (useEnvelope) DataEnvelope.encode(payload, options.topic, options.destinationIdentities) else payload
        val lossy = !options.reliable && v2
        if (!options.reliable && !v2 && !warnedLossyFallback) {
            warnedLossyFallback = true
            logger.w("this server does not support the lossy data channel; sending reliably instead")
        }
        engine.sendData(bytes, lossy)
    }

    public suspend fun sendData(text: String, options: DataPublishOptions = DataPublishOptions()): Unit =
        sendData(text.toByteArray(Charsets.UTF_8), options)

    // --- Leaving -------------------------------------------------------------------------

    /** Leaves the room (`room.leave`), releases every device and ends with [DisconnectReason.CLIENT_INITIATED]. */
    public suspend fun leave() {
        withContext(dispatcher) {
            controller.markIntentionalDisconnect()
            signaling.close()
            controller.onSignalingEvent(SignalingEvent.Closed)
            ScreenAudioMixer.stop()
            engine.close()
            e2ee?.dispose()
        }
        scope.cancel()
    }

    /** Call when the device's network changed: skips any reconnect backoff in progress. */
    public fun handleNetworkChange() {
        scope.launch { signaling.reconnectNow() }
    }
}
