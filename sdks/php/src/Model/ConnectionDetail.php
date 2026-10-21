<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** TS: `ConnectionDetail` (a `ConnectionSummary` plus its events and errors). */
final class ConnectionDetail extends ConnectionSummary
{
    /** @var list<ConnectionEventEntry> */
    public readonly array $events;
    /** @var list<ErrorSummary> */
    public readonly array $errors;

    protected function hydrate(array $data): void
    {
        parent::hydrate($data);
        $this->events = ConnectionEventEntry::listFrom($data['events'] ?? null);
        $this->errors = ErrorSummary::listFrom($data['errors'] ?? null);
    }
}
