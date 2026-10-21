<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** A browser-safe chat token. TS: `IssuedChatToken`. */
final class IssuedChatToken extends Model
{
    /** Hand this to the browser. Never send the project API key instead. */
    public readonly string $token;
    public readonly string $tokenId;
    public readonly string $userId;
    public readonly string $projectId;
    /** @var list<string> chat:read | chat:send | chat:moderate | chat:manage */
    public readonly array $scopes;
    /** @var list<string> */
    public readonly array $conversations;
    public readonly string $chatUrl;
    public readonly string $apiUrl;
    public readonly string $expiresAt;

    protected function hydrate(array $data): void
    {
        $this->token = self::str($data, 'token');
        $this->tokenId = self::str($data, 'tokenId');
        $this->userId = self::str($data, 'userId');
        $this->projectId = self::str($data, 'projectId');
        $this->scopes = self::strList($data, 'scopes');
        $this->conversations = self::strList($data, 'conversations');
        $this->chatUrl = self::str($data, 'chatUrl');
        $this->apiUrl = self::str($data, 'apiUrl');
        $this->expiresAt = self::str($data, 'expiresAt');
    }
}
