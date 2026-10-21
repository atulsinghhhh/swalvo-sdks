package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** The project an API key belongs to. */
public record Project(
        String id,
        String name,
        String description,
        ProjectStatus status,
        String ownerId,
        String createdAt,
        String updatedAt) {
}
