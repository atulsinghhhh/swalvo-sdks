<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** Swalvo's own permission vocabulary; null means the API left the flag out. TS: `TokenPermissions`. */
final class TokenPermissions extends Model
{
    public readonly ?bool $join;
    public readonly ?bool $subscribe;
    public readonly ?bool $publish;
    public readonly ?bool $publishAudio;
    public readonly ?bool $publishVideo;
    /** Screen-share, independent of publishVideo (agora-parity audit, phase 2). */
    public readonly ?bool $publishScreen;
    public readonly ?bool $publishData;

    protected function hydrate(array $data): void
    {
        $this->join = self::nbool($data, 'join');
        $this->subscribe = self::nbool($data, 'subscribe');
        $this->publish = self::nbool($data, 'publish');
        $this->publishAudio = self::nbool($data, 'publishAudio');
        $this->publishVideo = self::nbool($data, 'publishVideo');
        $this->publishScreen = self::nbool($data, 'publishScreen');
        $this->publishData = self::nbool($data, 'publishData');
    }
}
