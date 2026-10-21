package io.swalvo.rtc.internal.media

import android.content.Context
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import org.webrtc.SimulcastVideoEncoderFactory
import org.webrtc.SoftwareVideoEncoderFactory
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Process-wide libwebrtc state: one native init, one EGL context (share it
 * with your `SurfaceViewRenderer`s via [eglBase]), one factory.
 *
 * The encoder factory is wrapped in [SimulcastVideoEncoderFactory] so a
 * camera published with three `rid` encodings really sends three layers.
 */
internal object RtcFactory {
    @Volatile private var initialized = false
    private var factoryInstance: PeerConnectionFactory? = null
    private var eglInstance: EglBase? = null

    fun eglBase(): EglBase = synchronized(this) {
        eglInstance ?: EglBase.create().also { eglInstance = it }
    }

    fun get(context: Context): PeerConnectionFactory = synchronized(this) {
        factoryInstance?.let { return it }
        val appContext = context.applicationContext
        if (!initialized) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext)
                    .setEnableInternalTracer(false)
                    .createInitializationOptions(),
            )
            initialized = true
        }
        val egl = eglBase()
        val encoderFactory = SimulcastVideoEncoderFactory(
            DefaultVideoEncoderFactory(egl.eglBaseContext, /* enableIntelVp8Encoder = */ true, /* enableH264HighProfile = */ true),
            SoftwareVideoEncoderFactory(),
        )
        val audioModule = JavaAudioDeviceModule.builder(appContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            // phase7 §3: lets a screen share replace or mix in the device's playback audio.
            .setAudioBufferCallback(ScreenAudioMixer)
            .createAudioDeviceModule()
        val factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioModule)
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        audioModule.release() // the factory holds its own reference
        factoryInstance = factory
        factory
    }
}
