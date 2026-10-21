<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `ErrorDetail`. */
final class ErrorDetail extends ErrorSummary
{
    public readonly ?ConnectionSummary $connection;

    protected function hydrate(array $data): void
    {
        parent::hydrate($data);
        $this->connection = ConnectionSummary::fromNullable($data['connection'] ?? null);
    }
}
