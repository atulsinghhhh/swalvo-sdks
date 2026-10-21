package io.swalvo.rtc.audio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

/** Where call audio plays. */
public enum class AudioRoute { SPEAKER, EARPIECE, BLUETOOTH, WIRED_HEADSET }

/**
 * Call-audio helper over [AudioManager]: communication mode, audio focus,
 * and routing between speaker, earpiece, wired headset and Bluetooth.
 *
 * Uses `setCommunicationDevice` on Android 12+ and the older
 * speakerphone / SCO calls below that. Not needed if your app routes audio
 * itself (for example through Telecom's `CallEndpoint` APIs).
 *
 * Bluetooth on Android 12+ needs the `BLUETOOTH_CONNECT` runtime permission.
 */
public class AudioRouter(context: Context) {
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var savedMode: Int = AudioManager.MODE_NORMAL
    private var started = false

    /** Enters communication mode and takes audio focus. Call when the call starts. */
    public fun start(initialRoute: AudioRoute? = null) {
        if (started) return
        started = true
        savedMode = audioManager.mode
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        requestFocus()
        selectRoute(initialRoute ?: defaultRoute())
    }

    /** Restores the previous mode and abandons focus. Call when the call ends. */
    @SuppressLint("NewApi")
    public fun stop() {
        if (!started) return
        started = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = false
            @Suppress("DEPRECATION")
            if (audioManager.isBluetoothScoOn) {
                audioManager.stopBluetoothSco()
                audioManager.isBluetoothScoOn = false
            }
        }
        abandonFocus()
        audioManager.mode = savedMode
    }

    /** Routes that are available right now. */
    public fun availableRoutes(): List<AudioRoute> {
        val routes = linkedSetOf(AudioRoute.SPEAKER)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (device in audioManager.availableCommunicationDevices) routeOf(device.type)?.let { routes.add(it) }
        } else {
            val outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            for (device in outputs) routeOf(device.type)?.let { routes.add(it) }
            if (outputs.none { routeOf(it.type) == AudioRoute.WIRED_HEADSET }) routes.add(AudioRoute.EARPIECE)
        }
        return routes.toList()
    }

    /** Selects [route]. Returns false if it is not available. */
    public fun selectRoute(route: AudioRoute): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val device = audioManager.availableCommunicationDevices.firstOrNull { routeOf(it.type) == route } ?: return false
            return audioManager.setCommunicationDevice(device)
        }
        @Suppress("DEPRECATION")
        when (route) {
            AudioRoute.SPEAKER -> {
                stopSco()
                audioManager.isSpeakerphoneOn = true
            }
            AudioRoute.EARPIECE, AudioRoute.WIRED_HEADSET -> {
                stopSco()
                audioManager.isSpeakerphoneOn = false
            }
            AudioRoute.BLUETOOTH -> {
                audioManager.isSpeakerphoneOn = false
                audioManager.startBluetoothSco()
                audioManager.isBluetoothScoOn = true
            }
        }
        return true
    }

    @Suppress("DEPRECATION")
    private fun stopSco() {
        if (audioManager.isBluetoothScoOn) {
            audioManager.stopBluetoothSco()
            audioManager.isBluetoothScoOn = false
        }
    }

    /** Bluetooth, then a wired headset, then the speaker (a video call's natural default). */
    private fun defaultRoute(): AudioRoute {
        val available = availableRoutes()
        return when {
            AudioRoute.BLUETOOTH in available -> AudioRoute.BLUETOOTH
            AudioRoute.WIRED_HEADSET in available -> AudioRoute.WIRED_HEADSET
            else -> AudioRoute.SPEAKER
        }
    }

    private fun routeOf(type: Int): AudioRoute? = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> AudioRoute.SPEAKER
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> AudioRoute.EARPIECE
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> AudioRoute.BLUETOOTH
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> AudioRoute.WIRED_HEADSET
        else -> null
    }

    private fun requestFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .build()
            focusRequest = request
            audioManager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN)
        }
    }

    private fun abandonFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            focusRequest = null
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(null)
        }
    }
}
