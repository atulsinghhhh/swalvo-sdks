<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Model\Project;

/**
 * An API key is permanently scoped to exactly one project, so there's nothing to list, create, update
 * or delete here. `get()` always returns the project this key belongs to.
 */
final class Projects extends ApiResource
{
    /** `GET /v1/project` */
    public function get(): Project
    {
        return Project::fromArray((array) $this->http->request('GET', '/v1/project'));
    }
}
