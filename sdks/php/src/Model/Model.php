<?php

declare(strict_types=1);

namespace Swalvo\Model;

/**
 * Base for every response object: typed, readonly public properties named exactly like the wire fields
 * in packages/server-sdk/src/types.ts.
 *
 * Hydration is lenient on purpose: a field the API adds later is kept in {@see toArray()} rather than
 * breaking the SDK, and a missing field reads as its type's empty value instead of throwing.
 *
 * `json_encode($model)` returns the exact wire payload, so a minted credential can be forwarded to your
 * frontend untouched: `echo json_encode($grant);`.
 */
abstract class Model implements \JsonSerializable
{
    /** @var array<string, mixed> */
    private readonly array $raw;

    /** @param array<string, mixed> $data */
    final public function __construct(array $data)
    {
        $this->raw = $data;
        $this->hydrate($data);
    }

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): static
    {
        return new static($data);
    }

    /** @return list<static> */
    public static function listFrom(mixed $data): array
    {
        if (!is_array($data)) {
            return [];
        }
        $items = [];
        foreach ($data as $item) {
            $items[] = new static(is_array($item) ? $item : []);
        }

        return $items;
    }

    public static function fromNullable(mixed $data): ?static
    {
        return is_array($data) ? new static($data) : null;
    }

    /** @param array<string, mixed> $data */
    abstract protected function hydrate(array $data): void;

    /** The response exactly as the API sent it, including any field this SDK version doesn't model yet. */
    public function toArray(): array
    {
        return $this->raw;
    }

    public function jsonSerialize(): mixed
    {
        return $this->raw === [] ? new \stdClass() : $this->raw;
    }

    /** @return array<string, mixed> */
    public function __debugInfo(): array
    {
        $vars = get_object_vars($this);
        unset($vars['raw']);

        return $vars;
    }

    /** @param array<string, mixed> $d */
    protected static function str(array $d, string $key): string
    {
        $v = $d[$key] ?? null;

        return is_scalar($v) ? (string) $v : '';
    }

    /** @param array<string, mixed> $d */
    protected static function nstr(array $d, string $key): ?string
    {
        $v = $d[$key] ?? null;

        return is_scalar($v) ? (string) $v : null;
    }

    /** @param array<string, mixed> $d */
    protected static function int(array $d, string $key): int
    {
        return self::nint($d, $key) ?? 0;
    }

    /** @param array<string, mixed> $d */
    protected static function nint(array $d, string $key): ?int
    {
        $v = $d[$key] ?? null;

        return is_int($v) || is_float($v) || (is_string($v) && is_numeric($v)) ? (int) $v : null;
    }

    /** @param array<string, mixed> $d */
    protected static function nfloat(array $d, string $key): ?float
    {
        $v = $d[$key] ?? null;

        return is_int($v) || is_float($v) || (is_string($v) && is_numeric($v)) ? (float) $v : null;
    }

    /** @param array<string, mixed> $d */
    protected static function bool(array $d, string $key): bool
    {
        return ($d[$key] ?? false) === true;
    }

    /** @param array<string, mixed> $d */
    protected static function nbool(array $d, string $key): ?bool
    {
        $v = $d[$key] ?? null;

        return is_bool($v) ? $v : null;
    }

    /**
     * @param array<string, mixed> $d
     * @return array<string, mixed>|null
     */
    protected static function map(array $d, string $key): ?array
    {
        $v = $d[$key] ?? null;

        return is_array($v) ? $v : null;
    }

    /**
     * @param array<string, mixed> $d
     * @return list<string>
     */
    protected static function strList(array $d, string $key): array
    {
        $v = $d[$key] ?? null;
        if (!is_array($v)) {
            return [];
        }

        return array_values(array_map(static fn ($s): string => is_scalar($s) ? (string) $s : '', $v));
    }
}
