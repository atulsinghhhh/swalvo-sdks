<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Model\IssuedToken;

/**
 * Mint a short-lived RTC token server-side, then hand it to your frontend. Every token is short-lived;
 * there's no way to ask for a permanent one.
 */
final class Tokens extends ApiResource
{
    /**
     * `POST /v1/rooms/{room}/rtc-tokens`
     *
     * @param array{
     *     room: string,
     *     identity: string,
     *     permissions?: array{join?: bool, subscribe?: bool, publish?: bool, publishAudio?: bool, publishVideo?: bool, publishScreen?: bool, publishData?: bool},
     *     expiresIn?: int,
     *     metadata?: string
     * } $params `room` is the room's id (not its name); `expiresIn` is seconds, 30 to 21600
     */
    public function create(array $params): IssuedToken
    {
        $room = self::requireParam($params, 'room');
        $identity = self::requireParam($params, 'identity');

        return IssuedToken::fromArray((array) $this->http->request(
            'POST',
            '/v1/rooms/' . self::seg($room, 'room') . '/rtc-tokens',
            body: self::compact([
                'participantIdentity' => $identity,
                'permissions' => $params['permissions'] ?? null,
                'ttlSeconds' => $params['expiresIn'] ?? null,
                'metadata' => $params['metadata'] ?? null,
            ]),
        ));
    }
}
