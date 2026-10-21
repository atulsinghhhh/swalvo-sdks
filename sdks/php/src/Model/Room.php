<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** A control-plane room record. TS: `Room`. */
final class Room extends Model
{
    public readonly string $id;
    public readonly string $projectId;
    public readonly string $name;
    /** ACTIVE | CLOSED */
    public readonly string $status;
    /** End-to-end encrypted media. Fixed at create; null when the API omits it. */
    public readonly ?bool $e2ee;
    public readonly string $createdAt;
    public readonly string $updatedAt;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->projectId = self::str($data, 'projectId');
        $this->name = self::str($data, 'name');
        $this->status = self::str($data, 'status');
        $this->e2ee = self::nbool($data, 'e2ee');
        $this->createdAt = self::str($data, 'createdAt');
        $this->updatedAt = self::str($data, 'updatedAt');
    }
}
