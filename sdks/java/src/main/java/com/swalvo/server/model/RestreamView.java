package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** An RTMP/RTMPS destination. Its stream key is never returned; {@code keyLast4} is all you get. */
public record RestreamView(
        /** {@code rst_...} */
        String id,
        String label,
        /** The ingest URL without the key. */
        String url,
        String keyLast4,
        boolean enabled,
        RestreamStatus status,
        String lastError,
        /** Consecutive failed attempts. Resets after 30 s of stable output. */
        int attempts,
        String connectedAt,
        String createdAt,
        String updatedAt) {
}
