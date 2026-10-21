package com.swalvo.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.swalvo.server.model.CreateLiveStreamParams;
import com.swalvo.server.model.CreateRoomParams;
import com.swalvo.server.model.CreateTokenParams;
import com.swalvo.server.model.IssuedStreamCredential;
import com.swalvo.server.model.IssuedToken;
import com.swalvo.server.model.LiveStream;
import com.swalvo.server.model.LiveStreamStatus;
import com.swalvo.server.model.Room;
import com.swalvo.server.model.StreamCredentialRole;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Opt-in, against a real Swalvo API. Skipped unless both {@code SWALVO_IT_BASE_URL} and
 * {@code SWALVO_IT_API_KEY} are set. Creates (and cleans up) its own room and stream.
 */
@EnabledIfEnvironmentVariable(named = "SWALVO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "SWALVO_IT_API_KEY", matches = ".+")
class SwalvoIntegrationTest {

    @Test
    void roomTokenStreamAndViewerToken() {
        Swalvo client = Swalvo.builder()
                .apiKey(System.getenv("SWALVO_IT_API_KEY"))
                .baseUrl(System.getenv("SWALVO_IT_BASE_URL"))
                .build();
        String suffix = UUID.randomUUID().toString().substring(0, 8);

        Room room = client.rooms().create(CreateRoomParams.builder().name("java-sdk-it-" + suffix).getOrCreate(true).build());
        try {
            IssuedToken token = client.tokens().create(CreateTokenParams.builder()
                    .room(room.id()).identity("java-it-" + suffix).expiresIn(120).build());
            assertNotNull(token.token());
            assertNotNull(token.endpoint());
            assertEquals(room.id(), token.roomId());
        } finally {
            client.rooms().delete(room.id());
        }

        LiveStream stream = client.liveStreams().create(CreateLiveStreamParams.builder()
                .title("Java SDK IT " + suffix).hostIdentity("java-host-" + suffix).build());
        try {
            assertEquals(LiveStreamStatus.CREATED, stream.status());
            // Only a LIVE stream can be ended, so start it first.
            assertEquals(LiveStreamStatus.LIVE, client.liveStreams().start(stream.id()).status());
            IssuedStreamCredential viewer = client.liveStreams().createViewerToken(stream.id(), "java-viewer-" + suffix);
            assertEquals(StreamCredentialRole.VIEWER, viewer.role());
            assertEquals(stream.id(), viewer.streamId());
        } finally {
            LiveStream ended = client.liveStreams().end(stream.id());
            assertEquals(LiveStreamStatus.ENDED, ended.status());
        }
    }
}
