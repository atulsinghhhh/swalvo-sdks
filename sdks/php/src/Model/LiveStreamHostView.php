<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `LiveStreamHostView`. */
final class LiveStreamHostView extends Model
{
    public readonly string $identity;
    /** HOST | CO_HOST */
    public readonly string $role;
    public readonly string $invitedAt;

    protected function hydrate(array $data): void
    {
        $this->identity = self::str($data, 'identity');
        $this->role = self::str($data, 'role');
        $this->invitedAt = self::str($data, 'invitedAt');
    }
}
