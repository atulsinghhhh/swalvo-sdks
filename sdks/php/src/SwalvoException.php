<?php

declare(strict_types=1);

namespace Swalvo;

/**
 * The only exception this SDK throws (the PHP counterpart of the TypeScript SDK's `SwalvoError`).
 *
 * Built purely from the parsed response body (`{message, code}`, matching `AppError` on the API side)
 * plus response metadata. Never from anything that carries the API key, and the HTTP layer additionally
 * scrubs the key out of the message and details should a server ever echo it back.
 *
 * `$errorCode` is the API's string code (`RAVEN_ROOM_NOT_FOUND`, `RAVEN_INVALID_CONFIG`, ...). PHP's own
 * `getCode()` is an int and final, so it carries the HTTP status (or 0) instead.
 */
final class SwalvoException extends \RuntimeException
{
    public readonly string $errorCode;
    public readonly ?int $statusCode;
    public readonly ?string $requestId;
    public readonly mixed $details;

    public function __construct(
        string $message,
        string $errorCode = 'RAVEN_UNKNOWN_ERROR',
        ?int $statusCode = null,
        ?string $requestId = null,
        mixed $details = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, $statusCode ?? 0, $previous);
        $this->errorCode = $errorCode;
        $this->statusCode = $statusCode;
        $this->requestId = $requestId;
        $this->details = $details;
    }

    public function getErrorCode(): string
    {
        return $this->errorCode;
    }

    public function getStatusCode(): ?int
    {
        return $this->statusCode;
    }

    public function getRequestId(): ?string
    {
        return $this->requestId;
    }

    public function getDetails(): mixed
    {
        return $this->details;
    }

    public function __toString(): string
    {
        $status = $this->statusCode !== null ? " (HTTP {$this->statusCode})" : '';
        $request = $this->requestId !== null ? " [request {$this->requestId}]" : '';

        return self::class . " {$this->errorCode}{$status}: {$this->getMessage()}{$request}";
    }
}
