<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** `GET /v1/project`. TS: `Project`. */
final class Project extends Model
{
    public readonly string $id;
    public readonly string $name;
    public readonly ?string $description;
    /** ACTIVE | ARCHIVED */
    public readonly string $status;
    public readonly string $ownerId;
    public readonly string $createdAt;
    public readonly string $updatedAt;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->name = self::str($data, 'name');
        $this->description = self::nstr($data, 'description');
        $this->status = self::str($data, 'status');
        $this->ownerId = self::str($data, 'ownerId');
        $this->createdAt = self::str($data, 'createdAt');
        $this->updatedAt = self::str($data, 'updatedAt');
    }
}
