<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `ChatMember`. */
final class ChatMember extends Model
{
    public readonly string $id;
    public readonly string $conversationId;
    public readonly string $projectId;
    public readonly string $userId;
    /** MEMBER | MODERATOR | ADMIN */
    public readonly string $role;
    /** ACTIVE | LEFT */
    public readonly string $status;
    public readonly string $joinedAt;
    public readonly ?string $leftAt;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->conversationId = self::str($data, 'conversationId');
        $this->projectId = self::str($data, 'projectId');
        $this->userId = self::str($data, 'userId');
        $this->role = self::str($data, 'role');
        $this->status = self::str($data, 'status');
        $this->joinedAt = self::str($data, 'joinedAt');
        $this->leftAt = self::nstr($data, 'leftAt');
    }
}
