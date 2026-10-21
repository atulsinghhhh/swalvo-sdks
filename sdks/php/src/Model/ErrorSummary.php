<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** A classified RTC error. TS: `ErrorSummary`. */
class ErrorSummary extends Model
{
    public readonly string $id;
    public readonly string $publicId;
    public readonly string $projectId;
    public readonly ?string $connectionId;
    public readonly ?string $roomId;
    public readonly ?string $participantId;
    /** AUTHENTICATION_ERROR | AUTHORIZATION_ERROR | TOKEN_ERROR | SIGNALING_ERROR | ICE_ERROR | TURN_ERROR | SFU_ERROR | NETWORK_ERROR | CLIENT_ERROR | UNKNOWN_ERROR */
    public readonly string $category;
    public readonly string $message;
    public readonly ?string $likelyCause;
    public readonly ?string $suggestedAction;
    public readonly ?string $sdkVersion;
    public readonly ?string $platform;
    public readonly string $timestamp;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->publicId = self::str($data, 'publicId');
        $this->projectId = self::str($data, 'projectId');
        $this->connectionId = self::nstr($data, 'connectionId');
        $this->roomId = self::nstr($data, 'roomId');
        $this->participantId = self::nstr($data, 'participantId');
        $this->category = self::str($data, 'category');
        $this->message = self::str($data, 'message');
        $this->likelyCause = self::nstr($data, 'likelyCause');
        $this->suggestedAction = self::nstr($data, 'suggestedAction');
        $this->sdkVersion = self::nstr($data, 'sdkVersion');
        $this->platform = self::nstr($data, 'platform');
        $this->timestamp = self::str($data, 'timestamp');
    }
}
