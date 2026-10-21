package io.swalvo.rtc.e2ee

import io.swalvo.rtc.E2eeState
import org.webrtc.FrameCryptor
import org.webrtc.FrameCryptorAlgorithm
import org.webrtc.FrameCryptorFactory
import org.webrtc.FrameCryptorKeyDerivationAlgorithm
import org.webrtc.FrameCryptorKeyProvider
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender

/**
 * End-to-end encryption options (phase5 §3). Pass to `SwalvoClientOptions.e2ee`.
 *
 * Exactly one key mode:
 * - **Shared passphrase** ([passphrase]): every participant derives the same
 *   key, PBKDF2-SHA256 / 100k / salt `"LivqenoE2EE:" + roomId`.
 * - **Per-participant keys** ([passphrase] null): the app distributes keys over
 *   its own channel and calls `room.e2ee.setKey(participantId, key, keyIndex)`.
 */
public class E2eeOptions(
    public val passphrase: String? = null,
    /** Forward ratchets a receiver tries before giving up on a frame (§3.1, default 8). */
    public val ratchetWindow: Int = 8,
    /** Consecutive decrypt failures tolerated before `decrypt_failed` is reported; -1 = report every one. */
    public val failureTolerance: Int = -1,
    public val keyRingSize: Int = 16,
)

/**
 * Wires libwebrtc's FrameCryptor (webrtc-sdk's frame crypto: AES-GCM-128 with
 * the §3.2 trailer `[IV][0x0c][keyIndex]`) onto every sender and receiver of
 * an E2EE room.
 *
 * The native key provider is configured with `keyDerivationAlgorithm = HKDF`
 * and `ratchetSalt = "LivqenoRatchet"`, so given 32 bytes of key *material*
 * it derives the AES key and ratchets exactly as
 * docs/architecture/e2ee-vectors.json specifies (and as the web SDK does in
 * WebCrypto). The SDK therefore only ever hands it material:
 * - passphrase mode: [E2eeKeyDerivation.materialFromPassphrase] (PBKDF2, done in Kotlin);
 * - per-participant mode: whatever 32 bytes your app distributes ([setKey]).
 *
 * Encryption only engages when the room requires it (token claim `e2ee` or
 * `room.joined.e2ee`); configured E2EE in a plain room sends media as usual,
 * like the web SDK.
 */
public class E2eeManager internal constructor(
    private val factory: PeerConnectionFactory,
    private val roomId: String,
    private val options: E2eeOptions,
    private val onState: (participantId: String, state: E2eeState) -> Unit,
) {
    private val keyProvider: FrameCryptorKeyProvider = FrameCryptorFactory.createFrameCryptorKeyProvider(
        /* sharedKey = */ options.passphrase != null,
        /* ratchetSalt = */ E2eeKeyDerivation.RATCHET_SALT.toByteArray(Charsets.UTF_8),
        /* ratchetWindowSize = */ options.ratchetWindow,
        /* uncryptedMagicBytes = */ "LK-ROCKS".toByteArray(Charsets.UTF_8),
        /* failureTolerance = */ options.failureTolerance,
        /* keyRingSize = */ options.keyRingSize,
        /* discardFrameWhenCryptorNotReady = */ true,
        FrameCryptorKeyDerivationAlgorithm.HKDF,
    )

    private val cryptors = mutableListOf<Pair<String, FrameCryptor>>()
    private var currentKeyIndex = 0

    init {
        // PBKDF2 over 100k iterations: tens of milliseconds on a phone, done once per room.
        options.passphrase?.let { keyProvider.setSharedKey(0, E2eeKeyDerivation.materialFromPassphrase(it, roomId)) }
    }

    /**
     * Per-participant mode: install 32 bytes of key [material] for
     * [participantId] (your own identity for what you send) at [keyIndex],
     * and start using that index.
     */
    public fun setKey(participantId: String, material: ByteArray, keyIndex: Int = 0) {
        keyProvider.setKey(participantId, keyIndex, material)
        synchronized(cryptors) {
            currentKeyIndex = keyIndex
            cryptors.filter { it.first == participantId }.forEach { it.second.keyIndex = keyIndex }
        }
    }

    /** Shared mode: switch to a new passphrase at [keyIndex]. */
    public fun setPassphrase(passphrase: String, keyIndex: Int = 0): Unit =
        setSharedKey(E2eeKeyDerivation.materialFromPassphrase(passphrase, roomId), keyIndex)

    /** Shared mode: replace the shared 32-byte material at [keyIndex]. */
    public fun setSharedKey(material: ByteArray, keyIndex: Int = 0) {
        keyProvider.setSharedKey(keyIndex, material)
        synchronized(cryptors) {
            currentKeyIndex = keyIndex
            cryptors.forEach { it.second.keyIndex = keyIndex }
        }
    }

    /** Ratchets the key forward one step (HKDF, see [E2eeKeyDerivation.ratchet]); returns the new material. */
    public fun ratchetKey(participantId: String? = null): ByteArray? =
        if (participantId == null || options.passphrase != null) {
            keyProvider.ratchetSharedKey(currentKeyIndex)
        } else {
            keyProvider.ratchetKey(participantId, currentKeyIndex)
        }

    internal fun attachSender(sender: RtpSender, localIdentity: String): FrameCryptor =
        track(localIdentity, FrameCryptorFactory.createFrameCryptorForRtpSender(factory, sender, localIdentity, FrameCryptorAlgorithm.AES_GCM, keyProvider))

    internal fun attachReceiver(receiver: RtpReceiver, participantId: String): FrameCryptor =
        track(participantId, FrameCryptorFactory.createFrameCryptorForRtpReceiver(factory, receiver, participantId, FrameCryptorAlgorithm.AES_GCM, keyProvider))

    private fun track(participantId: String, cryptor: FrameCryptor): FrameCryptor {
        cryptor.setObserver { pid, state -> mapState(state)?.let { onState(pid, it) } }
        synchronized(cryptors) {
            cryptor.keyIndex = currentKeyIndex
            cryptors.add(participantId to cryptor)
        }
        cryptor.setEnabled(true)
        return cryptor
    }

    internal fun release(cryptor: FrameCryptor) {
        synchronized(cryptors) { cryptors.removeAll { it.second === cryptor } }
        try {
            cryptor.dispose()
        } catch (_: Throwable) {
        }
    }

    internal fun dispose() {
        synchronized(cryptors) {
            cryptors.forEach { runCatching { it.second.dispose() } }
            cryptors.clear()
        }
        runCatching { keyProvider.dispose() }
    }

    private fun mapState(state: FrameCryptor.FrameCryptionState): E2eeState? = when (state) {
        FrameCryptor.FrameCryptionState.OK -> E2eeState.OK
        FrameCryptor.FrameCryptionState.ENCRYPTIONFAILED -> E2eeState.ENCRYPT_FAILED
        FrameCryptor.FrameCryptionState.DECRYPTIONFAILED -> E2eeState.DECRYPT_FAILED
        FrameCryptor.FrameCryptionState.MISSINGKEY -> E2eeState.MISSING_KEY
        FrameCryptor.FrameCryptionState.KEYRATCHETED -> E2eeState.KEY_RATCHETED
        FrameCryptor.FrameCryptionState.INTERNALERROR -> E2eeState.INTERNAL_ERROR
        else -> null
    }
}
