<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** `IngressView` plus the full stream key (`sk_...`), returned only by `create()` and `reset()`. TS: `IngressWithKey`. */
final class IngressWithKey extends IngressView
{
    /** The RTMP stream key and WHIP bearer token. Shown this once: store it now. */
    public readonly string $streamKey;

    protected function hydrate(array $data): void
    {
        parent::hydrate($data);
        $this->streamKey = self::str($data, 'streamKey');
    }
}
