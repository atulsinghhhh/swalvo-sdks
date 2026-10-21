package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** One cursor-paginated page of history. Never an offset. */
public record ChatMessagePage(
        List<ChatMessage> data,
        String nextCursor,
        String previousCursor,
        boolean hasMore) {
}
