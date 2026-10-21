<?php

declare(strict_types=1);

namespace Swalvo\Http;

use Swalvo\SwalvoException;
use Swalvo\Version;

/**
 * The one place this SDK speaks HTTP to the Control API. Every resource goes through here.
 *
 * Mirrors packages/server-sdk/src/http-client.ts: bearer auth, a User-Agent naming the SDK, a 10 s
 * timeout, and up to 2 retries with exponential backoff from 300 ms, only for network errors and
 * 429/502/503/504.
 *
 * The API key is never a property of this object. It sits in a class-private WeakMap keyed by the instance
 * (PHP's closest thing to a JS `#private` field), so `var_dump`, `print_r`, `var_export`, `(array)` casts,
 * `get_object_vars` and `json_encode` of the client can't reach it. Serializing the client is refused.
 *
 * @internal Construct a {@see \Swalvo\Client}; resources call {@see request()}.
 */
final class HttpClient implements \JsonSerializable
{
    public const DEFAULT_BASE_URL = 'http://localhost:4100';
    public const DEFAULT_TIMEOUT_SECONDS = 10.0;
    public const DEFAULT_MAX_RETRIES = 2;
    public const BASE_RETRY_DELAY_MS = 300;
    public const RETRYABLE_STATUS_CODES = [429, 502, 503, 504];

    /** @var \WeakMap<self, string>|null */
    private static ?\WeakMap $apiKeys = null;
    private readonly string $baseUrl;
    private readonly float $timeout;
    private readonly int $maxRetries;
    private readonly TransportInterface $transport;
    /** @var \Closure(int): void milliseconds */
    private readonly \Closure $sleep;

    /**
     * @param float $timeout seconds
     * @param (\Closure(int): void)|null $sleep receives the backoff in milliseconds; tests inject a recorder
     */
    public function __construct(
        #[\SensitiveParameter] string|false|null $apiKey,
        ?string $baseUrl = null,
        float $timeout = self::DEFAULT_TIMEOUT_SECONDS,
        int $maxRetries = self::DEFAULT_MAX_RETRIES,
        ?TransportInterface $transport = null,
        ?\Closure $sleep = null,
    ) {
        if (!is_string($apiKey) || trim($apiKey) === '') {
            throw new SwalvoException(
                "apiKey is required; pass your Swalvo project API key, e.g. apiKey: getenv('SWALVO_API_KEY')",
                'RAVEN_INVALID_CONFIG',
            );
        }

        // TS throws when NODE_ENV=production and baseUrl is omitted, instead of silently falling back to a
        // local dev stack that doesn't exist in production. PHP frameworks signal production via APP_ENV
        // (Laravel: "production", Symfony: "prod").
        if (($baseUrl === null || $baseUrl === '') && self::isProductionEnvironment()) {
            throw new SwalvoException(
                'baseUrl is required outside local development. Pass your Swalvo API host, e.g. ' .
                "baseUrl: 'https://api.livqeno.com' (or your self-hosted deployment's URL) — " .
                'omitting it defaults to ' . self::DEFAULT_BASE_URL . ', which does not exist in production.',
                'RAVEN_INVALID_CONFIG',
            );
        }

        $baseUrl = ($baseUrl === null || $baseUrl === '') ? self::DEFAULT_BASE_URL : $baseUrl;
        $scheme = strtolower((string) parse_url($baseUrl, PHP_URL_SCHEME));
        if ($scheme !== 'http' && $scheme !== 'https') {
            throw new SwalvoException(
                'baseUrl must be an absolute http(s) URL, e.g. https://api.livqeno.com',
                'RAVEN_INVALID_CONFIG',
            );
        }
        if ($timeout <= 0) {
            throw new SwalvoException('timeout must be a positive number of seconds', 'RAVEN_INVALID_CONFIG');
        }

        self::$apiKeys ??= new \WeakMap();
        self::$apiKeys[$this] = $apiKey;
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->timeout = $timeout;
        $this->maxRetries = max(0, $maxRetries);
        $this->transport = $transport ?? new CurlTransport();
        $this->sleep = $sleep ?? static function (int $ms): void {
            usleep($ms * 1000);
        };
    }

