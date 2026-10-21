<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Model\ProjectDiagnostics;

/**
 * Project-scoped diagnostics: signaling, SFU and TURN health, plus this project's active-connection count.
 * Browser-side ICE/signaling state only exists inside a running client SDK.
 */
final class Diagnostics extends ApiResource
{
    /** `GET /v1/diagnostics` */
    public function get(): ProjectDiagnostics
    {
        return ProjectDiagnostics::fromArray((array) $this->http->request('GET', '/v1/diagnostics'));
    }
}
