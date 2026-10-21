<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** A connected participant's merged live permissions, as `rooms->participants->updatePermissions()` returns them. */
final class ParticipantPermissions extends Model
{
    public readonly bool $subscribe;
    public readonly bool $publish;
    public readonly bool $publishAudio;
    public readonly bool $publishVideo;
    /** Screen-share, independent of publishVideo (agora-parity audit, phase 2). */
    public readonly bool $publishScreen;
    public readonly bool $publishData;

    protected function hydrate(array $data): void
    {
        $this->subscribe = self::bool($data, 'subscribe');
        $this->publish = self::bool($data, 'publish');
        $this->publishAudio = self::bool($data, 'publishAudio');
        $this->publishVideo = self::bool($data, 'publishVideo');
        $this->publishScreen = self::bool($data, 'publishScreen');
        $this->publishData = self::bool($data, 'publishData');
    }
}
