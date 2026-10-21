<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `MetricsOverview`. */
final class MetricsOverview extends Model
{
    public readonly string $range;
    public readonly int $activeRooms;
    public readonly int $activeParticipants;
    public readonly int $connections;
    public readonly ?float $connectionSuccessRate;
    public readonly ?float $reconnectionRate;
    public readonly ?float $averageConnectionDurationMs;
    public readonly int $errors;

    protected function hydrate(array $data): void
    {
        $this->range = self::str($data, 'range');
        $this->activeRooms = self::int($data, 'activeRooms');
        $this->activeParticipants = self::int($data, 'activeParticipants');
        $this->connections = self::int($data, 'connections');
        $this->connectionSuccessRate = self::nfloat($data, 'connectionSuccessRate');
        $this->reconnectionRate = self::nfloat($data, 'reconnectionRate');
        $this->averageConnectionDurationMs = self::nfloat($data, 'averageConnectionDurationMs');
        $this->errors = self::int($data, 'errors');
    }
}
