package com.swalvo.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

import java.time.Duration;
import java.util.Locale;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class SwalvoClientTest {

    private static final String SECRET_KEY = "rvk_super-secret-value.dontleakme";

    @AfterEach
    void clearEnvProperty() {
        System.clearProperty("swalvo.env");
        System.clearProperty("livqeno.env");
    }

    @Test
    void requiresAnApiKey() {
        SwalvoException missing = assertThrows(SwalvoException.class, () -> Swalvo.builder().build());
        assertEquals("RAVEN_INVALID_CONFIG", missing.getCode());
        assertTrue(missing.getMessage().contains("apiKey is required"));
        assertEquals(null, missing.getStatusCode());

        SwalvoException blank = assertThrows(SwalvoException.class, () -> Swalvo.builder().apiKey("  ").build());
        assertEquals("RAVEN_INVALID_CONFIG", blank.getCode());
    }

    @Test
    void neverReadsTheApiKeyFromTheEnvironmentImplicitly() {
        System.setProperty("SWALVO_API_KEY", "should-never-be-read-implicitly");
        try {
            assertThrows(SwalvoException.class, () -> Swalvo.builder().baseUrl("https://api.example.test").build());
        } finally {
            System.clearProperty("SWALVO_API_KEY");
        }
    }

    @Test
    void rejectsInvalidTimeoutRetriesAndBaseUrl() {
        assertEquals("RAVEN_INVALID_CONFIG", assertThrows(SwalvoException.class,
                () -> Swalvo.builder().apiKey("k").baseUrl("https://x.test").timeout(Duration.ZERO).build()).getCode());
        assertEquals("RAVEN_INVALID_CONFIG", assertThrows(SwalvoException.class,
                () -> Swalvo.builder().apiKey("k").baseUrl("https://x.test").maxRetries(-1).build()).getCode());
        assertEquals("RAVEN_INVALID_CONFIG", assertThrows(SwalvoException.class,
                () -> Swalvo.builder().apiKey("k").baseUrl("ftp://x.test").build()).getCode());
    }

    @Test
    void requiresBaseUrlInProduction() {
        System.setProperty("swalvo.env", "production");
        SwalvoException e = assertThrows(SwalvoException.class, () -> Swalvo.builder().apiKey("k").build());
        assertEquals("RAVEN_INVALID_CONFIG", e.getCode());
        assertTrue(e.getMessage().contains("baseUrl is required outside local development"));

        Swalvo explicit = Swalvo.builder().apiKey("k").baseUrl("https://api.livqeno.com").build();
        assertEquals("https://api.livqeno.com", explicit.baseUrl());
    }

    @Test
    void honoursTheLegacyEnvSystemProperty() {
        System.setProperty("livqeno.env", "production");
        SwalvoException e = assertThrows(SwalvoException.class, () -> Swalvo.builder().apiKey("k").build());
        assertEquals("RAVEN_INVALID_CONFIG", e.getCode());
    }

    @Test
    void defaultsToLocalhostOutsideProduction() {
        assumeFalse(isProd(System.getenv("NODE_ENV")) || isProd(System.getenv("SWALVO_ENV"))
                || isProd(System.getenv("RAVEN_ENV")) || isProd(System.getenv("LIVQENO_ENV")),
                "host environment is marked production");
        Swalvo client = Swalvo.builder().apiKey("k").build();
        assertEquals("http://localhost:4100", client.baseUrl());
        assertEquals("Swalvo(http://localhost:4100)", client.toString());
    }

    @Test
    void trimsTrailingSlashesFromBaseUrl() {
        assertEquals("https://api.livqeno.com",
                Swalvo.builder().apiKey("k").baseUrl("https://api.livqeno.com///").build().baseUrl());
    }

    @Test
    void exposesEveryResource() {
        Swalvo client = Swalvo.builder().apiKey("k").baseUrl("https://api.example.test").build();
        assertNotNull(client.projects());
        assertNotNull(client.tokens());
        assertNotNull(client.rooms());
        assertNotNull(client.rooms().participants());
        assertNotNull(client.connections());
        assertNotNull(client.errors());
        assertNotNull(client.metrics());
        assertNotNull(client.diagnostics());
        assertNotNull(client.chat());
        assertNotNull(client.liveStreams());
        assertNotNull(client.liveStreams().stage());
        assertNotNull(client.liveStreams().restreams());
        assertNotNull(client.liveStreams().ingress());
        assertSame(client.liveStreams(), client.live());
    }

    @Test
    void toStringNeverIncludesTheApiKey() {
        Swalvo.Builder builder = Swalvo.builder().apiKey(SECRET_KEY).baseUrl("https://api.example.test");
        Swalvo client = builder.build();
        assertFalse(client.toString().contains("dontleakme"));
        assertFalse(client.toString().contains("rvk_super"));
        assertFalse(builder.toString().contains("dontleakme"));
        assertFalse(String.valueOf(client.rooms()).contains("dontleakme"));
    }

    private static boolean isProd(String value) {
        return value != null && value.trim().toLowerCase(Locale.ROOT).equals("production");
    }
}
