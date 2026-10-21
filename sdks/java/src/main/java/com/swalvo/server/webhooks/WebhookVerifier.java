package com.swalvo.server.webhooks;

import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Verifies a Swalvo webhook delivery.
 *
 * <p>Every delivery carries {@value #SWALVO_SIGNATURE_HEADER} (and its identical legacy twin
 * {@value #SIGNATURE_HEADER}): {@code t=<unix seconds>,v1=<hex HMAC-SHA256>}, where
 * the HMAC is keyed with your endpoint's signing secret over {@code "<t>.<raw body>"}. The timestamp is inside
 * the signed payload, so a captured delivery can't be replayed later with a fresher timestamp; anything older
 * than {@value #DEFAULT_TOLERANCE_SECONDS} seconds is rejected.
 *
 * <p>Verify against the <b>raw</b> request body, byte for byte, before any JSON parsing:
 *
 * <pre>{@code
 * boolean ok = WebhookVerifier.verify(rawBody, WebhookVerifier.signatureHeader(request::getHeader), secret);
 * if (!ok) return 400;
 * String eventType = request.getHeader(WebhookVerifier.SWALVO_EVENT_TYPE_HEADER);
 * String eventId = request.getHeader(WebhookVerifier.SWALVO_EVENT_ID_HEADER); // dedupe retries on this
 * }</pre>
 */
public final class WebhookVerifier {

    /** Carries {@code t=<unix seconds>,v1=<hex hmac>}. */
    public static final String SWALVO_SIGNATURE_HEADER = "swalvo-signature";
    /** A unique id per event, stable across redeliveries. Use it to deduplicate. */
    public static final String SWALVO_EVENT_ID_HEADER = "swalvo-event-id";
    /** The event type, e.g. {@code live_stream.viewer_joined}. */
    public static final String SWALVO_EVENT_TYPE_HEADER = "swalvo-event-type";
    // legacy: kept for wire compatibility — the pre-rename twins of the headers above.
    /** Legacy twin of {@link #SWALVO_SIGNATURE_HEADER}. */
    public static final String SIGNATURE_HEADER = "raven-signature";
    /** Legacy twin of {@link #SWALVO_EVENT_ID_HEADER}. */
    public static final String EVENT_ID_HEADER = "raven-event-id";
    /** Legacy twin of {@link #SWALVO_EVENT_TYPE_HEADER}. */
    public static final String EVENT_TYPE_HEADER = "raven-event-type";
    /** How far a timestamp may drift, either way, before a delivery is rejected. */
    public static final long DEFAULT_TOLERANCE_SECONDS = 300;

    private WebhookVerifier() {}

    /**
     * Picks the signature header from a request: {@value #SWALVO_SIGNATURE_HEADER}, falling back to the legacy
     * {@value #SIGNATURE_HEADER}. Pass a header lookup such as {@code request::getHeader}.
     */
    public static String signatureHeader(java.util.function.UnaryOperator<String> headerLookup) {
        String value = headerLookup.apply(SWALVO_SIGNATURE_HEADER);
        if (value == null || value.isBlank()) {
            value = headerLookup.apply(SIGNATURE_HEADER);
        }
        return value;
    }

    /** Verifies against the current time with the default 300 s tolerance. */
    public static boolean verify(String rawBody, String signatureHeader, String secret) {
        return verify(rawBody, signatureHeader, secret, nowSeconds(), DEFAULT_TOLERANCE_SECONDS);
    }

    /** Verifies a raw body given as bytes (preferred: no charset round trip). */
    public static boolean verify(byte[] rawBody, String signatureHeader, String secret) {
        return verify(rawBody, signatureHeader, secret, nowSeconds(), DEFAULT_TOLERANCE_SECONDS);
    }

    public static boolean verify(
            String rawBody, String signatureHeader, String secret, long nowSeconds, long toleranceSeconds) {
        if (rawBody == null) return false;
        return verify(rawBody.getBytes(StandardCharsets.UTF_8), signatureHeader, secret, nowSeconds, toleranceSeconds);
    }

    /**
     * @return true only when the header is well formed, its timestamp is within {@code toleranceSeconds} of
     *     {@code nowSeconds}, and its {@code v1} signature matches (compared in constant time).
     */
    public static boolean verify(
            byte[] rawBody, String signatureHeader, String secret, long nowSeconds, long toleranceSeconds) {
        if (rawBody == null || signatureHeader == null || secret == null || secret.isEmpty()) {
            return false;
        }
        Map<String, String> parts = new HashMap<>();
        for (String part : signatureHeader.split(",")) {
            String[] pair = part.trim().split("=", -1);
            if (pair.length == 2) {
                parts.put(pair[0], pair[1]);
            }
        }
        String provided = parts.get("v1");
        long timestamp;
        try {
            timestamp = Long.parseLong(parts.getOrDefault("t", ""));
        } catch (NumberFormatException e) {
            return false;
        }
        if (provided == null || provided.isEmpty()) {
            return false;
        }
        if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
            return false;
        }
        String expected = hmacHex(secret, timestamp, rawBody);
        return MessageDigest.isEqual(
                provided.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Produces a {@value #SIGNATURE_HEADER} value exactly as Swalvo does. Useful for testing your own
     * webhook endpoint.
     */
    public static String sign(String rawBody, String secret, long timestampSeconds) {
        return "t=" + timestampSeconds + ",v1="
                + hmacHex(secret, timestampSeconds, rawBody.getBytes(StandardCharsets.UTF_8));
    }

    private static String hmacHex(String secret, long timestamp, byte[] rawBody) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            mac.update((timestamp + ".").getBytes(StandardCharsets.UTF_8));
            byte[] digest = mac.doFinal(rawBody);
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new IllegalStateException("HmacSHA256 is unavailable", e);
        }
    }

    private static long nowSeconds() {
        return System.currentTimeMillis() / 1000L;
    }
}
