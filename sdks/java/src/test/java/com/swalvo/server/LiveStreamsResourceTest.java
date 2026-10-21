package com.swalvo.server;

import static com.swalvo.server.MockServer.json;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.swalvo.server.model.AddHostParams;
import com.swalvo.server.model.CreateIngressParams;
import com.swalvo.server.model.CreateLiveStreamParams;
import com.swalvo.server.model.CreateRestreamParams;
import com.swalvo.server.model.DeliveryMode;
import com.swalvo.server.model.IngressProtocol;
import com.swalvo.server.model.IngressStatus;
import com.swalvo.server.model.IngressWithKey;
import com.swalvo.server.model.IssuedStreamCredential;
import com.swalvo.server.model.LiveStream;
import com.swalvo.server.model.LiveStreamDelivery;
import com.swalvo.server.model.LiveStreamDeliveryStatus;
import com.swalvo.server.model.LiveStreamHostRole;
import com.swalvo.server.model.LiveStreamStatus;
import com.swalvo.server.model.LiveStreamVisibility;
import com.swalvo.server.model.RestreamStatus;
import com.swalvo.server.model.RestreamView;
import com.swalvo.server.model.StreamCredentialRole;
import com.swalvo.server.model.UpdateLiveStreamParams;
import com.swalvo.server.model.UpdateRestreamParams;
import com.swalvo.server.model.ViewerTokenOptions;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class LiveStreamsResourceTest {

    private static final String STREAM = "{\"id\":\"stream_1\",\"title\":\"Q&A\",\"status\":\"LIVE\",\"visibility\":\"PUBLIC\","
            + "\"tags\":[\"a\"],\"hosts\":[{\"identity\":\"user-1\",\"role\":\"HOST\",\"invitedAt\":\"t\"}],"
            + "\"viewerCount\":null,\"peakViewerCount\":12,"
            + "\"delivery\":{\"mode\":\"BROADCAST\",\"status\":\"READY\",\"playbackUrl\":\"https://cdn/x.m3u8\","
            + "\"llhlsPlaybackUrl\":\"https://edge/ll.m3u8\",\"recordingUrl\":null,\"recordingDurationSec\":null}}";

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

    private String call() {
        MockServer.Recorded last = server.last();
        return last.method() + " " + last.pathAndQuery();
    }

    @Test
    void createSendsEveryParam() {
        server.respond(201, STREAM);
        LiveStream stream = client.liveStreams().create(CreateLiveStreamParams.builder()
                .title("Q&A").hostIdentity("user-1").tags("a", "b").visibility(LiveStreamVisibility.PUBLIC)
                .deliveryMode(DeliveryMode.BROADCAST).edgeScaling(true).build());
        assertEquals("POST /v1/live-streams", call());
        assertEquals(json("{\"title\":\"Q&A\",\"hostIdentity\":\"user-1\",\"tags\":[\"a\",\"b\"],\"visibility\":\"PUBLIC\","
                + "\"deliveryMode\":\"BROADCAST\",\"edgeScaling\":true}"), server.last().json());
        assertEquals(LiveStreamStatus.LIVE, stream.status());
        assertNull(stream.viewerCount());
        assertEquals(12, stream.peakViewerCount());
        assertEquals("https://edge/ll.m3u8", stream.delivery().llhlsPlaybackUrl());
        assertEquals(LiveStreamDeliveryStatus.READY, stream.delivery().status());
        assertEquals(LiveStreamHostRole.HOST, stream.hosts().get(0).role());

        server.respond(201, STREAM);
        client.liveStreams().create(CreateLiveStreamParams.builder().title("Q&A").hostIdentity("user-1").build());
        assertEquals(json("{\"title\":\"Q&A\",\"hostIdentity\":\"user-1\"}"), server.last().json());
    }

    @Test
    void lifecycle() {
        server.respond(200, "[]");
        client.liveStreams().list();
        assertEquals("GET /v1/live-streams", call());

        server.respond(200, STREAM);
        client.liveStreams().get("stream_1");
        assertEquals("GET /v1/live-streams/stream_1", call());

        server.respond(200, STREAM);
        client.live().update("stream_1", UpdateLiveStreamParams.builder().title("New title").build());
        assertEquals("PATCH /v1/live-streams/stream_1", call());
        assertEquals(json("{\"title\":\"New title\"}"), server.last().json());

        server.respond(200, STREAM);
        client.liveStreams().start("stream_1");
        assertEquals("POST /v1/live-streams/stream_1/start", call());
        assertEquals("", server.last().body());

        server.respond(200, STREAM);
        client.liveStreams().end("stream_1");
        assertEquals("POST /v1/live-streams/stream_1/end", call());
    }

    @Test
    void hosts() {
        server.respond(201, "{\"streamId\":\"stream_1\",\"identity\":\"user-2\",\"role\":\"CO_HOST\",\"rtc\":{\"token\":\"t\"},"
                + "\"chat\":{\"token\":\"c\"},\"chatRootMessageId\":null,\"rtcRoom\":\"stream_1\"}");
        IssuedStreamCredential cred = client.liveStreams().addHost("stream_1", AddHostParams.of("user-2"));
        assertEquals("POST /v1/live-streams/stream_1/hosts", call());
        assertEquals(json("{\"identity\":\"user-2\"}"), server.last().json());
        assertEquals(StreamCredentialRole.CO_HOST, cred.role());
        assertEquals("stream_1", cred.rtcRoom());

        server.respond(201, "{}");
        client.liveStreams().addHost("stream_1", AddHostParams.of("user-3", LiveStreamHostRole.HOST));
        assertEquals(json("{\"identity\":\"user-3\",\"role\":\"HOST\"}"), server.last().json());

        server.respond(204, null);
        client.liveStreams().removeHost("stream_1", "user-2");
        assertEquals("DELETE /v1/live-streams/stream_1/hosts/user-2", call());
    }

    @Test
    void viewerTokensSendAcceptPlaybackOnlyWhenAsked() {
        server.respond(201, "{\"identity\":\"dave\",\"role\":\"VIEWER\",\"rtc\":{\"token\":\"t\"}}");
        client.liveStreams().createViewerToken("stream_1", "dave");
        assertEquals("POST /v1/live-streams/stream_1/viewer-tokens", call());
        assertEquals(json("{\"identity\":\"dave\"}"), server.last().json());

        server.respond(201, "{\"streamId\":\"stream_1\",\"identity\":\"dave\",\"role\":\"VIEWER\",\"chat\":{\"token\":\"c\"},"
                + "\"chatRootMessageId\":\"m1\",\"playback\":{\"url\":\"https://cdn/x.m3u8\",\"llhlsUrl\":\"https://edge/ll.m3u8\",\"status\":\"STARTING\"}}");
        IssuedStreamCredential cred = client.liveStreams().createViewerToken("stream_1", "dave", ViewerTokenOptions.acceptingPlayback());
        assertEquals(json("{\"identity\":\"dave\",\"acceptPlayback\":true}"), server.last().json());
        assertNull(cred.rtc());
        assertEquals(StreamCredentialRole.VIEWER, cred.role());
        assertEquals("https://cdn/x.m3u8", cred.playback().url());
        assertEquals("https://edge/ll.m3u8", cred.playback().llhlsUrl());
        assertEquals(LiveStreamDeliveryStatus.STARTING, cred.playback().status());
    }

    @Test
    void playbackInfo() {
        server.respond(200, "{\"mode\":\"RTC_ONLY\",\"status\":\"NOT_APPLICABLE\",\"playbackUrl\":null,\"llhlsPlaybackUrl\":null}");
        LiveStreamDelivery delivery = client.liveStreams().getPlayback("stream_1");
        assertEquals("GET /v1/live-streams/stream_1/playback", call());
        assertEquals(DeliveryMode.RTC_ONLY, delivery.mode());
        assertEquals(LiveStreamDeliveryStatus.NOT_APPLICABLE, delivery.status());
    }

    @Test
    void stage() {
        server.respond(204, null);
        client.liveStreams().stage().invite("stream_1", "dave");
        assertEquals("POST /v1/live-streams/stream_1/stage/invites", call());
        assertEquals(json("{\"identity\":\"dave\"}"), server.last().json());

        server.respond(201, "{\"identity\":\"dave\",\"role\":\"CO_HOST\"}");
        client.liveStreams().stage().promote("stream_1", "dave");
        assertEquals("POST /v1/live-streams/stream_1/stage/promote", call());
        assertEquals(json("{\"identity\":\"dave\"}"), server.last().json());

        server.respond(201, "{\"identity\":\"dave\",\"role\":\"HOST\"}");
        client.liveStreams().stage().promote("stream_1", "dave", LiveStreamHostRole.HOST);
        assertEquals(json("{\"identity\":\"dave\",\"role\":\"HOST\"}"), server.last().json());

        server.respond(204, null);
        client.liveStreams().stage().demote("stream_1", "dave");
        assertEquals("POST /v1/live-streams/stream_1/stage/demote", call());
        assertEquals(json("{\"identity\":\"dave\"}"), server.last().json());
    }

    @Test
    void leave() {
        server.respond(204, null);
        client.liveStreams().leave("stream_1", "user-3");
        assertEquals("POST /v1/live-streams/stream_1/leave", call());
        assertEquals(json("{\"identity\":\"user-3\"}"), server.last().json());
    }

    @Test
    void restreams() {
        String view = "{\"id\":\"rst_1\",\"url\":\"rtmps://a.rtmp.youtube.com/live2\",\"keyLast4\":\"ab12\",\"enabled\":true,"
                + "\"status\":\"ACTIVE\",\"attempts\":0}";
        server.respond(201, view);
        CreateRestreamParams params = CreateRestreamParams.of("rtmps://a.rtmp.youtube.com/live2", "xxxx-ab12", "YouTube");
        RestreamView created = client.liveStreams().restreams().create("stream_1", params);
        assertEquals("POST /v1/live-streams/stream_1/restreams", call());
        assertEquals(json("{\"url\":\"rtmps://a.rtmp.youtube.com/live2\",\"streamKey\":\"xxxx-ab12\",\"label\":\"YouTube\"}"),
                server.last().json());
        assertEquals(RestreamStatus.ACTIVE, created.status());
        assertFalse(params.toString().contains("xxxx-ab12"));

        server.respond(200, "[" + view + "]");
        List<RestreamView> all = client.liveStreams().restreams().list("stream_1");
        assertEquals("GET /v1/live-streams/stream_1/restreams", call());
        assertEquals("ab12", all.get(0).keyLast4());

        server.respond(200, view);
        client.liveStreams().restreams().update("stream_1", "rst_1", UpdateRestreamParams.builder().enabled(false).build());
        assertEquals("PATCH /v1/live-streams/stream_1/restreams/rst_1", call());
        assertEquals(json("{\"enabled\":false}"), server.last().json());

        server.respond(204, null);
        client.liveStreams().restreams().delete("stream_1", "rst_1");
        assertEquals("DELETE /v1/live-streams/stream_1/restreams/rst_1", call());
    }

    @Test
    void ingress() {
        String withKey = "{\"id\":\"ing_1\",\"protocol\":\"WHIP\",\"identity\":\"user-1\",\"keyPrefix\":\"sk_ab\",\"autoStart\":true,"
                + "\"status\":\"IDLE\",\"reconnectWindowSec\":30,\"inputVideo\":{\"codec\":\"h264\",\"width\":1920,\"fps\":29.97},"
                + "\"whipUrl\":\"https://ingest/whip\",\"rtmpUrl\":\"rtmp://ingest/live\",\"streamKey\":\"sk_abc\"}";
        server.respond(201, withKey);
        IngressWithKey created = client.liveStreams().ingress().create("stream_1",
                CreateIngressParams.builder().protocol(IngressProtocol.WHIP).reconnectWindowSec(30).build());
        assertEquals("POST /v1/live-streams/stream_1/ingress", call());
        assertEquals(json("{\"protocol\":\"WHIP\",\"reconnectWindowSec\":30}"), server.last().json());
        assertEquals("sk_abc", created.streamKey());
        assertEquals(29.97, created.inputVideo().fps());
        assertFalse(created.toString().contains("sk_abc"));
        assertEquals("ing_1", created.view().id());

        server.respond(201, withKey);
        client.liveStreams().ingress().create("stream_1");
        assertEquals(json("{}"), server.last().json());

        server.respond(200, "{\"id\":\"ing_1\",\"status\":\"PUBLISHING\"}");
        assertEquals(IngressStatus.PUBLISHING, client.liveStreams().ingress().get("stream_1").status());
        assertEquals("GET /v1/live-streams/stream_1/ingress", call());

        server.respond(200, withKey);
        client.liveStreams().ingress().reset("stream_1");
        assertEquals("POST /v1/live-streams/stream_1/ingress/reset", call());

        server.respond(204, null);
        client.liveStreams().ingress().delete("stream_1");
        assertEquals("DELETE /v1/live-streams/stream_1/ingress", call());
    }
}
