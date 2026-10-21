package io.swalvo.rtc.e2ee

import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * phase5 §3.1 key schedule, exactly as pinned by
 * docs/architecture/e2ee-vectors.json (the cross-SDK vectors):
 *
 * ```
 * passphrase → material  PBKDF2-HMAC-SHA256(utf8(passphrase), utf8("LivqenoE2EE:" + roomId), 100 000, 32 bytes)
 * material   → AES key   HKDF-SHA256(material, salt = utf8("LivqenoRatchet"), info = 128 zero bytes, 16 bytes)
 * ratchet    material'  = HKDF-SHA256(material, salt = utf8("LivqenoRatchet"), info = 128 zero bytes, 32 bytes)
 * ```
 *
 * The second and third lines are what libwebrtc's FrameCryptor key provider
 * does natively with `keyDerivationAlgorithm = HKDF` and
 * `ratchetSalt = "LivqenoRatchet"`, so the SDK hands the provider the
 * 32-byte *material* and the device-side crypto agrees with every other SDK.
 *
 * Pure Kotlin (only `HmacSHA256`/`AES/GCM`), so it is testable on the JVM and
 * identical on every Android version — the platform's
 * `PBKDF2WithHmacSHA256` only exists from API 26.
 */
public object E2eeKeyDerivation {
    public const val PBKDF2_ITERATIONS: Int = 100_000
    public const val MATERIAL_LENGTH_BYTES: Int = 32
    public const val AES_KEY_LENGTH_BYTES: Int = 16 // AES-GCM-128
    // legacy: KDF labels kept byte-for-byte; changing them breaks E2EE across versions.
    public const val PASSPHRASE_SALT_PREFIX: String = "LivqenoE2EE:"
    public const val RATCHET_SALT: String = "LivqenoRatchet"

    /** HKDF `info`: 128 zero bytes, as libwebrtc's FrameCryptor uses. */
    public val HKDF_INFO: ByteArray get() = ByteArray(128)

    /** Shared-passphrase mode: the 32-byte key material every participant derives. */
    public fun materialFromPassphrase(passphrase: String, roomId: String): ByteArray =
        pbkdf2HmacSha256(
            passphrase.toByteArray(Charsets.UTF_8),
            (PASSPHRASE_SALT_PREFIX + roomId).toByteArray(Charsets.UTF_8),
            PBKDF2_ITERATIONS,
            MATERIAL_LENGTH_BYTES,
        )

    /** The AES-GCM-128 frame key for a piece of key material. */
    public fun aesKeyFromMaterial(material: ByteArray): ByteArray =
        hkdfSha256(material, RATCHET_SALT.toByteArray(Charsets.UTF_8), HKDF_INFO, AES_KEY_LENGTH_BYTES)

    /** One ratchet step (`ratchetKey`): the next 32-byte material. */
    public fun ratchet(material: ByteArray): ByteArray =
        hkdfSha256(material, RATCHET_SALT.toByteArray(Charsets.UTF_8), HKDF_INFO, MATERIAL_LENGTH_BYTES)

    /** RFC 8018 PBKDF2 with HMAC-SHA256. */
    public fun pbkdf2HmacSha256(password: ByteArray, salt: ByteArray, iterations: Int, length: Int): ByteArray {
        require(iterations > 0 && length > 0)
        val mac = Mac.getInstance("HmacSHA256")
        // An empty password is legal in PBKDF2 but not as a SecretKeySpec. HMAC zero-pads its key
        // to the block size, so 64 zero bytes is the same key.
        mac.init(SecretKeySpec(if (password.isEmpty()) ByteArray(64) else password, "HmacSHA256"))
        val hLen = mac.macLength
        val blocks = (length + hLen - 1) / hLen
        val out = ByteArray(length)
        var offset = 0
        for (i in 1..blocks) {
            mac.update(salt)
            mac.update(byteArrayOf((i ushr 24).toByte(), (i ushr 16).toByte(), (i ushr 8).toByte(), i.toByte()))
            var u = mac.doFinal()
            val t = u.copyOf()
            for (j in 1 until iterations) {
                u = mac.doFinal(u)
                for (k in t.indices) t[k] = (t[k].toInt() xor u[k].toInt()).toByte()
            }
            val n = minOf(hLen, length - offset)
            System.arraycopy(t, 0, out, offset, n)
            offset += n
        }
        return out
    }