    public function baseUrl(): string
    {
        return $this->baseUrl;
    }

    /**
     * @param array<string, scalar|null>|null $query null values are omitted; booleans become "true"/"false"
     * @param bool $retryable false for requests that must never be retried, transient failure or not
     * @return mixed the decoded JSON body (associative arrays), or null for a 204
     * @throws SwalvoException
     */
    public function request(
        string $method,
        string $path,
        ?array $query = null,
        mixed $body = null,
        bool $retryable = true,
    ): mixed {
        $url = $this->buildUrl($path, $query);
        $encodedBody = $body === null ? null : $this->encodeBody($body);

        $attempt = 0;
        while (true) {
            $request = new Request($method, $url, $this->headers(), $encodedBody, $this->timeout);

            try {
                $response = $this->transport->send($request);
            } catch (TransportException $error) {
                if ($retryable && $attempt < $this->maxRetries) {
                    ($this->sleep)(self::backoffMs($attempt));
                    $attempt++;
                    continue;
                }
                $timedOut = $error->isTimeout();
                throw new SwalvoException(
                    $timedOut
                        ? sprintf('Request timed out after %dms', (int) round($this->timeout * 1000))
                        : 'Could not reach the Swalvo API',
                    $timedOut ? 'RAVEN_TIMEOUT' : 'RAVEN_NETWORK_ERROR',
                    previous: $error,
                );
            }

            $requestId = $response->header('x-request-id');

            if ($response->status === 204) {
                return null;
            }

            $payload = self::decode($response->body);

            if ($response->status >= 200 && $response->status < 300) {
                return $payload;
            }

            if ($retryable && in_array($response->status, self::RETRYABLE_STATUS_CODES, true) && $attempt < $this->maxRetries) {
                ($this->sleep)(self::backoffMs($attempt));
                $attempt++;
                continue;
            }

            // Defence in depth: should a server or proxy ever echo the bearer token back, it stops here, before
            // the payload is passed anywhere a stack frame could capture it.
            $secret = $this->apiKey();
            throw self::mapErrorResponse(
                $response->status,
                self::scrub($payload, $secret),
                $requestId === null ? null : self::scrub($requestId, $secret),
            );
        }
    }

    public static function backoffMs(int $attempt): int
    {
        return self::BASE_RETRY_DELAY_MS * (2 ** $attempt);
    }

    public function __toString(): string
    {
        return "Swalvo\\Http\\HttpClient({$this->baseUrl})";
    }

    /** Never includes the API key. */
    public function jsonSerialize(): array
    {
        return ['baseUrl' => $this->baseUrl];
    }

    /** @return array<string, mixed> */
    public function __debugInfo(): array
    {
        return [
            'baseUrl' => $this->baseUrl,
            'timeout' => $this->timeout,
            'maxRetries' => $this->maxRetries,
            'transport' => $this->transport::class,
            'apiKey' => '[REDACTED]',
        ];
    }

    /** @return never */
    public function __serialize(): array
    {
        throw new \LogicException('A Swalvo client holds an API key and cannot be serialized.');
    }

    private function apiKey(): string
    {
        return self::$apiKeys[$this] ?? '';
    }

    /** @return array<string, string> */
    private function headers(): array
    {
        return [
            'Content-Type' => 'application/json',
            'Accept' => 'application/json',
            'Authorization' => 'Bearer ' . $this->apiKey(),
            'User-Agent' => sprintf('Swalvo-Server-SDK/%s (php %s)', Version::SDK_VERSION, PHP_VERSION),
        ];
    }

