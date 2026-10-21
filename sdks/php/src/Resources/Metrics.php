<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Model\MetricsOverview;

/** Real aggregate metrics only. This doubles as today's "usage" view. */
final class Metrics extends ApiResource
{
    /**
     * `GET /v1/metrics`
     *
     * @param '15m'|'1h'|'24h'|'7d'|null $range
     */
    public function get(?string $range = null): MetricsOverview
    {
        return MetricsOverview::fromArray((array) $this->http->request('GET', '/v1/metrics', query: ['range' => $range]));
    }
}
