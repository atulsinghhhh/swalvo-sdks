package com.swalvo.server.resources;

import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.Project;

/**
 * An API key is permanently scoped to exactly one project, so there's nothing to list, create, update or
 * delete here; those stay dashboard operations. {@link #get()} always returns the one project this key
 * belongs to.
 */
public final class ProjectsResource {
    private final HttpCore http;

    public ProjectsResource(HttpCore http) {
        this.http = http;
    }

    /** {@code GET /v1/project}: the project this API key belongs to. */
    public Project get() {
        return http.get("/v1/project", null, HttpCore.type(Project.class));
    }
}
