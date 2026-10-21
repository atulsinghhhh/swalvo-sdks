package io.swalvo.rtc.internal.media

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import io.swalvo.rtc.CameraFacing
import io.swalvo.rtc.CameraOptions
import io.swalvo.rtc.LocalMediaHandle
import io.swalvo.rtc.ScreenShareOptions
import io.swalvo.rtc.RtcErrorCode
import io.swalvo.rtc.RtcException
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnectionFactory
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

internal class VideoCaptureHandle(
    private val capturer: VideoCapturer,
    private val source: VideoSource,
    private val helper: SurfaceTextureHelper,
    private val videoTrack: VideoTrack,
) : LocalMediaHandle {
    @Volatile private var disposed = false
    override val track: MediaStreamTrack? get() = if (disposed) null else videoTrack

    /** Called once after [dispose]; a screen share uses it to stop its audio with it (phase7 §3). */
    @Volatile var onDisposed: (() -> Unit)? = null

    /** The projection behind a screen share, once capture has started. Null for a camera. */
    val mediaProjection: MediaProjection?
        get() = (capturer as? ScreenCapturerAndroid)?.let { runCatching { it.mediaProjection }.getOrNull() }

    override fun setEnabled(enabled: Boolean) {
        if (!disposed) videoTrack.setEnabled(enabled)
    }

    /** Camera only: flips to the next camera. */
    suspend fun switchCamera(deviceName: String?): Boolean {
        val camera = capturer as? CameraVideoCapturer ?: return false
        return suspendCancellableCoroutine { cont ->
            val handler = object : CameraVideoCapturer.CameraSwitchHandler {
                override fun onCameraSwitchDone(isFrontCamera: Boolean) { if (cont.isActive) cont.resume(true) }
                override fun onCameraSwitchError(errorDescription: String?) { if (cont.isActive) cont.resume(false) }
            }
            if (deviceName == null) camera.switchCamera(handler) else camera.switchCamera(handler, deviceName)
        }
    }

    override fun dispose() {
        if (disposed) return
        disposed = true
        runCatching { capturer.stopCapture() }
        runCatching { capturer.dispose() }
        runCatching { videoTrack.dispose() }
        runCatching { source.dispose() }
        runCatching { helper.dispose() }
        onDisposed?.invoke()
        onDisposed = null
    }
}

internal class AudioCaptureHandle(
    private val source: AudioSource,
    private val audioTrack: AudioTrack,
) : LocalMediaHandle {
    @Volatile private var disposed = false
    override val track: MediaStreamTrack? get() = if (disposed) null else audioTrack
    override fun setEnabled(enabled: Boolean) {
        if (!disposed) audioTrack.setEnabled(enabled)
    }
    override fun dispose() {
        if (disposed) return
        disposed = true
        runCatching { audioTrack.dispose() }
        runCatching { source.dispose() }
    }
}

internal object Capture {
    fun newTrackId(): String = UUID.randomUUID().toString()

    fun camera(context: Context, factory: PeerConnectionFactory, options: CameraOptions, trackId: String): VideoCaptureHandle {
        val enumerator = Camera2Enumerator(context)
        val names = enumerator.deviceNames
        val device = options.deviceName?.takeIf { it in names }
            ?: names.firstOrNull { if (options.facing == CameraFacing.FRONT) enumerator.isFrontFacing(it) else enumerator.isBackFacing(it) }
            ?: names.firstOrNull()
            ?: throw RtcException(RtcErrorCode.MEDIA_ERROR, "This device has no camera")
        val capturer = enumerator.createCapturer(device, null)
            ?: throw RtcException(RtcErrorCode.MEDIA_ERROR, "Could not open camera $device")
        return startVideo(context, factory, capturer, isScreencast = false, options.width, options.height, options.fps, trackId)
    }

    fun screen(
        context: Context,
        factory: PeerConnectionFactory,
        permissionResultData: Intent,
        options: ScreenShareOptions,
        trackId: String,
        onStopped: () -> Unit,
    ): VideoCaptureHandle {
        val capturer = ScreenCapturerAndroid(permissionResultData, object : MediaProjection.Callback() {
            override fun onStop() = onStopped()
        })
        return startVideo(context, factory, capturer, isScreencast = true, options.width, options.height, options.fps, trackId)
    }

    private fun startVideo(
        context: Context,
        factory: PeerConnectionFactory,
        capturer: VideoCapturer,
        isScreencast: Boolean,
        width: Int,
        height: Int,
        fps: Int,
        trackId: String,
    ): VideoCaptureHandle {
        val helper = SurfaceTextureHelper.create("swalvo-capture", RtcFactory.eglBase().eglBaseContext)
        val source = factory.createVideoSource(isScreencast)
        try {
            capturer.initialize(helper, context.applicationContext, source.capturerObserver)
            capturer.startCapture(width, height, fps)
        } catch (e: SecurityException) {
            helper.dispose()
            source.dispose()
            throw RtcException(
                if (isScreencast) RtcErrorCode.SCREEN_SHARE_PERMISSION_DENIED else RtcErrorCode.CAMERA_PERMISSION_DENIED,
                e.message ?: "capture permission denied",
                e,
            )
        }
        val track = factory.createVideoTrack(trackId, source)
        return VideoCaptureHandle(capturer, source, helper, track)
    }

    fun microphone(factory: PeerConnectionFactory, trackId: String): AudioCaptureHandle {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "true"))
        }
        val source = factory.createAudioSource(constraints)
        val track = factory.createAudioTrack(trackId, source)
        return AudioCaptureHandle(source, track)
    }

    /**
     * The `screenShareAudio` track (phase7 §3). Its samples come from
     * [ScreenAudioMixer] in replace mode; voice processing is off, since
     * echo cancellation and noise suppression would mangle music and video.
     */
    fun screenShareAudio(factory: PeerConnectionFactory, trackId: String): AudioCaptureHandle {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "false"))
        }
        val source = factory.createAudioSource(constraints)
        val track = factory.createAudioTrack(trackId, source)
        return AudioCaptureHandle(source, track)
    }
}
