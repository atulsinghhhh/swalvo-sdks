package com.swalvo.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.swalvo.server.model.ConnectionSummaryState;
import com.swalvo.server.model.ListConnectionsParams;
import com.swalvo.server.model.ListLiveStreamsParams;
import com.swalvo.server.model.LiveStreamStatus;
import com.swalvo.server.model.MetricsRange;
import com.swalvo.server.model.Room;
import java.net.ServerSocket;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class HttpBehaviourTest {

    private static final String SECRET_KEY = "rvk_super-secret-value.dontleakme";
    private MockServer server;

    @BeforeEach
    void start() throws Exception {
        server = new MockServer();
    }

    @AfterEach
    void stop() {
        server.close();
    }

    @Test
    void sendsBearerAuthAndAUserAgentNamingTheSdk() {
        server.respond(200, "[]");
        server.client("rvk_abc.secret").rooms().list();

        MockServer.Recorded req = server.last();
        assertEquals("GET", req.method());
        assertEquals("/v1/rooms", req.path());
        assertEquals("Bearer rvk_abc.secret", req.header("Authorization"));
        assertEquals("Swalvo-Server-SDK/" + Swalvo.VERSION + " (java)", req.header("User-Agent"));
        assertEquals("application/json", req.header("Content-Type"));
    }

    @Test
    void encodesQueryParamsLikeUrlSearchParamsAndOmitsNulls() {
        server.respond(200, "[]");
        server.client().connections().list(ListConnectionsParams.builder()
                .roomId("room 1&x=é/?")
                .state(ConnectionSummaryState.CONNECTED)
                .limit(25)
                .build());
        assertEquals("roomId=room+1%26x%3D%C3%A9%2F%3F&state=CONNECTED&limit=25", server.last().rawQuery());

        server.respond(200, "[]");
        server.client().connections().list(ListConnectionsParams.builder().limit(5).build());
        assertEquals("limit=5", server.last().rawQuery());

        server.respond(200, "[]");
        server.client().connections().list();
        assertNull(server.last().rawQuery());
    }

    @Test
    void encodesEnumQueryValuesAsTheirWireValue() {
        server.respond(200, "{\"range\":\"15m\",\"activeRooms\":1,\"activeParticipants\":2,\"connections\":3,\"errors\":0}");
        server.client().metrics().get(MetricsRange.LAST_15_MINUTES);
        assertEquals("/v1/metrics?range=15m", server.last().pathAndQuery());

        server.respond(200, "[]");
        server.client().liveStreams().list(ListLiveStreamsParams.withStatus(LiveStreamStatus.LIVE));
        assertEquals("/v1/live-streams?status=LIVE", server.last().pathAndQuery());
    }

    @Test
    void encodesPathSegmentsLikeEncodeUriComponent() {
        server.respond(204, null);
        server.client().liveStreams().restreams().delete("stream/1", "rst 1");
        assertEquals("/v1/live-streams/stream%2F1/restreams/rst%201", server.last().path());
    }

    @Test
    void returnsNullForA204WithoutParsing() {
        server.respond(204, null);
        server.client().rooms().delete("room_1");
        assertEquals("DELETE", server.last().method());
        assertEquals("", server.last().body());
    }

    @Test
    void decodesResponsesIntoRecordsAndToleratesUnknownFieldsAndEnumValues() {
        server.respond(200, "{\"id\":\"r1\",\"projectId\":\"p1\",\"name\":\"lobby\",\"status\":\"HIBERNATING\","
                + "\"e2ee\":true,\"createdAt\":\"2026-01-01T00:00:00Z\",\"updatedAt\":\"2026-01-01T00:00:00Z\",\"newField\":1}");
        Room room = server.client().rooms().get("r1");
        assertEquals("r1", room.id());
        assertEquals("lobby", room.name());
        assertEquals(com.swalvo.server.model.RoomStatus.UNRECOGNIZED, room.status());
        assertEquals(Boolean.TRUE, room.e2ee());
    }

    @Test
    void retriesA503ThenSucceeds() {
        server.respond(503, "{}").respond(503, "{}").respond(200, "[]");
        List<Room> rooms = server.client().rooms().list();
        assertEquals(List.of(), rooms);
        assertEquals(3, server.requests().size());
    }

    @Test
    void retriesA429() {
        server.respond(429, "{\"code\":\"RAVEN_RATE_LIMITED\",\"message\":\"slow down\"}").respond(200, "[]");
        server.client().rooms().list();
        assertEquals(2, server.requests().size());
    }

    @Test
    void retriesPostsToo() {
        server.respond(502, "").respond(201, "{\"id\":\"r1\",\"name\":\"lobby\"}");
        assertEquals("r1", server.client().rooms().create("lobby").id());
        assertEquals(2, server.requests().size());
        assertEquals(server.requests().get(0).body(), server.requests().get(1).body());
    }

    @Test
    void givesUpAfterMaxRetries() {
        server.respond(503, "{}").respond(503, "{}").respond(503, "{\"code\":\"RAVEN_CAPACITY_EXCEEDED\",\"message\":\"busy\"}");
        SwalvoException e = assertThrows(SwalvoException.class, () -> server.client().rooms().list());
        assertEquals("RAVEN_CAPACITY_EXCEEDED", e.getCode());
        assertEquals(503, e.getStatusCode());
        assertEquals(3, server.requests().size());
    }

    @Test
    void neverRetriesA400() {
        server.respond(400, "{\"code\":\"VALIDATION_FAILED\",\"message\":[\"name must be a string\",\"name too long\"]}");
        SwalvoException e = assertThrows(SwalvoException.class, () -> server.client().rooms().create("x"));
        assertEquals("VALIDATION_FAILED", e.getCode());
        assertEquals("name must be a string; name too long", e.getMessage());
        assertEquals(1, server.requests().size());
    }

    @ParameterizedTest
    @CsvSource({"401", "403", "404", "409"})
    void neverRetriesOtherClientErrors(int status) {
        server.respond(status, "{\"message\":\"no\"}");
        assertThrows(SwalvoException.class, () -> server.client().rooms().list());
        assertEquals(1, server.requests().size());
    }

    @Test
    void respectsMaxRetriesZero() {
        server.respond(503, "{}");
        Swalvo client = Swalvo.builder().apiKey("k").baseUrl(server.url()).maxRetries(0).build();
        assertThrows(SwalvoException.class, () -> client.rooms().list());
        assertEquals(1, server.requests().size());
    }

    @Test
    void timesOutInsteadOfHanging() {
        server.respondAfter(Duration.ofSeconds(3), 200, "[]");
        Swalvo client = Swalvo.builder().apiKey("k").baseUrl(server.url())
                .timeout(Duration.ofMillis(200)).maxRetries(0).build();
        long started = System.nanoTime();
        SwalvoException e = assertThrows(SwalvoException.class, () -> client.rooms().list());
        long elapsedMs = (System.nanoTime() - started) / 1_000_000;
        assertEquals("RAVEN_TIMEOUT", e.getCode());
        assertEquals("Request timed out after 200ms", e.getMessage());
        assertTrue(elapsedMs < 2500, "took " + elapsedMs + "ms");
    }

    @Test
    void retriesATimeoutLikeTheTypeScriptClient() {
        server.respondAfter(Duration.ofSeconds(3), 200, "[]").respond(200, "[]");
        Swalvo client = Swalvo.builder().apiKey("k").baseUrl(server.url())
                .timeout(Duration.ofMillis(200)).maxRetries(1).build();
        assertEquals(List.of(), client.rooms().list());
        assertEquals(2, server.requests().size());
    }

    @Test
    void mapsAnUnreachableHostToNetworkError() throws Exception {
        int port;
        try (ServerSocket socket = new ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        Swalvo client = Swalvo.builder().apiKey("k").baseUrl("http://127.0.0.1:" + port).maxRetries(0).build();
        SwalvoException e = assertThrows(SwalvoException.class, () -> client.rooms().list());
        assertEquals("RAVEN_NETWORK_ERROR", e.getCode());
        assertEquals("Could not reach the Swalvo API", e.getMessage());
        assertNull(e.getStatusCode());
        assertInstanceOf(java.io.IOException.class, e.getCause());
    }

    @Test
    void passesTheApiCodeMessageRequestIdAndDetailsThrough() {
        server.respond(404, "{\"code\":\"RAVEN_ROOM_NOT_FOUND\",\"message\":\"Room not found\",\"roomId\":\"x\"}",
                Map.of("x-request-id", "req_abc123"));
        SwalvoException e = assertThrows(SwalvoException.class, () -> server.client().rooms().get("x"));
        assertEquals("RAVEN_ROOM_NOT_FOUND", e.getCode());
        assertEquals(404, e.getStatusCode());
        assertEquals("Room not found", e.getMessage());
        assertEquals("req_abc123", e.getRequestId());
        assertEquals(Map.of("code", "RAVEN_ROOM_NOT_FOUND", "message", "Room not found", "roomId", "x"), e.getDetails());
        assertTrue(e.toString().contains("RAVEN_ROOM_NOT_FOUND"));
    }

    @ParameterizedTest
    @CsvSource({
        "401, RAVEN_AUTH_ERROR",
        "403, RAVEN_PERMISSION_DENIED",
        "404, RAVEN_NOT_FOUND",
        "429, RAVEN_RATE_LIMITED",
        "503, RAVEN_INTERNAL_ERROR",
        "500, RAVEN_INTERNAL_ERROR",
        "422, VALIDATION_ERROR"
    })
    void derivesTheCodeFromTheStatusWhenAProxyEatsTheBody(int status, String expected) {
        server.respond(status, "<html>Gateway error</html>");
        Swalvo client = Swalvo.builder().apiKey("k").baseUrl(server.url()).maxRetries(0).build();
        SwalvoException e = assertThrows(SwalvoException.class, () -> client.rooms().list());
        assertEquals(expected, e.getCode());
        assertEquals("Request failed with status " + status, e.getMessage());
        assertNull(e.getDetails());
    }

    @Test
    void neverPutsTheApiKeyInAnException() {
        server.respond(400, "{\"code\":\"VALIDATION_FAILED\",\"message\":\"bad header Bearer " + SECRET_KEY + "\","
                + "\"echo\":{\"authorization\":\"Bearer " + SECRET_KEY + "\"}}");
        SwalvoException e = assertThrows(SwalvoException.class, () -> server.client(SECRET_KEY).rooms().list());
        assertFalse(e.getMessage().contains("dontleakme"), e.getMessage());
        assertFalse(e.toString().contains("dontleakme"));
        assertFalse(String.valueOf(e.getDetails()).contains("dontleakme"));
        assertTrue(e.getMessage().contains("[REDACTED]"));

        server.respondAfter(Duration.ofSeconds(2), 200, "[]");
        Swalvo slow = Swalvo.builder().apiKey(SECRET_KEY).baseUrl(server.url())
                .timeout(Duration.ofMillis(100)).maxRetries(0).build();
        SwalvoException timeout = assertThrows(SwalvoException.class, () -> slow.rooms().list());
        assertFalse(timeout.toString().contains("dontleakme"));
        assertFalse(String.valueOf(timeout.getCause()).contains("dontleakme"));
    }
}
