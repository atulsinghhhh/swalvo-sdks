package com.swalvo.server.resources;

import com.swalvo.server.internal.Bodies;
import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.ErrorDetail;
import com.swalvo.server.model.ErrorSummary;
import com.swalvo.server.model.ListErrorsParams;
import java.util.List;

/** Classified RTC errors. Never a raw SFU or coturn error code. */
public final class ErrorsResource {
    private final HttpCore http;

    public ErrorsResource(HttpCore http) {
        this.http = http;
    }

    /** {@code GET /v1/errors?category=&connectionId=&limit=}. */
    public List<ErrorSummary> list(ListErrorsParams params) {
        ListErrorsParams p = params != null ? params : ListErrorsParams.builder().build();
        return http.get("/v1/errors",
                Bodies.of("category", p.category(), "connectionId", p.connectionId(), "limit", p.limit()),
                HttpCore.listOf(ErrorSummary.class));
    }

    public List<ErrorSummary> list() {
        return list(null);
    }

    /** {@code GET /v1/errors/:errorId}. */
    public ErrorDetail get(String errorId) {
        return http.get("/v1/errors/" + HttpCore.segment(errorId), null, HttpCore.type(ErrorDetail.class));
    }
}
