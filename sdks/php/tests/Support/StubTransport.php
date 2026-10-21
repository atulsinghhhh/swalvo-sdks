<?php

declare(strict_types=1);

namespace Swalvo\Tests\Support;

use Swalvo\Http\Request;
use Swalvo\Http\Response;
use Swalvo\Http\TransportException;
use Swalvo\Http\TransportInterface;

/** Records every request and replays queued responses (or throws queued transport failures). No network. */
final class StubTransport implements TransportInterface
{
    /** @var list<Request> */
    public array $requests = [];

    /** @var list<Response|TransportException|\Closure(Request): Response> */
    private array $queue;

    public function __construct(Response|TransportException|\Closure ...$responses)
    {
        $this->queue = array_values($responses);
    }

    public function push(Response|TransportException|\Closure ...$responses): void
    {
        array_push($this->queue, ...$responses);
    }

    public function send(Request $request): Response
    {
        $this->requests[] = $request;
        $next = array_shift($this->queue) ?? Response::json(200, []);
        if ($next instanceof TransportException) {
            throw $next;
        }
        if ($next instanceof \Closure) {
            return $next($request);
        }

        return $next;
    }

    public function last(): Request
    {
        if ($this->requests === []) {
            throw new \LogicException('No request was sent');
        }

        return $this->requests[count($this->requests) - 1];
    }

    /** The last request's path plus query, relative to the base URL. */
    public function lastTarget(): string
    {
        $url = $this->last()->url;
        $path = (string) parse_url($url, PHP_URL_PATH);
        $query = parse_url($url, PHP_URL_QUERY);

        return $query === null || $query === false ? $path : $path . '?' . $query;
    }

    public function lastJson(): mixed
    {
        $body = $this->last()->body;

        return $body === null ? null : json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    }
}
