package io.swalvo.rtc.internal.media

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import androidx.annotation.RequiresApi
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Screen-share audio (phase7 §3) on Android.
 *
 * libwebrtc's Java audio device module has a single recording path: every
 * local audio track carries what that path records. So system audio cannot
 * be a truly separate source next to the microphone. Instead this hooks the
 * recording buffer ([JavaAudioDeviceModule.AudioBufferCallback], from the
 * webrtc-sdk build) and either
 *
 * - [Mode.REPLACE]: overwrites the microphone samples with the captured
 *   playback audio. Used when the microphone is not published, so the
 *   `screenShareAudio` track carries only the shared audio; or
 * - [Mode.MIX]: adds the playback audio to the microphone samples. Used
 *   when the microphone is published: the shared audio rides in the
 *   microphone track (muting the microphone mutes it too).
 *
 * Playback audio comes from an [AudioRecord] built on
 * [AudioPlaybackCaptureConfiguration] (API 29+), created lazily on the audio
 * thread to match the format the module asks for.
 */
internal object ScreenAudioMixer : JavaAudioDeviceModule.AudioBufferCallback {
    enum class Mode { REPLACE, MIX }

    private class Session(val projection: MediaProjection) {
        @Volatile var mode: Mode = Mode.REPLACE
        var record: AudioRecord? = null
        var format: Pair<Int, Int>? = null
        var scratch: ByteBuffer = ByteBuffer.allocateDirect(0)
        @Volatile var released = false
    }

    @Volatile private var session: Session? = null

    val isActive: Boolean get() = session != null

    /** Starts capturing playback audio from [projection]. API 29+. */
    @RequiresApi(Build.VERSION_CODES.Q)
    fun start(projection: MediaProjection, mode: Mode) {
        stop()
        session = Session(projection).also { it.mode = mode }
    }

    fun setMode(mode: Mode) {
        session?.mode = mode
    }

    fun stop() {
        val current = session ?: return
        session = null
        synchronized(current) {
            current.released = true
            current.record?.let { runCatching { it.stop() }; runCatching { it.release() } }
            current.record = null
        }
    }

    override fun onBuffer(
        buffer: ByteBuffer,
        audioFormat: Int,
        channelCount: Int,
        sampleRate: Int,
        bytesRead: Int,
        captureTimeNs: Long,
    ): Long {
        val current = session ?: return captureTimeNs
        if (audioFormat != AudioFormat.ENCODING_PCM_16BIT || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return captureTimeNs
        synchronized(current) {
            if (current.released) return captureTimeNs
            val record = recordFor(current, sampleRate, channelCount) ?: return captureTimeNs
            if (current.scratch.capacity() < bytesRead) {
                current.scratch = ByteBuffer.allocateDirect(bytesRead).order(ByteOrder.nativeOrder())
            }
            val scratch = current.scratch
            scratch.clear()
            val got = record.read(scratch, bytesRead, AudioRecord.READ_NON_BLOCKING).coerceAtLeast(0)
            // Anything not read yet is silence, not stale samples.
            for (i in got until bytesRead) scratch.put(i, 0)
            val out = buffer.duplicate().order(ByteOrder.nativeOrder())
            val samples = scratch.duplicate().order(ByteOrder.nativeOrder())
            var i = 0
            while (i + 1 < bytesRead) {
                val shared = samples.getShort(i).toInt()
                val value = if (current.mode == Mode.REPLACE) shared else (out.getShort(i).toInt() + shared)
                out.putShort(i, value.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort())
                i += 2
            }
        }
        return captureTimeNs
    }

    @SuppressLint("MissingPermission") // RECORD_AUDIO is checked before a session starts.
    private fun recordFor(current: Session, sampleRate: Int, channelCount: Int): AudioRecord? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val wanted = sampleRate to channelCount
        if (current.format == wanted) return current.record
        current.record?.let { runCatching { it.stop() }; runCatching { it.release() } }
        current.record = null
        current.format = wanted
        return try {
            val config = AudioPlaybackCaptureConfiguration.Builder(current.projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            val channelMask = if (channelCount == 2) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(channelMask)
                .build()
            val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
            AudioRecord.Builder()
                .setAudioFormat(format)
                .setAudioPlaybackCaptureConfig(config)
                .setBufferSizeInBytes((minBuffer * 2).coerceAtLeast(sampleRate / 50 * channelCount * 2 * 4))
                .build()
                .also {
                    it.startRecording()
                    current.record = it
                }
        } catch (_: Exception) {
            null
        }
    }
}
