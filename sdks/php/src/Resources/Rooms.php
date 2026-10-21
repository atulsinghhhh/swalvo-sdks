<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Http\HttpClient;
use Swalvo\Model\Room;

/**
 * Rooms are control-plane records. `delete()` soft-closes a room (status CLOSED); it never destroys history.
 */
final class Rooms extends ApiResource
{
    /** The SFU's live participant view. */
    public readonly RoomParticipants $participants;

    public function __construct(HttpClient $http)
    {
        parent::__construct($http);
        $this->participants = new RoomParticipants($http);
    }

    /**
     * `GET /v1/rooms`
     *
     * @return list<Room>
     */
    public function list(): array
    {
        return Room::listFrom($this->http->request('GET', '/v1/rooms'));
    }

    /** `GET /v1/rooms/{roomId}` */
    public function get(string $roomId): Room
    {
        return Room::fromArray((array) $this->http->request('GET', '/v1/rooms/' . self::seg($roomId, 'roomId')));
    }

    /**
     * `POST /v1/rooms`
     *
     * Pass `getOrCreate: true` when several participants may create the same room at once: the loser of
     * that race gets the winner's room instead of a 409. `e2ee: true` makes the room end-to-end encrypted
     * for its whole life.
     *
     * @param array{name: string, getOrCreate?: bool, e2ee?: bool} $params
     */
    public function create(array $params): Room
    {
        return Room::fromArray((array) $this->http->request('POST', '/v1/rooms', body: $params));
    }

    /** `DELETE /v1/rooms/{roomId}`: soft-closes the room (status CLOSED). Never a hard delete. */
    public function delete(string $roomId): void
    {
        $this->http->request('DELETE', '/v1/rooms/' . self::seg($roomId, 'roomId'));
    }
}
