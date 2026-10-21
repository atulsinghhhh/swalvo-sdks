<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `IngressInputAudio`. */
final class IngressInputAudio extends Model
{
    public readonly string $codec;
    public readonly ?int $sampleRate;
    public readonly ?int $channels;
    public readonly ?int $bitrateKbps;

    protected function hydrate(array $data): void
    {
        $this->codec = self::str($data, 'codec');
        $this->sampleRate = self::nint($data, 'sampleRate');
        $this->channels = self::nint($data, 'channels');
        $this->bitrateKbps = self::nint($data, 'bitrateKbps');
    }
}
