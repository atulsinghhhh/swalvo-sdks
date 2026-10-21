<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Http\HttpClient;
use Swalvo\SwalvoException;

/** @internal */
abstract class ApiResource
{
    public function __construct(protected readonly HttpClient $http)
    {
    }

    /**
     * One URL path segment, percent-encoded. An empty id is refused locally instead of quietly turning
     * `/v1/rooms/{id}` into `/v1/rooms/` and hitting a different route.
     */
    protected static function seg(string $value, string $name): string
    {
        if ($value === '') {
            throw new SwalvoException("{$name} must be a non-empty string", 'VALIDATION_ERROR');
        }

        return rawurlencode($value);
    }

    /**
     * @param array<string, mixed> $params
     */
    protected static function requireParam(array $params, string $key): string
    {
        $value = $params[$key] ?? null;
        if (!is_string($value) || $value === '') {
            throw new SwalvoException("'{$key}' is required", 'VALIDATION_ERROR');
        }

        return $value;
    }

    /**
     * Drops null values, the way `JSON.stringify` drops `undefined` in the TypeScript SDK.
     *
     * @param array<string, mixed> $values
     * @return array<string, mixed>
     */
    protected static function compact(array $values): array
    {
        return array_filter($values, static fn ($v): bool => $v !== null);
    }
}
