<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\SwalvoException;
use Swalvo\Model\LiveParticipantInfo;
use Swalvo\Model\ParticipantPermissions;

/**
 * Always the SFU's current live state, never a stored roster. `null` means the SFU couldn't be reached,
 * which is different from a genuinely empty room (`[]`).
 *
 * `remove()`, `mute()` and `updatePermissions()` moderate a participant who is connected right now.
 * `$roomId` may be the room's id or its name. A participant who isn't connected is a 404 with code
 * `RAVEN_PARTICIPANT_NOT_CONNECTED`.
 */
final class RoomParticipants extends ApiResource
{
    /**
     * `GET /v1/rooms/{roomId}/participants`
     *
     * @return list<LiveParticipantInfo>|null
     */
    public function list(string $roomId): ?array
    {
        $result = $this->http->request('GET', '/v1/rooms/' . self::seg($roomId, 'roomId') . '/participants');

        return $result === null ? null : LiveParticipantInfo::listFrom($result);
    }

    /** One participant by identity from the live list; null if absent or if the SFU is unreachable. */
    public function get(string $roomId, string $identity): ?LiveParticipantInfo
    {
        foreach ($this->list($roomId) ?? [] as $participant) {
            if ($participant->identity === $identity) {
                return $participant;
            }
        }

        return null;
    }

    /**
     * `POST /v1/rooms/{roomId}/participants/{identity}/remove`. Disconnects every live session of the
     * identity. Doesn't revoke their token: revoke it too to keep them out.
     *
     * @throws SwalvoException `RAVEN_PARTICIPANT_NOT_CONNECTED` (404) when they aren't connected
     */
    public function remove(string $roomId, string $identity): void
    {
        $this->http->request('POST', self::path($roomId, $identity) . '/remove', body: []);
    }

    /**
     * `POST /v1/rooms/{roomId}/participants/{identity}/mute`. Mutes, or unmutes, one track or every track
     * of one kind.
     *
     * @param array{trackId?: string, kind?: 'audio'|'video', muted: bool} $params exactly one of `trackId`
     *     and `kind`; `muted: false` unmutes
     * @throws SwalvoException `VALIDATION_ERROR` before sending for both or neither of `trackId` and
     *     `kind`, or a missing `muted`; `RAVEN_PARTICIPANT_NOT_CONNECTED` or `RAVEN_TRACK_NOT_FOUND` (404)
     */
    public function mute(string $roomId, string $identity, array $params): void
    {
        $trackId = $params['trackId'] ?? null;
        $kind = $params['kind'] ?? null;
        if (($trackId === null) === ($kind === null)) {
            throw new SwalvoException("Exactly one of 'trackId' or 'kind' is required", 'VALIDATION_ERROR');
        }
        if ($trackId !== null && (!is_string($trackId) || $trackId === '')) {
            throw new SwalvoException("'trackId' must be a non-empty string", 'VALIDATION_ERROR');
        }
        if ($kind !== null && $kind !== 'audio' && $kind !== 'video') {
            throw new SwalvoException("'kind' must be 'audio' or 'video'", 'VALIDATION_ERROR');
        }
        if (!is_bool($params['muted'] ?? null)) {
            throw new SwalvoException("'muted' is required and must be a boolean", 'VALIDATION_ERROR');
        }

        $this->http->request('POST', self::path($roomId, $identity) . '/mute', body: self::compact([
            'trackId' => $trackId,
            'kind' => $kind,
            'muted' => $params['muted'],
        ]));
    }

    /**
     * `PATCH /v1/rooms/{roomId}/participants/{identity}/permissions`. Merges into the live session's
     * permissions and returns the result. Only the fields you pass are sent, `false` included; the rest
     * stay as they are. Issued tokens are not changed.
     *
     * @param array{subscribe?: bool, publish?: bool, publishAudio?: bool, publishVideo?: bool, publishScreen?: bool, publishData?: bool} $permissions
     *     at least one
     * @throws SwalvoException `VALIDATION_ERROR` before sending when none is set or one isn't a boolean;
     *     `RAVEN_PARTICIPANT_NOT_CONNECTED` (404) when they aren't connected
     */
    public function updatePermissions(string $roomId, string $identity, array $permissions): ParticipantPermissions
    {
        $body = [];
        foreach (['subscribe', 'publish', 'publishAudio', 'publishVideo', 'publishScreen', 'publishData'] as $key) {
            $value = $permissions[$key] ?? null;
            if ($value === null) {
                continue;
            }
            if (!is_bool($value)) {
                throw new SwalvoException("'{$key}' must be a boolean", 'VALIDATION_ERROR');
            }
            $body[$key] = $value;
        }
        if ($body === []) {
            throw new SwalvoException('At least one permission is required', 'VALIDATION_ERROR');
        }

        return ParticipantPermissions::fromArray((array) $this->http->request('PATCH', self::path($roomId, $identity) . '/permissions', body: $body));
    }

    private static function path(string $roomId, string $identity): string
    {
        return '/v1/rooms/' . self::seg($roomId, 'roomId') . '/participants/' . self::seg($identity, 'identity');
    }
}