    /** RFC 5869 HKDF with SHA-256. */
    public fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..255 * 32)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val n = minOf(previous.size, length - offset)
            System.arraycopy(previous, 0, out, offset, n)
            offset += n
            counter++
        }
        return out
    }
}

/** Codecs whose clear-header rules phase5 §3.2 fixes. */
public enum class E2eeCodec { VP8, H264, OPUS, VP9, AV1 }

/**
 * Reference implementation of the phase5 §3.2 frame format:
 *
 * ```
 * [ clear header ][ AES-GCM-128 ciphertext ][ 16-byte tag ][ 12-byte IV ][ 0x0c ][ keyIndex ]
 * ```
 *
 * AAD is the clear header. For H.264 everything after the header is
 * RBSP-escaped (emulation-prevention bytes), so the encrypted payload can
 * never fake a start code.
 *
 * On a device libwebrtc's FrameCryptor produces and consumes these frames
 * natively ([E2eeManager]); this object pins the format down with JVM tests
 * against the shared vectors and lets tools decode captures.
 */
public object E2eeFrameCodec {
    public const val IV_LENGTH: Int = 12
    public const val TAG_LENGTH: Int = 16
    private const val TRAILER = IV_LENGTH + 2

    /** IV = ssrc ‖ rtpTimestamp ‖ (rtpTimestamp − (sendCount mod 0xFFFF)) mod 2³², each 4 bytes big-endian. */
    public fun makeIv(ssrc: Long, timestamp: Long, sendCount: Long): ByteArray {
        val iv = ByteArray(IV_LENGTH)
        putU32(iv, 0, ssrc)
        putU32(iv, 4, timestamp)
        putU32(iv, 8, (timestamp - (sendCount % 0xFFFF)) and 0xFFFFFFFFL)
        return iv
    }

    /**
     * Leading bytes left in the clear so the SFU still sees keyframes and
     * layers. VP8: 10 on keyframes, 3 otherwise; Opus: 1; VP9/AV1: 0;
     * H.264: up to the first slice NALU (type 1 or 5) plus 2 bytes past its
     * start code, so SPS/PPS stay clear.
     */
    public fun unencryptedBytes(codec: E2eeCodec, frame: ByteArray, keyframe: Boolean): Int = when (codec) {
        E2eeCodec.VP8 -> minOf(if (keyframe) 10 else 3, frame.size)
        E2eeCodec.OPUS -> minOf(1, frame.size)
        E2eeCodec.VP9, E2eeCodec.AV1 -> 0
        E2eeCodec.H264 -> h264ClearBytes(frame)
    }

    private fun h264ClearBytes(frame: ByteArray): Int {
        var i = 0
        while (i + 3 <= frame.size) {
            val startCode = when {
                i + 4 <= frame.size && frame[i].toInt() == 0 && frame[i + 1].toInt() == 0 &&
                    frame[i + 2].toInt() == 0 && frame[i + 3].toInt() == 1 -> 4
                frame[i].toInt() == 0 && frame[i + 1].toInt() == 0 && frame[i + 2].toInt() == 1 -> 3
                else -> 0
            }
            if (startCode == 0) {
                i++
                continue
            }
            val header = i + startCode
            if (header >= frame.size) break
            val type = frame[header].toInt() and 0x1F
            if (type == 1 || type == 5) return minOf(header + 2, frame.size)
            i = header + 1
        }
        return frame.size
    }

