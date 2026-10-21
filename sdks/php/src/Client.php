<?php

declare(strict_types=1);

namespace Swalvo;

use Swalvo\Http\HttpClient;
use Swalvo\Http\TransportInterface;
use Swalvo\Resources\Chat;
use Swalvo\Resources\Connections;
use Swalvo\Resources\Diagnostics;
use Swalvo\Resources\Errors;
use Swalvo\Resources\LiveStreams;
use Swalvo\Resources\Metrics;
use Swalvo\Resources\Projects;
use Swalvo\Resources\Rooms;
use Swalvo\Resources\Tokens;

/**
 * Swalvo's server SDK. For your backend only.
 *
 * Authenticates with a permanent project API key. Never expose that key, or this object, to a browser:
 * the browser gets a short-lived token that this SDK mints.
 *
 * ```php
 * $client = new \Swalvo\Client(
 *     apiKey: getenv('SWALVO_API_KEY'),
 *     baseUrl: getenv('SWALVO_API_URL'), // https://api.swalvo.com
 * );
 * $grant = $client->tokens->create(['room' => $roomId, 'identity' => 'user-42']);
 * ```
 */
final class Client implements \JsonSerializable
{
    public readonly Projects $projects;
    public readonly Tokens $tokens;
    public readonly Rooms $rooms;
    public readonly Connections $connections;
    public readonly Errors $errors;
    public readonly Metrics $metrics;
    public readonly Diagnostics $diagnostics;
    /** Swalvo Chat: mint browser tokens, manage conversations, post server-side messages. */
    public readonly Chat $chat;
    /** Swalvo Live Streaming: create streams, register hosts, mint viewer credentials. */
    public readonly LiveStreams $liveStreams;
    /** `liveStreams` under the shorter name. The same object: `$client->live === $client->liveStreams`. */
    public readonly LiveStreams $live;

    private readonly HttpClient $http;

    /**
     * @param string|false|null $apiKey a project API key (`rvk_....secret`); `getenv()`'s `false` is accepted
     *                                  so a missing variable fails with RAVEN_INVALID_CONFIG, not a TypeError
     * @param string|null $baseUrl defaults to http://localhost:4100 (local dev); required when APP_ENV is production
     * @param float $timeout request timeout in seconds
     * @param int $maxRetries retries for network errors and 429/502/503/504
     * @param TransportInterface|null $transport defaults to the ext-curl transport
     *
     * @throws SwalvoException RAVEN_INVALID_CONFIG
     */
    public function __construct(
        #[\SensitiveParameter] string|false|null $apiKey,
        string|false|null $baseUrl = null,
        float $timeout = HttpClient::DEFAULT_TIMEOUT_SECONDS,
        int $maxRetries = HttpClient::DEFAULT_MAX_RETRIES,
        ?TransportInterface $transport = null,
    ) {
        $this->http = new HttpClient(
            $apiKey,
            $baseUrl === false ? null : $baseUrl,
            $timeout,
            $maxRetries,
            $transport,
        );
        $this->projects = new Projects($this->http);
        $this->tokens = new Tokens($this->http);
        $this->rooms = new Rooms($this->http);
        $this->connections = new Connections($this->http);
        $this->errors = new Errors($this->http);
        $this->metrics = new Metrics($this->http);
        $this->diagnostics = new Diagnostics($this->http);
        $this->chat = new Chat($this->http);
        $this->liveStreams = new LiveStreams($this->http);
        $this->live = $this->liveStreams;
    }

    public function __toString(): string
    {
        return 'Swalvo\\Client(' . $this->http->baseUrl() . ')';
    }

    /** Never includes the API key. */
    public function jsonSerialize(): array
    {
        return ['baseUrl' => $this->http->baseUrl()];
    }

    /** @return array<string, mixed> */
    public function __debugInfo(): array
    {
        return [
            'baseUrl' => $this->http->baseUrl(),
            'apiKey' => '[REDACTED]',
            'resources' => ['projects', 'tokens', 'rooms', 'connections', 'errors', 'metrics', 'diagnostics', 'chat', 'liveStreams', 'live'],
        ];
    }

    /** @return never */
    public function __serialize(): array
    {
        throw new \LogicException('A Swalvo client holds an API key and cannot be serialized.');
    }
}
