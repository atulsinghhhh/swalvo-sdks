<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `IceServer`. */
final class IceServer extends Model
{
    public readonly string $urls;
    public readonly ?string $username;
    public readonly ?string $credential;

    protected function hydrate(array $data): void
    {
        $this->urls = self::str($data, 'urls');
        $this->username = self::nstr($data, 'username');
        $this->credential = self::nstr($data, 'credential');
    }
}
