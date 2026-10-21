<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Model\ConnectionDetail;
use Swalvo\Model\ConnectionSummary;

/** Event-sourced RTC connection records, read from your backend. */
final class Connections extends ApiResource
{
    /**
     * `GET /v1/connections`
     *
     * @param array{roomId?: string, state?: 'CONNECTING'|'CONNECTED'|'RECONNECTING'|'DISCONNECTED'|'FAILED', limit?: int} $params
     * @return list<ConnectionSummary>
     */
    public function list(array $params = []): array
    {
        return ConnectionSummary::listFrom($this->http->request('GET', '/v1/connections', query: [
            'roomId' => $params['roomId'] ?? null,
            'state' => $params['state'] ?? null,
            'limit' => $params['limit'] ?? null,
        ]));
    }

    /** `GET /v1/connections/{connectionId}` */
    public function get(string $connectionId): ConnectionDetail
    {
        return ConnectionDetail::fromArray((array) $this->http->request('GET', '/v1/connections/' . self::seg($connectionId, 'connectionId')));
    }
}
