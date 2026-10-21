package io.swalvo.rtc

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.swalvo.rtc.e2ee.E2eeKeyDerivation
import io.swalvo.rtc.internal.media.RtcFactory
import org.junit.Assert.assertArrayEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.webrtc.FrameCryptorFactory
import org.webrtc.FrameCryptorKeyDerivationAlgorithm

/**
 * DEVICE / EMULATOR ONLY (`./gradlew :swalvo-rtc:connectedDebugAndroidTest`).
 * Not run in CI here: it needs libwebrtc's native library.
 *
 * Proves the assumption [io.swalvo.rtc.e2ee.E2eeManager] rests on: that
 * webrtc-sdk's native key provider, configured with HKDF and the
 * "LivqenoRatchet" salt, ratchets key material exactly like the pure-Kotlin
 * schedule the cross-SDK vectors pin down.
 */
@RunWith(AndroidJUnit4::class)
class NativeE2eeKeyProviderTest {

    @Test
    fun nativeRatchetMatchesTheSharedSchedule() {
        RtcFactory.get(InstrumentationRegistry.getInstrumentation().targetContext)
        val provider = FrameCryptorFactory.createFrameCryptorKeyProvider(
            true,
            E2eeKeyDerivation.RATCHET_SALT.toByteArray(),
            8,
            ByteArray(0),
            -1,
            16,
            true,
            FrameCryptorKeyDerivationAlgorithm.HKDF,
        )
        try {
            val material = E2eeKeyDerivation.materialFromPassphrase("correct horse battery staple", "room_e2ee_vectors")
            provider.setSharedKey(0, material)
            assertArrayEquals(material, provider.exportSharedKey(0))

            val nativeNext = provider.ratchetSharedKey(0)
            assertArrayEquals(E2eeKeyDerivation.ratchet(material), nativeNext)
        } finally {
            provider.dispose()
        }
    }
}
