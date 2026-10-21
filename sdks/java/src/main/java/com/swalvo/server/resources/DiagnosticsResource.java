package com.swalvo.server.resources;

import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.ProjectDiagnostics;

/**
 * Authenticated, project-scoped diagnostics: signaling, SFU and TURN health, plus this project's real
 * active-connection count. Browser ICE and signaling state only exist inside a running client SDK.
 */
public final class DiagnosticsResource {
    private final HttpCore http;

    public DiagnosticsResource(HttpCore http) {
        this.http = http;
    }

    /** {@code GET /v1/diagnostics}. */
    public ProjectDiagnostics get() {
        return http.get("/v1/diagnostics", null, HttpCore.type(ProjectDiagnostics.class));
    }
}
