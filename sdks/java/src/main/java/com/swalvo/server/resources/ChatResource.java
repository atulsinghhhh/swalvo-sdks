package com.swalvo.server.resources;

import com.swalvo.server.internal.Bodies;
import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.ChatConversation;
import com.swalvo.server.model.ChatMember;
import com.swalvo.server.model.ChatMemberParams;
import com.swalvo.server.model.ChatMessage;
import com.swalvo.server.model.ChatMessagePage;
import com.swalvo.server.model.CreateChatTokenParams;
import com.swalvo.server.model.CreateConversationParams;
import com.swalvo.server.model.IssuedChatToken;
import com.swalvo.server.model.ListChatMessagesParams;
import com.swalvo.server.model.ListConversationsParams;
import com.swalvo.server.model.SendChatMessageParams;
import java.util.List;

/**
 * Swalvo Chat, server-side.
 *
 * <p>{@link #createToken} is the method that matters: your backend authenticates the user <i>its</i> way,
 * then asks Swalvo for a short-lived token scoped to that one user, and only that token ever reaches the
 * browser. Everything else is what a backend genuinely needs: provisioning conversations, managing
 * membership, posting system messages, reading history for export or moderation.
 *
 * <p>Methods taking {@code room} accept a {@code conv_...} id, the conversation name, or an attached RTC room id.
 */
public final class ChatResource {
    private final HttpCore http;

    public ChatResource(HttpCore http) {
        this.http = http;
    }

    /**
     * {@code POST /v1/chat/tokens}: mints a browser-safe chat token. {@code scopes} can only ever narrow what
     * the user's role already allows. {@code expiresIn} goes out as {@code ttlSeconds}.
     */
    public IssuedChatToken createToken(CreateChatTokenParams params) {
        return http.send("POST", "/v1/chat/tokens",
                Bodies.of(
                        "userId", params.userId(),
                        "conversations", params.conversations(),
                        "scopes", params.scopes(),
                        "ttlSeconds", params.expiresIn()),
                HttpCore.type(IssuedChatToken.class));
    }

    /**
     * {@code POST /v1/chat/conversations}. A conversation created with no {@code members} is unreadable and
     * unwritable by every chat token; see {@link CreateConversationParams}.
     */
    public ChatConversation createConversation(CreateConversationParams params) {
        return http.send("POST", "/v1/chat/conversations", params, HttpCore.type(ChatConversation.class));
    }

    /**
     * {@code GET /v1/chat/conversations?userId=&includeArchived=}. Without {@code userId}, every conversation
     * in the project; with it, only the ones that user actively belongs to.
     */
    public List<ChatConversation> listConversations(ListConversationsParams params) {
        ListConversationsParams p = params != null ? params : ListConversationsParams.builder().build();
        return http.get("/v1/chat/conversations",
                Bodies.of("userId", p.userId(), "includeArchived", p.includeArchived()),
                HttpCore.listOf(ChatConversation.class));
    }

    public List<ChatConversation> listConversations() {
        return listConversations(null);
    }

    /** {@code GET /v1/chat/conversations/:room}. */
    public ChatConversation getConversation(String room) {
        return http.get(conversationPath(room), null, HttpCore.type(ChatConversation.class));
    }

    /** {@code POST /v1/chat/conversations/:room/members}. */
    public ChatMember addMember(String room, ChatMemberParams params) {
        return http.send("POST", conversationPath(room) + "/members", params, HttpCore.type(ChatMember.class));
    }

    /** {@code DELETE /v1/chat/conversations/:room/members/:userId}. */
    public void removeMember(String room, String userId) {
        http.send("DELETE", conversationPath(room) + "/members/" + HttpCore.segment(userId), null, null);
    }

    /** {@code GET /v1/chat/conversations/:room/members}. */
    public List<ChatMember> listMembers(String room) {
        return http.get(conversationPath(room) + "/members", null, HttpCore.listOf(ChatMember.class));
    }

    /**
     * {@code POST /v1/chat/conversations/:room/messages}: posts a message as any user in the project, which
     * is precisely why it's server-only. {@code SYSTEM} messages exist here and nowhere else.
     */
    public ChatMessage sendMessage(String room, SendChatMessageParams params) {
        return http.send("POST", conversationPath(room) + "/messages", params, HttpCore.type(ChatMessage.class));
    }

    /**
     * {@code GET /v1/chat/conversations/:room/messages}: cursor-paginated history. Use {@code before} to page
     * back. Never an offset. Empty cursors are left out; {@code includeDeleted} is only sent when true.
     */
    public ChatMessagePage listMessages(String room, ListChatMessagesParams params) {
        ListChatMessagesParams p = params != null ? params : ListChatMessagesParams.builder().build();
        return http.get(conversationPath(room) + "/messages",
                Bodies.of(
                        "limit", p.limit(),
                        "before", nonEmpty(p.before()),
                        "after", nonEmpty(p.after()),
                        "senderId", nonEmpty(p.senderId()),
                        "includeDeleted", Boolean.TRUE.equals(p.includeDeleted()) ? "true" : null),
                HttpCore.type(ChatMessagePage.class));
    }

    public ChatMessagePage listMessages(String room) {
        return listMessages(room, null);
    }

    /** {@code DELETE /v1/chat/messages/:messageId}: soft-deletes; the row survives with a {@code deletedAt}. */
    public ChatMessage deleteMessage(String messageId) {
        return http.send("DELETE", "/v1/chat/messages/" + HttpCore.segment(messageId), null,
                HttpCore.type(ChatMessage.class));
    }

    private static String conversationPath(String room) {
        return "/v1/chat/conversations/" + HttpCore.segment(room);
    }

    private static String nonEmpty(String value) {
        return value == null || value.isEmpty() ? null : value;
    }
}
