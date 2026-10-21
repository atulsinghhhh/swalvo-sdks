package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** One event in a connection's history. */
public record ConnectionEventEntry(
        String id,
        String type,
        Map<String, Object> data,
        String timestamp) {
}
