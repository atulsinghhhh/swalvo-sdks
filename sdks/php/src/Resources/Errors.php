<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Model\ErrorDetail;
use Swalvo\Model\ErrorSummary;

/** Classified RTC errors. Never a raw SFU or coturn error code. */
final class Errors extends ApiResource
{
    /**
     * `GET /v1/errors`
     *
     * @param array{category?: string, connectionId?: string, limit?: int} $params
     * @return list<ErrorSummary>
     */
    public function list(array $params = []): array
    {
        return ErrorSummary::listFrom($this->http->request('GET', '/v1/errors', query: [
            'category' => $params['category'] ?? null,
            'connectionId' => $params['connectionId'] ?? null,
            'limit' => $params['limit'] ?? null,
        ]));
    }

    /** `GET /v1/errors/{errorId}` */
    public function get(string $errorId): ErrorDetail
    {
        return ErrorDetail::fromArray((array) $this->http->request('GET', '/v1/errors/' . self::seg($errorId, 'errorId')));
    }
}
