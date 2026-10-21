<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** A short-lived RTC token. Forward it to your frontend with `json_encode($token)`. TS: `IssuedToken`. */
final class IssuedToken extends Model
{
    public readonly string $id;
    public readonly string $token;
    /** Where the client SDK connects. Forward it untouched. */
    public readonly string $endpoint;
    public readonly string $roomId;
    public readonly string $roomName;
    public readonly string $participantIdentity;
    public readonly TokenPermissions $permissions;
    /** @var list<IceServer> */
    public readonly array $iceServers;
    public readonly string $telemetryUrl;
    public readonly string $expiresAt;
    public readonly string $createdAt;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->token = self::str($data, 'token');
        $this->endpoint = self::str($data, 'endpoint');
        $this->roomId = self::str($data, 'roomId');
        $this->roomName = self::str($data, 'roomName');
        $this->participantIdentity = self::str($data, 'participantIdentity');
        $this->permissions = TokenPermissions::fromArray(is_array($data['permissions'] ?? null) ? $data['permissions'] : []);
        $this->iceServers = IceServer::listFrom($data['iceServers'] ?? null);
        $this->telemetryUrl = self::str($data, 'telemetryUrl');
        $this->expiresAt = self::str($data, 'expiresAt');
        $this->createdAt = self::str($data, 'createdAt');
    }
}