    /** Seals one frame with the AES key [aesKey] (see [E2eeKeyDerivation.aesKeyFromMaterial]). */
    public fun encrypt(
        frame: ByteArray,
        codec: E2eeCodec,
        keyframe: Boolean,
        aesKey: ByteArray,
        keyIndex: Int,
        ssrc: Long,
        timestamp: Long,
        sendCount: Long,
    ): ByteArray {
        require(keyIndex in 0..255)
        val clear = unencryptedBytes(codec, frame, keyframe)
        val iv = makeIv(ssrc, timestamp, sendCount)
        val header = frame.copyOfRange(0, clear)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(TAG_LENGTH * 8, iv))
        cipher.updateAAD(header)
        val sealed = cipher.doFinal(frame, clear, frame.size - clear) // ciphertext ‖ tag
        val body = sealed + iv + byteArrayOf(IV_LENGTH.toByte(), keyIndex.toByte())
        return header + if (codec == E2eeCodec.H264) Rbsp.escape(body) else body
    }

    /** The key index a frame was sealed with (its last byte). */
    public fun keyIndexOf(frame: ByteArray): Int = frame.last().toInt() and 0xFF

    /**
     * Opens one frame with [aesKey]. Returns null when the tag does not
     * verify (wrong key), so a caller can ratchet and retry.
     */
    public fun decrypt(frame: ByteArray, codec: E2eeCodec, keyframe: Boolean, aesKey: ByteArray): ByteArray? {
        val clear = unencryptedBytes(codec, frame, keyframe)
        val header = frame.copyOfRange(0, clear)
        val body = frame.copyOfRange(clear, frame.size).let { if (codec == E2eeCodec.H264) Rbsp.unescape(it) else it }
        if (body.size < TAG_LENGTH + TRAILER) return null
        if ((body[body.size - 2].toInt() and 0xFF) != IV_LENGTH) return null
        val ivStart = body.size - TRAILER
        val iv = body.copyOfRange(ivStart, ivStart + IV_LENGTH)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(TAG_LENGTH * 8, iv))
            cipher.updateAAD(header)
            header + cipher.doFinal(body, 0, ivStart)
        } catch (_: AEADBadTagException) {
            null
        } catch (_: java.security.GeneralSecurityException) {
            null
        }
    }

    /** Result of [decryptWithRatchet]: the plaintext and the material that opened it. */
    public class Opened(public val plaintext: ByteArray, public val material: ByteArray, public val ratchets: Int)

    /**
     * §3.1: a receiver that fails to decrypt tries up to [ratchetWindow]
     * forward ratchets of the key material before giving up on the frame
     * (→ `decrypt_failed`).
     */
    public fun decryptWithRatchet(
        frame: ByteArray,
        codec: E2eeCodec,
        keyframe: Boolean,
        material: ByteArray,
        ratchetWindow: Int = 8,
    ): Opened? {
        var candidate = material
        for (step in 0..ratchetWindow) {
            decrypt(frame, codec, keyframe, E2eeKeyDerivation.aesKeyFromMaterial(candidate))?.let { return Opened(it, candidate, step) }
            candidate = E2eeKeyDerivation.ratchet(candidate)
        }
        return null
    }

    private fun putU32(target: ByteArray, offset: Int, value: Long) {
        target[offset] = (value ushr 24).toByte()
        target[offset + 1] = (value ushr 16).toByte()
        target[offset + 2] = (value ushr 8).toByte()
        target[offset + 3] = value.toByte()
    }
}

/** H.264 emulation prevention (ITU-T H.264 §7.4.1): `00 00 0x` (x ≤ 3) ↔ `00 00 03 0x`. */
internal object Rbsp {
    fun escape(data: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream(data.size + data.size / 64 + 4)
        var zeros = 0
        for (b in data) {
            val v = b.toInt() and 0xFF
            if (zeros >= 2 && v <= 3) {
                out.write(3)
                zeros = 0
            }
            out.write(v)
            zeros = if (v == 0) zeros + 1 else 0
        }
        return out.toByteArray()
    }

    fun unescape(data: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream(data.size)
        var zeros = 0
        for (b in data) {
            val v = b.toInt() and 0xFF
            if (zeros >= 2 && v == 3) {
                zeros = 0
                continue
            }
            out.write(v)
            zeros = if (v == 0) zeros + 1 else 0
        }
        return out.toByteArray()
    }
}
