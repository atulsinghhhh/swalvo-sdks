<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** One RTMP/RTMPS destination. The stream key is never returned; `keyLast4` is all you get. TS: `RestreamView`. */
final class RestreamView extends Model
{
    public readonly string $id;
    public readonly ?string $label;
    public readonly string $url;
    public readonly string $keyLast4;
    public readonly bool $enabled;
    /** IDLE | CONNECTING | ACTIVE | RETRYING | FAILED | STOPPED */
    public readonly string $status;
    public readonly ?string $lastError;
    public readonly int $attempts;
    public readonly ?string $connectedAt;
    public readonly string $createdAt;
    public readonly string $updatedAt;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->label = self::nstr($data, 'label');
        $this->url = self::str($data, 'url');
        $this->keyLast4 = self::str($data, 'keyLast4');
        $this->enabled = self::bool($data, 'enabled');
        $this->status = self::str($data, 'status');
        $this->lastError = self::nstr($data, 'lastError');
        $this->attempts = self::int($data, 'attempts');
        $this->connectedAt = self::nstr($data, 'connectedAt');
        $this->createdAt = self::str($data, 'createdAt');
        $this->updatedAt = self::str($data, 'updatedAt');
    }
}
