<?php

declare(strict_types=1);

namespace Swalvo\Http;

/**
 * Thrown by a transport when no HTTP response arrived. {@see HttpClient} retries it and finally wraps it
 * in a `SwalvoException` (`RAVEN_TIMEOUT` or `RAVEN_NETWORK_ERROR`), so callers never see this type.
 */
final class TransportException extends \RuntimeException
{
    public function __construct(string $message, private readonly bool $timeout = false, ?\Throwable $previous = null)
    {
        parent::__construct($message, 0, $previous);
    }

    public function isTimeout(): bool
    {
        return $this->timeout;
    }
}