    /** @param array<string, scalar|null>|null $query */
    private function buildUrl(string $path, ?array $query): string
    {
        $url = $this->baseUrl . $path;
        if ($query === null) {
            return $url;
        }

        $pairs = [];
        foreach ($query as $key => $value) {
            if ($value === null) {
                continue;
            }
            $pairs[$key] = is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;
        }
        if ($pairs === []) {
            return $url;
        }

        return $url . (str_contains($url, '?') ? '&' : '?') . http_build_query($pairs, '', '&', PHP_QUERY_RFC1738);
    }

    private function encodeBody(mixed $body): string
    {
        try {
            return json_encode(
                self::normalizeBody($body),
                JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION,
            );
        } catch (\JsonException $error) {
            throw new SwalvoException('Request body could not be encoded as JSON: ' . $error->getMessage(), 'VALIDATION_ERROR', previous: $error);
        }
    }

    /**
     * PHP's `[]` is ambiguous; on the wire the body and any `metadata` map are JSON objects, never arrays.
     */
    private static function normalizeBody(mixed $body): mixed
    {
        if ($body === []) {
            return new \stdClass();
        }
        if (is_array($body) && array_key_exists('metadata', $body) && $body['metadata'] === []) {
            $body['metadata'] = new \stdClass();
        }

        return $body;
    }

    private static function decode(string $body): mixed
    {
        if ($body === '') {
            return null;
        }
        try {
            return json_decode($body, true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
        } catch (\JsonException) {
            return null;
        }
    }

    private static function mapErrorResponse(int $status, mixed $payload, ?string $requestId): SwalvoException
    {
        $message = self::extractMessage($payload) ?? "Request failed with status {$status}";
        $code = self::extractCode($payload) ?? self::codeForStatus($status);

        return new SwalvoException($message, $code, $status, $requestId, $payload);
    }

    /** Same names the API returns, so a 401 is RAVEN_AUTH_ERROR whether the code came from the body or from here. */
    public static function codeForStatus(int $status): string
    {
        return match (true) {
            $status === 401 => 'RAVEN_AUTH_ERROR',
            $status === 403 => 'RAVEN_PERMISSION_DENIED',
            $status === 404 => 'RAVEN_NOT_FOUND',
            $status === 429 => 'RAVEN_RATE_LIMITED',
            $status >= 500 => 'RAVEN_INTERNAL_ERROR',
            default => 'VALIDATION_ERROR',
        };
    }

    private static function extractMessage(mixed $payload): ?string
    {
        if (!is_array($payload) || !array_key_exists('message', $payload)) {
            return null;
        }
        $message = $payload['message'];
        if (is_string($message)) {
            return $message;
        }
        if (is_array($message) && array_is_list($message)) {
            return implode('; ', array_map(static fn ($m): string => is_scalar($m) ? (string) $m : (string) json_encode($m), $message));
        }

        return null;
    }

    private static function extractCode(mixed $payload): ?string
    {
        if (!is_array($payload)) {
            return null;
        }
        $code = $payload['code'] ?? null;

        return is_string($code) ? $code : null;
    }

    /**
     * @template T
     * @param T $value
     * @return T
     */
    private static function scrub(mixed $value, #[\SensitiveParameter] string $secret): mixed
    {
        if (is_string($value)) {
            return str_replace($secret, '[REDACTED]', $value);
        }
        if (is_array($value)) {
            $clean = [];
            foreach ($value as $key => $item) {
                $clean[is_string($key) ? str_replace($secret, '[REDACTED]', $key) : $key] = self::scrub($item, $secret);
            }

            return $clean;
        }

        return $value;
    }

    private static function isProductionEnvironment(): bool
    {
        foreach ([getenv('APP_ENV'), $_ENV['APP_ENV'] ?? null, $_SERVER['APP_ENV'] ?? null] as $value) {
            if (is_string($value) && in_array(strtolower(trim($value)), ['production', 'prod'], true)) {
                return true;
            }
        }

        return false;
    }
}
