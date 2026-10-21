<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Model\ChatConversation;
use Swalvo\Model\ChatMember;
use Swalvo\Model\ChatMessage;
use Swalvo\Model\ChatMessagePage;
use Swalvo\Model\IssuedChatToken;

/**
 * Swalvo Chat, server-side.
 *
 * `createToken()` is the method that matters: your backend authenticates the user its own way, then asks
 * Swalvo for a short-lived token scoped to that one user, and only that token reaches the browser.
 * Everything else is what a backend needs: provision conversations, manage membership, post system
 * messages, read history for export or moderation.
 */
final class Chat extends ApiResource
{
    /**
     * `POST /v1/chat/tokens`. `scopes` can only narrow what the user's role already allows.
     *
     * @param array{
     *     userId: string,
     *     conversations?: list<string>,
     *     scopes?: list<'chat:read'|'chat:send'|'chat:moderate'|'chat:manage'>,
     *     expiresIn?: int
     * } $params `expiresIn` is the lifetime in seconds (sent as `ttlSeconds`)
     */
    public function createToken(array $params): IssuedChatToken
    {
        return IssuedChatToken::fromArray((array) $this->http->request('POST', '/v1/chat/tokens', body: self::compact([
            'userId' => self::requireParam($params, 'userId'),
            'conversations' => $params['conversations'] ?? null,
            'scopes' => $params['scopes'] ?? null,
            'ttlSeconds' => $params['expiresIn'] ?? null,
        ])));
    }

    /**
     * `POST /v1/chat/conversations`. Pass `roomId` to attach it to an RTC room.
     *
     * A conversation created with no `members` is unreadable and unwritable by every chat token. List the
     * userIds who should have access in `members`, or call `addMember()` before minting their tokens.
     *
     * @param array{
     *     name: string,
     *     type?: 'ROOM'|'CHANNEL'|'DIRECT',
     *     roomId?: string,
     *     retentionDays?: int,
     *     members?: list<array{userId: string, role?: 'MEMBER'|'MODERATOR'|'ADMIN'}>,
     *     metadata?: array<string, mixed>,
     *     getOrCreate?: bool
     * } $params
     */
    public function createConversation(array $params): ChatConversation
    {
        return ChatConversation::fromArray((array) $this->http->request('POST', '/v1/chat/conversations', body: $params));
    }

    /**
     * `GET /v1/chat/conversations`. Without `userId`, every conversation in the project.
     *
     * @param array{userId?: string, includeArchived?: bool} $params
     * @return list<ChatConversation>
     */
    public function listConversations(array $params = []): array
    {
        return ChatConversation::listFrom($this->http->request('GET', '/v1/chat/conversations', query: [
            'userId' => $params['userId'] ?? null,
            'includeArchived' => $params['includeArchived'] ?? null,
        ]));
    }

    /** `GET /v1/chat/conversations/{room}`. `$room` is a `conv_...` id, the conversation name, or an attached RTC room id. */
    public function getConversation(string $room): ChatConversation
    {
        return ChatConversation::fromArray((array) $this->http->request('GET', self::conversationPath($room)));
    }

    /**
     * `POST /v1/chat/conversations/{room}/members`
     *
     * @param array{userId: string, role?: 'MEMBER'|'MODERATOR'|'ADMIN'} $params
     */
    public function addMember(string $room, array $params): ChatMember
    {
        return ChatMember::fromArray((array) $this->http->request('POST', self::conversationPath($room) . '/members', body: $params));
    }

    /** `DELETE /v1/chat/conversations/{room}/members/{userId}` */
    public function removeMember(string $room, string $userId): void
    {
        $this->http->request('DELETE', self::conversationPath($room) . '/members/' . self::seg($userId, 'userId'));
    }

    /**
     * `GET /v1/chat/conversations/{room}/members`
     *
     * @return list<ChatMember>
     */
    public function listMembers(string $room): array
    {
        return ChatMember::listFrom($this->http->request('GET', self::conversationPath($room) . '/members'));
    }

    /**
     * `POST /v1/chat/conversations/{room}/messages`. Posts as any user in the project, which is why it's
     * server-only; `type: 'system'` exists here and nowhere else.
     *
     * @param array{
     *     senderId: string,
     *     text?: string,
     *     type?: 'text'|'system'|'event'|'attachment',
     *     replyTo?: string,
     *     clientMessageId?: string,
     *     attachmentId?: string,
     *     metadata?: array<string, mixed>
     * } $params `clientMessageId` is an idempotency key
     */
    public function sendMessage(string $room, array $params): ChatMessage
    {
        return ChatMessage::fromArray((array) $this->http->request('POST', self::conversationPath($room) . '/messages', body: $params));
    }

    /**
     * `GET /v1/chat/conversations/{room}/messages`. Cursor-paginated; use `before` to page back.
     *
     * @param array{limit?: int, before?: string, after?: string, senderId?: string, includeDeleted?: bool} $params
     */
    public function listMessages(string $room, array $params = []): ChatMessagePage
    {
        // Same rules as the TS SDK: empty cursors are left out, includeDeleted is only ever sent as "true".
        $query = [
            'limit' => $params['limit'] ?? null,
            'before' => ($params['before'] ?? '') !== '' ? $params['before'] : null,
            'after' => ($params['after'] ?? '') !== '' ? $params['after'] : null,
            'senderId' => ($params['senderId'] ?? '') !== '' ? $params['senderId'] : null,
            'includeDeleted' => !empty($params['includeDeleted']) ? 'true' : null,
        ];

        return ChatMessagePage::fromArray((array) $this->http->request('GET', self::conversationPath($room) . '/messages', query: $query));
    }

    /** `DELETE /v1/chat/messages/{messageId}`: a soft delete; the row survives with a `deletedAt`. */
    public function deleteMessage(string $messageId): ChatMessage
    {
        return ChatMessage::fromArray((array) $this->http->request('DELETE', '/v1/chat/messages/' . self::seg($messageId, 'messageId')));
    }

    private static function conversationPath(string $room): string
    {
        return '/v1/chat/conversations/' . self::seg($room, 'room');
    }
}
