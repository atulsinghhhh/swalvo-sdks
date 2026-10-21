<?php

declare(strict_types=1);

namespace Swalvo\Http;

final class Response
{
    /** @var array<string, string> lower-cased header names */
    public readonly array $headers;

    /** @param array<string, string> $headers */
    public function __construct(
        public readonly int $status,
        array $headers = [],
        public readonly string $body = '',
    ) {
        $normalized = [];
        foreach ($headers as $name => $value) {
            $normalized[strtolower((string) $name)] = $value;
        }
        $this->headers = $normalized;
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    /** @param array<string, string> $headers */
    public static function json(int $status, mixed $payload, array $headers = []): self
    {
        return new self($status, $headers + ['content-type' => 'application/json'], json_encode($payload, JSON_THROW_ON_ERROR));
    }
}
