<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `ConnectionEventEntry`. */
final class ConnectionEventEntry extends Model
{
    public readonly string $id;
    public readonly string $type;
    /** @var array<string, mixed>|null */
    public readonly ?array $data;
    public readonly string $timestamp;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->type = self::str($data, 'type');
        $this->data = self::map($data, 'data');
        $this->timestamp = self::str($data, 'timestamp');
    }
}
