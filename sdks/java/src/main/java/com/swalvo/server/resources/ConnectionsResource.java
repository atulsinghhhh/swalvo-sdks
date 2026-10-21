package com.swalvo.server.resources;

import com.swalvo.server.internal.Bodies;
import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.ConnectionDetail;
import com.swalvo.server.model.ConnectionSummary;
import com.swalvo.server.model.ListConnectionsParams;
import java.util.List;

/** Real event-sourced RTC connection data, read from your backend. */
public final class ConnectionsResource {
    private final HttpCore http;

    public ConnectionsResource(HttpCore http) {
        this.http = http;
    }

    /** {@code GET /v1/connections?roomId=&state=&limit=}. */
    public List<ConnectionSummary> list(ListConnectionsParams params) {
        ListConnectionsParams p = params != null ? params : ListConnectionsParams.builder().build();
        return http.get("/v1/connections",
                Bodies.of("roomId", p.roomId(), "state", p.state(), "limit", p.limit()),
                HttpCore.listOf(ConnectionSummary.class));
    }

    public List<ConnectionSummary> list() {
        return list(null);
    }

    /** {@code GET /v1/connections/:connectionId}. */
    public ConnectionDetail get(String connectionId) {
        return http.get("/v1/connections/" + HttpCore.segment(connectionId), null,
                HttpCore.type(ConnectionDetail.class));
    }
}
