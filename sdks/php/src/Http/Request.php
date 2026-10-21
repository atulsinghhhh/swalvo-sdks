<?php

declare(strict_types=1);

namespace Swalvo\Http;

/**
 * One outgoing request, as handed to a transport.
 *
 * The headers (which include `Authorization: Bearer <api key>`) are not a property of this object: they sit
 * in a class-private WeakMap keyed by the instance, so `var_dump`, `print_r`, `var_export`, an `(array)`
 * cast or an exception's stack trace that captured this object as an argument can't reveal them.
 * `__debugInfo` shows the headers with the Authorization value redacted.
 */
final class Request
{
    /** @var \WeakMap<self, array<string, string>>|null */
    private static ?\WeakMap $headerStore = null;

    /**
     * @param array<string, string> $headers
     * @param float $timeout seconds
     */
    public function __construct(
        public readonly string $method,
        public readonly string $url,
        #[\SensitiveParameter] array $headers,
        public readonly ?string $body,
        public readonly float $timeout,
    ) {
        self::$headerStore ??= new \WeakMap();
        self::$headerStore[$this] = $headers;
    }

    /** @return array<string, string> */
    public function headers(): array
    {
        return self::$headerStore[$this] ?? [];
    }

    public function header(string $name): ?string
    {
        foreach ($this->headers() as $key => $value) {
            if (strcasecmp($key, $name) === 0) {
                return $value;
            }
        }

        return null;
    }

    /** @return array<string, mixed> */
    public function __debugInfo(): array
    {
        $headers = $this->headers();
        foreach ($headers as $key => $value) {
            if (strcasecmp($key, 'Authorization') === 0) {
                $headers[$key] = 'Bearer [REDACTED]';
            }
        }

        return [
            'method' => $this->method,
            'url' => $this->url,
            'headers' => $headers,
            'body' => $this->body,
            'timeout' => $this->timeout,
        ];
    }

    /** @return never */
    public function __serialize(): array
    {
        throw new \LogicException('A Swalvo request carries the API key and cannot be serialized.');
    }
}
