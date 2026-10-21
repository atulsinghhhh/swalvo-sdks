package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A browser-safe chat token. Hand it to the browser; never the project API key. */
public record IssuedChatToken(
        String token,
        String tokenId,
        String userId,
        String projectId,
        List<ChatScope> scopes,
        List<String> conversations,
        /** Pass it to {@code createChatClient({ chatUrl })}. */
        String chatUrl,
        String apiUrl,
        String expiresAt) {
}
