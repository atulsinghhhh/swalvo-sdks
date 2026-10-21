<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `ChatMessage`. */
final class ChatMessage extends Model
{
    public readonly string $id;
    public readonly string $roomId;
    public readonly string $conversationId;
    public readonly string $senderId;
    /** text | system | event | attachment */
    public readonly string $type;
    public readonly ?string $text;
    public readonly ?string $replyTo;
    public readonly ?string $threadRootId;
    public readonly ?string $clientMessageId;
    /** @var array<string, mixed>|null */
    public readonly ?array $metadata;
    /** @var list<array{emoji: string, count: int, userIds: list<string>}> */
    public readonly array $reactions;
    public readonly bool $edited;
    public readonly bool $deleted;
    public readonly string $createdAt;
    public readonly string $updatedAt;
    public readonly ?string $editedAt;
    public readonly ?string $deletedAt;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->roomId = self::str($data, 'roomId');
        $this->conversationId = self::str($data, 'conversationId');
        $this->senderId = self::str($data, 'senderId');
        $this->type = self::str($data, 'type');
        $this->text = self::nstr($data, 'text');
        $this->replyTo = self::nstr($data, 'replyTo');
        $this->threadRootId = self::nstr($data, 'threadRootId');
        $this->clientMessageId = self::nstr($data, 'clientMessageId');
        $this->metadata = self::map($data, 'metadata');
        $this->reactions = array_values(is_array($data['reactions'] ?? null) ? $data['reactions'] : []);
        $this->edited = self::bool($data, 'edited');
        $this->deleted = self::bool($data, 'deleted');
        $this->createdAt = self::str($data, 'createdAt');
        $this->updatedAt = self::str($data, 'updatedAt');
        $this->editedAt = self::nstr($data, 'editedAt');
        $this->deletedAt = self::nstr($data, 'deletedAt');
    }
}
