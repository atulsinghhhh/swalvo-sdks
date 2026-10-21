<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** A stream's single ingest endpoint. Never includes the stream key. TS: `IngressView`. */
class IngressView extends Model
{
    public readonly string $id;
    /** WHIP | RTMP */
    public readonly string $protocol;
    public readonly string $identity;
    public readonly string $keyPrefix;
    public readonly bool $autoStart;
    /** IDLE | CONNECTING | PUBLISHING | RECONNECTING | DISCONNECTED | FAILED */
    public readonly string $status;
    public readonly int $reconnectWindowSec;
    public readonly ?string $lastError;
    public readonly ?IngressInputVideo $inputVideo;
    public readonly ?IngressInputAudio $inputAudio;
    public readonly string $whipUrl;
    public readonly string $rtmpUrl;
    public readonly string $rtmpsUrl;
    public readonly ?string $connectedAt;
    public readonly ?string $disconnectedAt;
    public readonly string $createdAt;
    public readonly string $updatedAt;

    protected function hydrate(array $data): void
    {
        $this->id = self::str($data, 'id');
        $this->protocol = self::str($data, 'protocol');
        $this->identity = self::str($data, 'identity');
        $this->keyPrefix = self::str($data, 'keyPrefix');
        $this->autoStart = self::bool($data, 'autoStart');
        $this->status = self::str($data, 'status');
        $this->reconnectWindowSec = self::int($data, 'reconnectWindowSec');
        $this->lastError = self::nstr($data, 'lastError');
        $this->inputVideo = IngressInputVideo::fromNullable($data['inputVideo'] ?? null);
        $this->inputAudio = IngressInputAudio::fromNullable($data['inputAudio'] ?? null);
        $this->whipUrl = self::str($data, 'whipUrl');
        $this->rtmpUrl = self::str($data, 'rtmpUrl');
        $this->rtmpsUrl = self::str($data, 'rtmpsUrl');
        $this->connectedAt = self::nstr($data, 'connectedAt');
        $this->disconnectedAt = self::nstr($data, 'disconnectedAt');
        $this->createdAt = self::str($data, 'createdAt');
        $this->updatedAt = self::str($data, 'updatedAt');
    }
}
