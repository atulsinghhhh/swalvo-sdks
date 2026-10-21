package com.swalvo.server.model;

import java.util.Map;

/**
 * Parameters for {@code chat().sendMessage()}.
 *
 * @param senderId required: a server-side send has to name the user it's acting for.
 * @param clientMessageId idempotency key. Retrying with the same key returns the original message.
 */
public record SendChatMessageParams(
        String text,
        String senderId,
        ChatMessageType type,
        String replyTo,
        String clientMessageId,
        String attachmentId,
        Map<String, Object> metadata) {

    public SendChatMessageParams {
        Copies.required(senderId, "senderId");
        metadata = Copies.map(metadata);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String text;
        private String senderId;
        private ChatMessageType type;
        private String replyTo;
        private String clientMessageId;
        private String attachmentId;
        private Map<String, Object> metadata;

        private Builder() {}

        public Builder text(String text) { this.text = text; return this; }
        public Builder senderId(String senderId) { this.senderId = senderId; return this; }
        public Builder type(ChatMessageType type) { this.type = type; return this; }
        public Builder replyTo(String replyTo) { this.replyTo = replyTo; return this; }
        public Builder clientMessageId(String id) { this.clientMessageId = id; return this; }
        public Builder attachmentId(String id) { this.attachmentId = id; return this; }
        public Builder metadata(Map<String, Object> metadata) { this.metadata = metadata; return this; }

        public SendChatMessageParams build() {
            return new SendChatMessageParams(text, senderId, type, replyTo, clientMessageId, attachmentId, metadata);
        }
    }
}
