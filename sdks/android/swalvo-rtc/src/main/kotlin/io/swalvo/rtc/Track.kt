package io.swalvo.rtc

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.webrtc.MediaStreamTrack
import org.webrtc.VideoSink
import org.webrtc.VideoTrack

/** What a track is *of*. The wire `source` (`track.publish`) for each is [wire]. */
public enum class TrackKind(public val wire: String) {
    CAMERA("camera"),
    MICROPHONE("microphone"),
    SCREEN_SHARE("screenShare"),
    /** phase7 §3: the audio of a screen share. Speaker detection ignores it. */
    SCREEN_SHARE_AUDIO("screenShareAudio"),
    UNKNOWN("unknown");

    public val mediaKind: MediaKind get() = if (this == MICROPHONE || this == SCREEN_SHARE_AUDIO) MediaKind.AUDIO else MediaKind.VIDEO

    public companion object {
        /** Same fallback as the web SDK: an unrecognised source is inferred from the codec kind. */
        internal fun fromWire(source: String, kind: String): TrackKind = when (source) {
            "camera" -> CAMERA
            "microphone" -> MICROPHONE
            "screenShare" -> SCREEN_SHARE
            "screenShareAudio" -> SCREEN_SHARE_AUDIO
            else -> if (kind == "audio") MICROPHONE else CAMERA
        }
    }
}

/** The wire-level media kind (`audio` / `video`). */
public enum class MediaKind(public val wire: String) { AUDIO("audio"), VIDEO("video") }

/** Whether the SFU is forwarding a subscribed track right now (phase2 §4). */
public enum class TrackSubscriptionState(public val wire: String) {
    ACTIVE("active"), PAUSED_BANDWIDTH("paused_bandwidth"), PAUSED_CLIENT("paused_client");

    public companion object {
        internal fun fromWire(value: String): TrackSubscriptionState? = entries.firstOrNull { it.wire == value }
    }
}

/** The simulcast layer the SFU says it is forwarding, or [OFF] when none. */
public enum class ForwardedLayer(public val wire: String) {
    LOW("low"), MEDIUM("medium"), HIGH("high"), OFF("off");

    public companion object {
        internal fun fromWire(value: String?): ForwardedLayer? = entries.firstOrNull { it.wire == value }
    }
}

/** A layer an application may pin with [RemoteTrack.setLayer]. */
public enum class VideoLayer(public val wire: String) { LOW("low"), MEDIUM("medium"), HIGH("high"), AUTO("auto") }

/** A published or subscribed media track. */
public abstract class Track internal constructor(
    public val kind: TrackKind,
    public val mediaKind: MediaKind,
) {
    /** The id the SFU knows this track by (the SDP `msid` track id). */
    public abstract val trackId: String

    internal val mutedState = MutableStateFlow(false)

    /** Muted by the publisher (or, for your own track, by you or by the server). */
    public val muted: StateFlow<Boolean> = mutedState.asStateFlow()
    public val isMuted: Boolean get() = mutedState.value

    /** The underlying libwebrtc track. Null only in tests or after the track was released. */
    public abstract val mediaStreamTrack: MediaStreamTrack?

    /** Renders a video track into [sink], e.g. an `org.webrtc.SurfaceViewRenderer`. No-op for audio. */
    public fun addSink(sink: VideoSink) {
        (mediaStreamTrack as? VideoTrack)?.addSink(sink)
    }

    public fun removeSink(sink: VideoSink) {
        try {
            (mediaStreamTrack as? VideoTrack)?.removeSink(sink)
        } catch (_: IllegalStateException) {
            // Track already disposed.
        }
    }
}

/** What the engine needs from a captured local track. */
internal interface LocalMediaHandle {
    val track: MediaStreamTrack?
    fun setEnabled(enabled: Boolean)
    /** Stops capture and releases the source. */
    fun dispose()
}

