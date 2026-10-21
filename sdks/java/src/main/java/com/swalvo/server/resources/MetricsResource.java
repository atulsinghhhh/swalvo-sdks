package com.swalvo.server.resources;

import com.swalvo.server.internal.Bodies;
import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.MetricsOverview;
import com.swalvo.server.model.MetricsRange;

/** Real aggregate metrics only. This doubles as today's usage view; there's no separate metering system yet. */
public final class MetricsResource {
    private final HttpCore http;

    public MetricsResource(HttpCore http) {
        this.http = http;
    }

    /** {@code GET /v1/metrics?range=}. A null range uses the API's default. */
    public MetricsOverview get(MetricsRange range) {
        return http.get("/v1/metrics", Bodies.of("range", range), HttpCore.type(MetricsOverview.class));
    }

    public MetricsOverview get() {
        return get(null);
    }
}
