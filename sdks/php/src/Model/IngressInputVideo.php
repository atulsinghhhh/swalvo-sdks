<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `IngressInputVideo`. */
final class IngressInputVideo extends Model
{
    public readonly string $codec;
    public readonly ?int $width;
    public readonly ?int $height;
    public readonly ?float $fps;
    public readonly ?int $bitrateKbps;
    public readonly ?float $keyframeIntervalSec;

    protected function hydrate(array $data): void
    {
        $this->codec = self::str($data, 'codec');
        $this->width = self::nint($data, 'width');
        $this->height = self::nint($data, 'height');
        $this->fps = self::nfloat($data, 'fps');
        $this->bitrateKbps = self::nint($data, 'bitrateKbps');
        $this->keyframeIntervalSec = self::nfloat($data, 'keyframeIntervalSec');
    }
}
