<?php

declare(strict_types=1);

namespace Swalvo\Http;

/**
 * Sends one HTTP request. The default is {@see CurlTransport}; inject your own (or a stub in tests)
 * through `new Client(transport: ...)`.
 *
 * Contract: return a {@see Response} for every HTTP response, whatever its status, and throw
 * {@see TransportException} when no response arrived at all (DNS, connection refused, TLS, timeout).
 * Retries, error mapping and JSON live in {@see HttpClient}, not here.
 */
interface TransportInterface
{
    /** @throws TransportException */
    public function send(Request $request): Response;
}
