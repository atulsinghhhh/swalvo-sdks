<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** The SFU's current live view of one participant. TS: `LiveParticipantInfo`. */
final class LiveParticipantInfo extends Model
{
    public readonly string $identity;
    public readonly string $joinedAt;
    /** @var list<LiveTrackInfo> */
    public readonly array $tracks;

    protected function hydrate(array $data): void
    {
        $this->identity = self::str($data, 'identity');
        $this->joinedAt = self::str($data, 'joinedAt');
        $this->tracks = LiveTrackInfo::listFrom($data['tracks'] ?? null);
    }
}
