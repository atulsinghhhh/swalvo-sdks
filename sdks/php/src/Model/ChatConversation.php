<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `ChatConversation`. */
final class ChatConversation extends Model
{
    public readonly string $id;
    public readonly string $publicId;
    public readonly string $projectId;
    public readonly ?string $roomId;
    public readonly string $name;
    /** ROOM | CHANNEL | DIRECT */
    public readonly string $type;
    /** ACTIVE | ARCHIVED */
    public readonly string $status;
    public readonly ?int $retentionDays;
    /** @var array<string, mixed>|null */
    public readonly ?array $metadata;
    public readonly string $createdAt;
    public readonly string $updatedAt;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->publicId = self::str($data, 'publicId');
        $this->projectId = self::str($data, 'projectId');
        $this->roomId = self::nstr($data, 'roomId');
        $this->name = self::str($data, 'name');
        $this->type = self::str($data, 'type');
        $this->status = self::str($data, 'status');
        $this->retentionDays = self::nint($data, 'retentionDays');
        $this->metadata = self::map($data, 'metadata');
        $this->createdAt = self::str($data, 'createdAt');
        $this->updatedAt = self::str($data, 'updatedAt');
    }
}