/** A track this device captures and publishes. */
public class LocalTrack internal constructor(
    kind: TrackKind,
    trackId: String,
    internal val handle: LocalMediaHandle,
    private val muteSink: suspend (LocalTrack, Boolean) -> Unit,
) : Track(kind, kind.mediaKind) {

    /** Re-read from the local SDP after each negotiation, so it is always the id the SFU sees. */
    override var trackId: String = trackId
        internal set

    override val mediaStreamTrack: MediaStreamTrack? get() = handle.track

    /** Mutes without unpublishing: the transceiver stays, so unmuting is immediate (`track.mute`). */
    public suspend fun mute() {
        setMutedLocally(true)
        muteSink(this, true)
    }

    public suspend fun unmute() {
        setMutedLocally(false)
        muteSink(this, false)
    }

    internal fun setMutedLocally(muted: Boolean) {
        handle.setEnabled(!muted)
        mutedState.value = muted
    }

    /** Releases capture. Prefer `room.unpublish(track)` / `disableCamera()`, which also stop sending. */
    public fun stop() {
        handle.dispose()
    }
}

/** What the engine hands over for a received track. */
internal interface RemoteMediaHandle {
    val track: MediaStreamTrack?
}

/** Receives a remote track's layer decisions; implemented by the room. */
internal interface RemoteTrackControl {
    fun onLayerInputsChanged(track: RemoteTrack)
}

/** A track another participant publishes, received from the SFU. */
public class RemoteTrack internal constructor(
    override val trackId: String,
    public val participantId: String,
    kind: TrackKind,
    mediaKind: MediaKind,
    internal val media: RemoteMediaHandle?,
    private val control: RemoteTrackControl,
) : Track(kind, mediaKind) {

    override val mediaStreamTrack: MediaStreamTrack? get() = media?.track

    private val subscriptionStateFlow = MutableStateFlow(TrackSubscriptionState.ACTIVE)
    private val layerFlow = MutableStateFlow<ForwardedLayer?>(null)

    /** What the SFU is actually doing with this subscription (from `subscription.state`), not what was requested. */
    public val subscriptionStateChanges: StateFlow<TrackSubscriptionState> = subscriptionStateFlow.asStateFlow()
    public val subscriptionState: TrackSubscriptionState get() = subscriptionStateFlow.value

    /** The layer the SFU says it is forwarding, when it has said. */
    public val layer: ForwardedLayer? get() = layerFlow.value

    internal var enabled: Boolean = true
        private set
    internal var visible: Boolean = true
        private set
    internal var pinnedLayer: VideoLayer? = null
        private set

    public val isEnabled: Boolean get() = enabled

    /**
     * An application pause: `false` asks the SFU to stop forwarding this
     * video (`subscription.update` layer `off`) without renegotiating.
     * No-op for audio, which is always forwarded.
     */
    public fun setEnabled(enabled: Boolean) {
        if (enabled && startedUnwanted) {
            // autoSubscribe = false: enabling is how an app says "I want this one now".
            startedUnwanted = false
            visible = true
        } else if (this.enabled == enabled) {
            return
        }
        this.enabled = enabled
        control.onLayerInputsChanged(this)
    }

    /**
     * Tell the SDK whether any view of this video is on screen. With
     * adaptive streaming on (the default), an invisible video is switched
     * to layer `off` after a 500 ms debounce; becoming visible resumes it at once.
     */
    public fun setVisible(visible: Boolean) {
        if (this.visible == visible) return
        this.visible = visible
        if (visible) startedUnwanted = false
        control.onLayerInputsChanged(this)
    }

    /** Pins a simulcast layer; [VideoLayer.AUTO] lets bandwidth decide. Pass null to unpin. */
    public fun setLayer(layer: VideoLayer?) {
        if (pinnedLayer == layer) return
        pinnedLayer = layer
        control.onLayerInputsChanged(this)
    }

    /** With `autoSubscribe = false` a video starts unwanted until shown, enabled or pinned. */
    internal fun initVisibility(visible: Boolean) {
        this.visible = visible
        startedUnwanted = !visible
    }

    private var startedUnwanted = false

    internal fun setSubscriptionState(state: TrackSubscriptionState, layer: ForwardedLayer?) {
        subscriptionStateFlow.value = state
        layerFlow.value = layer
    }

    override fun toString(): String = "RemoteTrack($participantId/$trackId, $kind)"
}
