package io.swalvo.rtc.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenClaimsTest {
    private fun token(payload: String) = "e30.${Base64Url.encode(payload.toByteArray())}.sig"

    @Test
    fun readsPhase7MetadataClaims() {
        val claims = TokenClaims.decode(
            token("""{"sub":"alice","rid":"r","md":"{\"role\":\"host\"}","attrs":{"team":"blue","n":1},"perms":{"publishData":true,"updateOwnMetadata":true}}"""),
        )
        assertEquals("{\"role\":\"host\"}", claims.metadata)
        assertEquals(mapOf("team" to "blue"), claims.attributes)
        assertTrue(claims.permissions!!.updateOwnMetadata)
    }

    @Test
    fun metadataGrantDefaultsToFalse() {
        val claims = TokenClaims.decode(token("""{"sub":"alice","perms":{"publish":true}}"""))
        assertFalse(claims.permissions!!.updateOwnMetadata)
        assertNull(claims.metadata)
        assertEquals(emptyMap<String, String>(), claims.attributes)
    }
}
