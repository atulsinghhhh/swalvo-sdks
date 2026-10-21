<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `LiveTrackInfo`. */
final class LiveTrackInfo extends Model
{
    public readonly string $sid;
    /** audio | video | unknown */
    public readonly string $kind;
    public readonly string $name;
    public readonly bool $muted;

    protected function hydrate(array $data): void
    {
        $this->sid = self::str($data, 'sid');
        $this->kind = self::str($data, 'kind');
        $this->name = self::str($data, 'name');
        $this->muted = self::bool($data, 'muted');
    }
}
