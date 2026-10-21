package com.swalvo.server.webhooks;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class WebhookVerifierTest {

    private static final String SECRET = "whsec_test";
    private static final String BODY = "{\"type\":\"live_stream.started\",\"data\":{\"streamId\":\"stream_1\"}}";
    private static final long NOW = 1_790_000_000L;

    @Test
    void exposesTheHeaderNames() {
        assertEquals("raven-signature", WebhookVerifier.SIGNATURE_HEADER);
        assertEquals("raven-event-id", WebhookVerifier.EVENT_ID_HEADER);
        assertEquals("raven-event-type", WebhookVerifier.EVENT_TYPE_HEADER);
        assertEquals(300, WebhookVerifier.DEFAULT_TOLERANCE_SECONDS);
        assertEquals("swalvo-signature", WebhookVerifier.SWALVO_SIGNATURE_HEADER);
        assertEquals("swalvo-event-id", WebhookVerifier.SWALVO_EVENT_ID_HEADER);
        assertEquals("swalvo-event-type", WebhookVerifier.SWALVO_EVENT_TYPE_HEADER);
    }

    @Test
    void signatureHeaderPrefersSwalvoAndFallsBackToLegacy() {
        java.util.Map<String, String> both = java.util.Map.of("swalvo-signature", "new", "raven-signature", "old");
        assertEquals("new", WebhookVerifier.signatureHeader(both::get));
        java.util.Map<String, String> legacy = java.util.Map.of("raven-signature", "old");
        assertEquals("old", WebhookVerifier.signatureHeader(legacy::get));
        assertEquals(null, WebhookVerifier.signatureHeader(name -> null));
    }

    @Test
    void matchesTheApiSigningSchemeExactly() {
        // HMAC-SHA256("whsec_test", "1790000000." + BODY), computed independently with openssl.
        String header = WebhookVerifier.sign(BODY, SECRET, NOW);
        assertTrue(header.startsWith("t=1790000000,v1="));
        assertEquals(64, header.substring(header.indexOf("v1=") + 3).length());
        assertEquals(EXPECTED_HEADER, header);
    }

    @Test
    void acceptsAValidSignature() {
        String header = WebhookVerifier.sign(BODY, SECRET, NOW);
        assertTrue(WebhookVerifier.verify(BODY, header, SECRET, NOW, 300));
        assertTrue(WebhookVerifier.verify(BODY.getBytes(StandardCharsets.UTF_8), header, SECRET, NOW + 299, 300));
        assertTrue(WebhookVerifier.verify(BODY, " t=" + NOW + " , v1=" + header.split("v1=")[1] + " ", SECRET, NOW, 300));
    }

    @Test
    void acceptsAFreshSignatureWithTheDefaultClock() {
        long now = System.currentTimeMillis() / 1000;
        assertTrue(WebhookVerifier.verify(BODY, WebhookVerifier.sign(BODY, SECRET, now), SECRET));
    }

    @Test
    void rejectsATamperedBodySignatureOrSecret() {
        String header = WebhookVerifier.sign(BODY, SECRET, NOW);
        assertFalse(WebhookVerifier.verify(BODY.replace("stream_1", "stream_2"), header, SECRET, NOW, 300));
        assertFalse(WebhookVerifier.verify(BODY, header, "whsec_other", NOW, 300));
        String sig = header.split("v1=")[1];
        String flipped = (sig.charAt(0) == 'a' ? 'b' : 'a') + sig.substring(1);
        assertFalse(WebhookVerifier.verify(BODY, "t=" + NOW + ",v1=" + flipped, SECRET, NOW, 300));
        // A fresher timestamp bolted onto an old signature doesn't match: t is inside the signed payload.
        assertFalse(WebhookVerifier.verify(BODY, "t=" + (NOW + 10) + ",v1=" + sig, SECRET, NOW + 10, 300));
    }

    @Test
    void rejectsAnExpiredOrFutureTimestamp() {
        String header = WebhookVerifier.sign(BODY, SECRET, NOW);
        assertFalse(WebhookVerifier.verify(BODY, header, SECRET, NOW + 301, 300));
        assertFalse(WebhookVerifier.verify(BODY, header, SECRET, NOW - 301, 300));
        long now = System.currentTimeMillis() / 1000;
        assertFalse(WebhookVerifier.verify(BODY, WebhookVerifier.sign(BODY, SECRET, now - 600), SECRET));
    }

    @Test
    void rejectsMalformedHeaders() {
        assertFalse(WebhookVerifier.verify(BODY, null, SECRET, NOW, 300));
        assertFalse(WebhookVerifier.verify(BODY, "", SECRET, NOW, 300));
        assertFalse(WebhookVerifier.verify(BODY, "v1=abc", SECRET, NOW, 300));
        assertFalse(WebhookVerifier.verify(BODY, "t=" + NOW, SECRET, NOW, 300));
        assertFalse(WebhookVerifier.verify(BODY, "t=abc,v1=abc", SECRET, NOW, 300));
        assertFalse(WebhookVerifier.verify(BODY, WebhookVerifier.sign(BODY, SECRET, NOW), "", NOW, 300));
        assertFalse(WebhookVerifier.verify((String) null, WebhookVerifier.sign(BODY, SECRET, NOW), SECRET, NOW, 300));
    }

    static final String EXPECTED_HEADER =
            "t=1790000000,v1=6a9a2b45837298a828ab9f088c9ec29187e9b6733689caddf23ccc2b0e90fb20";
}
