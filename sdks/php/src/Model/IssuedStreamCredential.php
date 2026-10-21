<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** Host, co-host or viewer credentials for a stream. Forward with `json_encode($credential)`. TS: `IssuedStreamCredential`. */
final class IssuedStreamCredential extends Model
{
    public readonly string $streamId;
    public readonly string $identity;
    /** HOST | CO_HOST | VIEWER */
    public readonly string $role;
    /** Absent (null) on a BROADCAST viewer's playback credential. */
    public readonly ?IssuedToken $rtc;
    public readonly ?IssuedChatToken $chat;
    public readonly ?string $chatRootMessageId;
    /** The stream's public id. Edge placement for a cascaded viewer is carried by the `rtc` token itself, never here. Absent on a playback credential. */
    public readonly ?string $rtcRoom;
    public readonly ?StreamPlayback $playback;

    protected function hydrate(array $data): void
    {
        $this->streamId = self::str($data, 'streamId');
        $this->identity = self::str($data, 'identity');
        $this->role = self::str($data, 'role');
        $this->rtc = IssuedToken::fromNullable($data['rtc'] ?? null);
        $this->chat = IssuedChatToken::fromNullable($data['chat'] ?? null);
        $this->chatRootMessageId = self::nstr($data, 'chatRootMessageId');
        $this->rtcRoom = self::nstr($data, 'rtcRoom');
        $this->playback = StreamPlayback::fromNullable($data['playback'] ?? null);
    }
}
