<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** A stored connection record. TS: `ConnectionSummary`. */
class ConnectionSummary extends Model
{
    public readonly string $id;
    public readonly string $publicId;
    public readonly string $projectId;
    public readonly ?string $roomId;
    public readonly string $roomName;
    public readonly ?string $participantId;
    public readonly string $participantIdentity;
    /** CONNECTING | CONNECTED | RECONNECTING | DISCONNECTED | FAILED */
    public readonly string $state;
    public readonly ?string $disconnectReason;
    public readonly ?string $region;
    public readonly ?string $sdkVersion;
    public readonly ?string $platform;
    public readonly ?string $browser;
    public readonly ?string $networkType;
    public readonly ?string $iceConnectionState;
    public readonly ?string $signalingState;
    public readonly int $reconnectCount;
    public readonly string $startedAt;
    public readonly ?string $connectedAt;
    public readonly ?string $disconnectedAt;
    public readonly ?int $durationMs;
    public readonly string $createdAt;
    public readonly string $updatedAt;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->publicId = self::str($data, 'publicId');
        $this->projectId = self::str($data, 'projectId');
        $this->roomId = self::nstr($data, 'roomId');
        $this->roomName = self::str($data, 'roomName');
        $this->participantId = self::nstr($data, 'participantId');
        $this->participantIdentity = self::str($data, 'participantIdentity');
        $this->state = self::str($data, 'state');
        $this->disconnectReason = self::nstr($data, 'disconnectReason');
        $this->region = self::nstr($data, 'region');
        $this->sdkVersion = self::nstr($data, 'sdkVersion');
        $this->platform = self::nstr($data, 'platform');
        $this->browser = self::nstr($data, 'browser');
        $this->networkType = self::nstr($data, 'networkType');
        $this->iceConnectionState = self::nstr($data, 'iceConnectionState');
        $this->signalingState = self::nstr($data, 'signalingState');
        $this->reconnectCount = self::int($data, 'reconnectCount');
        $this->startedAt = self::str($data, 'startedAt');
        $this->connectedAt = self::nstr($data, 'connectedAt');
        $this->disconnectedAt = self::nstr($data, 'disconnectedAt');
        $this->durationMs = self::nint($data, 'durationMs');
        $this->createdAt = self::str($data, 'createdAt');
        $this->updatedAt = self::str($data, 'updatedAt');
    }
}
