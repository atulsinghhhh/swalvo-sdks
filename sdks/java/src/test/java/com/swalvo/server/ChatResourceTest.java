package com.swalvo.server;

import static com.swalvo.server.MockServer.json;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.swalvo.server.model.ChatConversationType;
import com.swalvo.server.model.ChatMemberParams;
import com.swalvo.server.model.ChatMemberRole;
import com.swalvo.server.model.ChatMessage;
import com.swalvo.server.model.ChatMessagePage;
import com.swalvo.server.model.ChatMessageType;
import com.swalvo.server.model.ChatScope;
import com.swalvo.server.model.CreateChatTokenParams;
import com.swalvo.server.model.CreateConversationParams;
import com.swalvo.server.model.IssuedChatToken;
import com.swalvo.server.model.ListChatMessagesParams;
import com.swalvo.server.model.ListConversationsParams;
import com.swalvo.server.model.SendChatMessageParams;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ChatResourceTest {

    private MockServer server;
    private Swalvo client;

    @BeforeEach
    void start() throws Exception {
        server = new MockServer();
        client = server.client();
    }

    @AfterEach
    void stop() {
        server.close();
    }

    @Test
    void createTokenRenamesExpiresInToTtlSeconds() {
        server.respond(201, "{\"token\":\"ct\",\"tokenId\":\"ctk_1\",\"userId\":\"u1\",\"scopes\":[\"chat:read\",\"chat:send\"],"
                + "\"conversations\":[\"conv_1\"],\"chatUrl\":\"wss://chat\"}");
        IssuedChatToken token = client.chat().createToken(CreateChatTokenParams.builder()
                .userId("u1").conversations("conv_1").scopes(ChatScope.READ, ChatScope.SEND).expiresIn(600).build());

        assertEquals("POST /v1/chat/tokens", server.last().method() + " " + server.last().path());
        assertEquals(json("{\"userId\":\"u1\",\"conversations\":[\"conv_1\"],\"scopes\":[\"chat:read\",\"chat:send\"],"
                + "\"ttlSeconds\":600}"), server.last().json());
        assertEquals(ChatScope.SEND, token.scopes().get(1));
        assertEquals("wss://chat", token.chatUrl());

        server.respond(201, "{\"token\":\"ct\"}");
        client.chat().createToken(CreateChatTokenParams.builder().userId("u2").build());
        assertEquals(json("{\"userId\":\"u2\"}"), server.last().json());
    }

    @Test
    void createConversationSendsParamsAsIsKeepingNullsInsideMetadata() {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("topic", "support");
        metadata.put("cleared", null);
        server.respond(201, "{\"id\":\"c1\",\"publicId\":\"conv_1\",\"name\":\"support\",\"type\":\"CHANNEL\",\"status\":\"ACTIVE\"}");
        var conversation = client.chat().createConversation(CreateConversationParams.builder()
                .name("support")
                .type(ChatConversationType.CHANNEL)
                .addMember("alice", ChatMemberRole.ADMIN)
                .addMember("bob", null)
                .metadata(metadata)
                .getOrCreate(true)
                .build());

        assertEquals("/v1/chat/conversations", server.last().path());
        assertEquals(json("{\"name\":\"support\",\"type\":\"CHANNEL\",\"members\":[{\"userId\":\"alice\",\"role\":\"ADMIN\"},"
                + "{\"userId\":\"bob\"}],\"metadata\":{\"topic\":\"support\",\"cleared\":null},\"getOrCreate\":true}"),
                server.last().json());
        assertEquals(ChatConversationType.CHANNEL, conversation.type());
    }

    @Test
    void listAndGetConversations() {
        server.respond(200, "[]");
        client.chat().listConversations();
        assertEquals("/v1/chat/conversations", server.last().pathAndQuery());

        server.respond(200, "[]");
        client.chat().listConversations(ListConversationsParams.builder().userId("u 1").includeArchived(false).build());
        assertEquals("/v1/chat/conversations?userId=u+1&includeArchived=false", server.last().pathAndQuery());

        server.respond(200, "{\"publicId\":\"conv_1\"}");
        client.chat().getConversation("my room/1");
        assertEquals("/v1/chat/conversations/my%20room%2F1", server.last().path());
    }

    @Test
    void membership() {
        server.respond(201, "{\"userId\":\"u1\",\"role\":\"MODERATOR\",\"status\":\"ACTIVE\"}");
        var member = client.chat().addMember("conv_1", ChatMemberParams.of("u1", ChatMemberRole.MODERATOR));
        assertEquals("POST /v1/chat/conversations/conv_1/members", server.last().method() + " " + server.last().path());
        assertEquals(json("{\"userId\":\"u1\",\"role\":\"MODERATOR\"}"), server.last().json());
        assertEquals(ChatMemberRole.MODERATOR, member.role());

        server.respond(200, "[{\"userId\":\"u1\"}]");
        assertEquals(1, client.chat().listMembers("conv_1").size());
        assertEquals("GET /v1/chat/conversations/conv_1/members", server.last().method() + " " + server.last().path());

        server.respond(204, null);
        client.chat().removeMember("conv_1", "user@x");
        assertEquals("DELETE /v1/chat/conversations/conv_1/members/user%40x", server.last().method() + " " + server.last().path());
    }

    @Test
    void sendMessage() {
        server.respond(201, "{\"id\":\"m1\",\"type\":\"system\",\"text\":\"Stream starting\",\"reactions\":[],\"edited\":false,\"deleted\":false}");
        ChatMessage message = client.chat().sendMessage("conv_1", SendChatMessageParams.builder()
                .senderId("system-bot").text("Stream starting").type(ChatMessageType.SYSTEM).clientMessageId("idem-1").build());
        assertEquals("/v1/chat/conversations/conv_1/messages", server.last().path());
        assertEquals(json("{\"text\":\"Stream starting\",\"senderId\":\"system-bot\",\"type\":\"system\",\"clientMessageId\":\"idem-1\"}"),
                server.last().json());
        assertEquals(ChatMessageType.SYSTEM, message.type());
    }

    @Test
    void listMessagesIsCursorPaginated() {
        server.respond(200, "{\"data\":[{\"id\":\"m1\",\"reactions\":[{\"emoji\":\"+1\",\"count\":2,\"userIds\":[\"a\",\"b\"]}]}],"
                + "\"nextCursor\":\"cur_2\",\"previousCursor\":null,\"hasMore\":true}");
        ChatMessagePage page = client.chat().listMessages("conv_1", ListChatMessagesParams.builder()
                .limit(50).before("cur_1").after("").senderId("u1").includeDeleted(true).build());
        assertEquals("/v1/chat/conversations/conv_1/messages?limit=50&before=cur_1&senderId=u1&includeDeleted=true",
                server.last().pathAndQuery());
        assertEquals("cur_2", page.nextCursor());
        assertTrue(page.hasMore());
        assertEquals(2, page.data().get(0).reactions().get(0).count());

        server.respond(200, "{\"data\":[],\"hasMore\":false}");
        client.chat().listMessages("conv_1", ListChatMessagesParams.builder().includeDeleted(false).build());
        assertNull(server.last().rawQuery());
    }

    @Test
    void deleteMessageIsASoftDelete() {
        server.respond(200, "{\"id\":\"m1\",\"deleted\":true,\"deletedAt\":\"t\"}");
        ChatMessage deleted = client.chat().deleteMessage("m1");
        assertEquals("DELETE /v1/chat/messages/m1", server.last().method() + " " + server.last().path());
        assertTrue(deleted.deleted());
    }
}
