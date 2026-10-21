package com.swalvo.server;

import static com.swalvo.server.MockServer.json;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.swalvo.server.model.ConnectionDetail;
import com.swalvo.server.model.CreateRoomParams;
import com.swalvo.server.model.CreateTokenParams;
import com.swalvo.server.model.DependencyStatus;
import com.swalvo.server.model.ErrorCategory;
import com.swalvo.server.model.ErrorDetail;
import com.swalvo.server.model.IssuedToken;
import com.swalvo.server.model.ListErrorsParams;
import com.swalvo.server.model.LiveParticipantInfo;
import com.swalvo.server.model.MetricsOverview;
import com.swalvo.server.model.MuteParticipantParams;
import com.swalvo.server.model.ParticipantPermissions;
import com.swalvo.server.model.Project;
import com.swalvo.server.model.ProjectDiagnostics;
import com.swalvo.server.model.ProjectStatus;
import com.swalvo.server.model.TokenPermissions;
import com.swalvo.server.model.TrackKind;
import com.swalvo.server.model.UpdateParticipantPermissionsParams;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class CoreResourcesTest {

    private MockServer server;
    private Swalvo client;

    @BeforeEach
    void start() throws Exception {
        server = new MockServer();
        client = server.client();
    }

    @AfterEach
    void stop() {
        server.close();
    }

    @Test
    void projectsGet() {
        server.respond(200, "{\"id\":\"p1\",\"name\":\"demo\",\"description\":null,\"status\":\"ACTIVE\",\"ownerId\":\"u1\"}");
        Project project = client.projects().get();
        assertEquals("GET /v1/project", server.last().method() + " " + server.last().path());
        assertEquals("demo", project.name());
        assertEquals(ProjectStatus.ACTIVE, project.status());
        assertNull(project.description());
    }

    @Test
    void tokensCreatePostsTheWireVocabulary() {
        server.respond(201, "{\"id\":\"tok_1\",\"token\":\"jwt\",\"endpoint\":\"wss://sfu\",\"roomId\":\"room-123\","
                + "\"participantIdentity\":\"user-42\",\"permissions\":{\"publishAudio\":true},"
                + "\"iceServers\":[{\"urls\":\"turn:t\",\"username\":\"u\",\"credential\":\"c\"}],\"telemetryUrl\":\"https://t\"}");
        IssuedToken token = client.tokens().create(CreateTokenParams.builder()
                .room("room-123")
                .identity("user-42")
                .permissions(TokenPermissions.builder().publishAudio(true).publishVideo(true).subscribe(true).build())
                .expiresIn(3600)
                .build());

        assertEquals("POST", server.last().method());
        assertEquals("/v1/rooms/room-123/rtc-tokens", server.last().path());
        assertEquals(json("{\"participantIdentity\":\"user-42\","
                + "\"permissions\":{\"subscribe\":true,\"publishAudio\":true,\"publishVideo\":true},"
                + "\"ttlSeconds\":3600}"), server.last().json());
        assertEquals("wss://sfu", token.endpoint());
        assertEquals(Boolean.TRUE, token.permissions().publishAudio());
        assertEquals("turn:t", token.iceServers().get(0).urls());
    }

    @Test
    void roomsCrud() {
        server.respond(200, "[{\"id\":\"r1\",\"name\":\"lobby\",\"status\":\"ACTIVE\"}]");
        assertEquals("lobby", client.rooms().list().get(0).name());
        assertEquals("/v1/rooms", server.last().path());

        server.respond(200, "{\"id\":\"r1\"}");
        client.rooms().get("r1");
        assertEquals("/v1/rooms/r1", server.last().path());

        server.respond(201, "{\"id\":\"r1\",\"name\":\"lobby\"}");
        client.rooms().create("lobby");
        assertEquals(json("{\"name\":\"lobby\"}"), server.last().json());

        server.respond(201, "{\"id\":\"r2\",\"name\":\"vault\",\"e2ee\":true}");
        var room = client.rooms().create(CreateRoomParams.builder().name("vault").getOrCreate(true).e2ee(true).build());
        assertEquals("POST", server.last().method());
        assertEquals(json("{\"name\":\"vault\",\"getOrCreate\":true,\"e2ee\":true}"), server.last().json());
        assertEquals(Boolean.TRUE, room.e2ee());

        server.respond(204, null);
        client.rooms().delete("r1");
        assertEquals("DELETE /v1/rooms/r1", server.last().method() + " " + server.last().path());
    }

    @Test
    void roomParticipantsDistinguishUnreachableFromEmpty() {
        server.respond(200, "[{\"identity\":\"alice\",\"joinedAt\":\"t\",\"tracks\":[{\"sid\":\"TR_1\",\"kind\":\"audio\",\"name\":\"mic\",\"muted\":false}]}]");
        Optional<List<LiveParticipantInfo>> live = client.rooms().participants().list("r1");
        assertEquals("/v1/rooms/r1/participants", server.last().path());
        assertEquals(TrackKind.AUDIO, live.orElseThrow().get(0).tracks().get(0).kind());

        server.respond(200, "null");
        assertTrue(client.rooms().participants().list("r1").isEmpty());

        server.respond(200, "[]");
        assertEquals(List.of(), client.rooms().participants().list("r1").orElseThrow());

        server.respond(200, "[{\"identity\":\"alice\",\"tracks\":[]},{\"identity\":\"bob\",\"tracks\":[]}]");
        assertEquals("bob", client.rooms().participants().get("r1", "bob").orElseThrow().identity());
        server.respond(200, "[{\"identity\":\"alice\",\"tracks\":[]}]");
        assertTrue(client.rooms().participants().get("r1", "carol").isEmpty());
    }

    private static final String NOT_CONNECTED =
            "{\"code\":\"RAVEN_PARTICIPANT_NOT_CONNECTED\",\"message\":\"Participant is not connected\",\"statusCode\":404}";

    @Test
    void participantsRemove() {
        server.respond(204, null);
        client.rooms().participants().remove("standup", "a b/c");
        assertEquals("POST /v1/rooms/standup/participants/a%20b%2Fc/remove", server.last().method() + " " + server.last().path());
        assertEquals(json("{}"), server.last().json());

        server.respond(404, NOT_CONNECTED);
        SwalvoException e = assertThrows(SwalvoException.class,
                () -> client.rooms().participants().remove("standup", "ghost"));
        assertEquals("RAVEN_PARTICIPANT_NOT_CONNECTED", e.getCode());
        assertEquals(404, e.getStatusCode());
    }

    @Test
    void participantsMute() {
        server.respond(204, null);
        client.rooms().participants().mute("r1", "a b/c",
                MuteParticipantParams.builder().kind(TrackKind.AUDIO).muted(false).build());
        assertEquals("POST /v1/rooms/r1/participants/a%20b%2Fc/mute", server.last().method() + " " + server.last().path());
        assertEquals(json("{\"kind\":\"audio\",\"muted\":false}"), server.last().json());

        server.respond(204, null);
        client.rooms().participants().mute("r1", "bob", MuteParticipantParams.builder().trackId("TR_1").muted(true).build());
        assertEquals(json("{\"trackId\":\"TR_1\",\"muted\":true}"), server.last().json());

        server.respond(404, "{\"code\":\"RAVEN_TRACK_NOT_FOUND\",\"message\":\"Track not found\",\"statusCode\":404}");
        SwalvoException e = assertThrows(SwalvoException.class, () -> client.rooms().participants()
                .mute("r1", "bob", MuteParticipantParams.builder().trackId("TR_x").muted(true).build()));
        assertEquals("RAVEN_TRACK_NOT_FOUND", e.getCode());
        assertEquals(404, e.getStatusCode());
    }

    @Test
    void participantsMuteRejectsBothOrNeitherBeforeSending() {
        int before = server.requests().size();
        assertThrows(IllegalArgumentException.class,
                () -> MuteParticipantParams.builder().trackId("TR_1").kind(TrackKind.VIDEO).muted(true).build());
        assertThrows(IllegalArgumentException.class, () -> MuteParticipantParams.builder().muted(true).build());
        assertThrows(IllegalArgumentException.class,
                () -> MuteParticipantParams.builder().kind(TrackKind.UNKNOWN).muted(true).build());
        assertThrows(IllegalArgumentException.class, () -> MuteParticipantParams.builder().kind(TrackKind.AUDIO).build());
        assertThrows(IllegalArgumentException.class, () -> UpdateParticipantPermissionsParams.builder().build());
        assertEquals(before, server.requests().size());
    }

    @Test
    void participantsUpdatePermissions() {
        server.respond(200, "{\"subscribe\":true,\"publish\":false,\"publishAudio\":false,\"publishVideo\":true,\"publishData\":true}");
        ParticipantPermissions perms = client.rooms().participants().updatePermissions("r1", "a b/c",
                UpdateParticipantPermissionsParams.builder().publish(false).publishData(true).build());
        assertEquals("PATCH /v1/rooms/r1/participants/a%20b%2Fc/permissions", server.last().method() + " " + server.last().path());
        assertEquals(json("{\"publish\":false,\"publishData\":true}"), server.last().json());
        assertEquals(new ParticipantPermissions(true, false, false, true, false, true), perms);
        assertTrue(perms.subscribe());
        assertFalse(perms.publish());

        server.respond(404, NOT_CONNECTED);
        SwalvoException e = assertThrows(SwalvoException.class, () -> client.rooms().participants()
                .updatePermissions("r1", "ghost", UpdateParticipantPermissionsParams.builder().subscribe(true).build()));
        assertEquals("RAVEN_PARTICIPANT_NOT_CONNECTED", e.getCode());
    }

    @Test
    void connectionsGet() {
        server.respond(200, "{\"id\":\"c1\",\"publicId\":\"conn_abc\",\"state\":\"FAILED\",\"reconnectCount\":2,"
                + "\"durationMs\":1234,\"events\":[{\"id\":\"e1\",\"type\":\"ice\",\"data\":{\"a\":1},\"timestamp\":\"t\"}],"
                + "\"errors\":[{\"id\":\"err1\",\"category\":\"ICE_ERROR\",\"message\":\"m\"}]}");
        ConnectionDetail detail = client.connections().get("conn_abc");
        assertEquals("/v1/connections/conn_abc", server.last().path());
        assertEquals(2, detail.reconnectCount());
        assertEquals(1234L, detail.durationMs());
        assertEquals(1, detail.events().get(0).data().get("a"));
        assertEquals(ErrorCategory.ICE_ERROR, detail.errors().get(0).category());
        assertEquals("conn_abc", detail.summary().publicId());
    }

    @Test
    void errorsListAndGet() {
        server.respond(200, "[]");
        client.errors().list(ListErrorsParams.builder()
                .category(ErrorCategory.ICE_ERROR).connectionId("conn_abc").limit(10).build());
        assertEquals("/v1/errors?category=ICE_ERROR&connectionId=conn_abc&limit=10", server.last().pathAndQuery());

        server.respond(200, "{\"publicId\":\"err_abc\",\"category\":\"TOKEN_ERROR\",\"connection\":{\"publicId\":\"conn_1\"}}");
        ErrorDetail error = client.errors().get("err_abc");
        assertEquals("/v1/errors/err_abc", server.last().path());
        assertEquals(ErrorCategory.TOKEN_ERROR, error.category());
        assertEquals("conn_1", error.connection().publicId());
    }

    @Test
    void metricsGet() {
        server.respond(200, "{\"range\":\"24h\",\"activeRooms\":3,\"activeParticipants\":7,\"connections\":12,"
                + "\"connectionSuccessRate\":0.95,\"reconnectionRate\":null,\"averageConnectionDurationMs\":61000,\"errors\":1}");
        MetricsOverview metrics = client.metrics().get();
        assertEquals("/v1/metrics", server.last().pathAndQuery());
        assertEquals(3, metrics.activeRooms());
        assertEquals(0.95, metrics.connectionSuccessRate());
        assertNull(metrics.reconnectionRate());
    }

    @Test
    void diagnosticsGet() {
        server.respond(200, "{\"project\":{\"id\":\"p1\",\"name\":\"demo\"},\"api\":\"up\",\"authentication\":\"ok\","
                + "\"dependencies\":{\"signaling\":\"up\",\"sfu\":\"down\",\"turn\":\"up\"},\"connections\":{\"active\":4}}");
        ProjectDiagnostics diagnostics = client.diagnostics().get();
        assertEquals("/v1/diagnostics", server.last().path());
        assertEquals(DependencyStatus.DOWN, diagnostics.dependencies().sfu());
        assertEquals(4, diagnostics.connections().active());
        assertEquals("demo", diagnostics.project().name());
    }
}
