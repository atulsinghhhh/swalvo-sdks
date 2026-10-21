<?php

declare(strict_types=1);

namespace Swalvo\Tests;

use Swalvo\Http\HttpClient;
use Swalvo\Http\Response;
use Swalvo\Http\TransportException;
use Swalvo\SwalvoException;
use Swalvo\Tests\Support\StubTransport;
use Swalvo\Version;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class HttpClientTest extends TestCase
{
    /** @var list<int> */
    private array $sleeps = [];

    private function client(StubTransport $transport, string $apiKey = 'k', int $maxRetries = 2, float $timeout = 10.0): HttpClient
    {
        return new HttpClient(
            $apiKey,
            'https://api.example.test',
            $timeout,
            $maxRetries,
            $transport,
            function (int $ms): void {
                $this->sleeps[] = $ms;
            },
        );
    }

    private function expectFailure(callable $call): SwalvoException
    {
        try {
            $call();
        } catch (SwalvoException $e) {
            return $e;
        }
        self::fail('expected a SwalvoException');
    }

    public function testSendsBearerAuthAndAUserAgentNamingTheSdk(): void
    {
        $transport = new StubTransport(Response::json(200, []));

        $this->client($transport, 'rvk_abc.secret')->request('GET', '/v1/rooms');

        $request = $transport->last();
        self::assertSame('Bearer rvk_abc.secret', $request->header('Authorization'));
        self::assertSame('application/json', $request->header('Content-Type'));
        self::assertMatchesRegularExpression('#^Swalvo-Server-SDK/\d+\.\d+\.\d+ \(php \d+\.\d+\.\d+.*\)$#', (string) $request->header('User-Agent'));
        self::assertStringContainsString('Swalvo-Server-SDK/' . Version::SDK_VERSION, (string) $request->header('User-Agent'));
        self::assertSame(10.0, $request->timeout);
    }

    public function testEncodesQueryParamsOmittingNullsAndSpellingBooleans(): void
    {
        $transport = new StubTransport(Response::json(200, []));

        $this->client($transport)->request('GET', '/v1/connections', query: [
            'roomId' => 'room 1&x=y',
            'state' => null,
            'limit' => 10,
            'includeArchived' => true,
            'flag' => false,
        ]);

        self::assertSame('/v1/connections?roomId=room+1%26x%3Dy&limit=10&includeArchived=true&flag=false', $transport->lastTarget());
    }

    public function testOmitsTheQueryStringWhenEveryValueIsNull(): void
    {
        $transport = new StubTransport(Response::json(200, []));

        $this->client($transport)->request('GET', '/v1/metrics', query: ['range' => null]);

        self::assertSame('https://api.example.test/v1/metrics', $transport->last()->url);
    }

    public function testEncodesBodiesAsJsonWithEmptyMapsAsObjects(): void
    {
        $transport = new StubTransport(Response::json(200, []), Response::json(200, []));
        $client = $this->client($transport);

        $client->request('POST', '/v1/live-streams/s/ingress', body: []);
        self::assertSame('{}', $transport->last()->body);

        $client->request('POST', '/v1/live-streams', body: ['title' => 'T/1', 'tags' => [], 'metadata' => [], 'ratio' => 1.0, 'name' => 'Zoë']);
        self::assertSame('{"title":"T/1","tags":[],"metadata":{},"ratio":1.0,"name":"Zoë"}', $transport->last()->body);
    }

    public function testSendsNoBodyWhenThereIsNone(): void
    {
        $transport = new StubTransport(Response::json(200, []));

        $this->client($transport)->request('POST', '/v1/live-streams/s/start');

        self::assertNull($transport->last()->body);
        self::assertSame('POST', $transport->last()->method);
    }

    public function testReturnsDecodedJsonAndNullFor204(): void
    {
        $transport = new StubTransport(Response::json(200, ['id' => 'r1', 'nested' => ['a' => 1]]), new Response(204, [], 'ignored'));
        $client = $this->client($transport);

        self::assertSame(['id' => 'r1', 'nested' => ['a' => 1]], $client->request('GET', '/v1/rooms/r1'));
        self::assertNull($client->request('DELETE', '/v1/rooms/r1'));
    }

    public function testRetriesA503WithExponentialBackoffThenSucceeds(): void
    {
        $transport = new StubTransport(
            Response::json(503, ['message' => 'unavailable']),
            Response::json(503, ['message' => 'unavailable']),
            Response::json(200, [['id' => 'r1']]),
        );

        $result = $this->client($transport)->request('GET', '/v1/rooms');

        self::assertSame([['id' => 'r1']], $result);
        self::assertCount(3, $transport->requests);
        self::assertSame([300, 600], $this->sleeps);
    }

    public function testRetriesA429(): void
    {
        $transport = new StubTransport(Response::json(429, ['message' => 'rate limit exceeded']), Response::json(200, []));

        $this->client($transport)->request('GET', '/v1/rooms');

        self::assertCount(2, $transport->requests);
        self::assertSame([300], $this->sleeps);
    }

    /** @return iterable<array{int}> */
    public static function retryableStatuses(): iterable
    {
        return [[429], [502], [503], [504]];
    }

    #[DataProvider('retryableStatuses')]
    public function testGivesUpAfterMaxRetriesOnARetryableStatus(int $status): void
    {
        $transport = new StubTransport(
            Response::json($status, ['message' => 'nope']),
            Response::json($status, ['message' => 'nope']),
            Response::json($status, ['message' => 'nope']),
            Response::json(200, []),
        );

        $e = $this->expectFailure(fn () => $this->client($transport)->request('GET', '/v1/rooms'));

        self::assertSame($status, $e->statusCode);
        self::assertCount(3, $transport->requests);
    }

    /** @return iterable<array{int}> */
    public static function nonRetryableStatuses(): iterable
    {
        return [[400], [401], [403], [404], [409], [422], [500]];
    }

    #[DataProvider('nonRetryableStatuses')]
    public function testNeverRetriesNonTransientStatuses(int $status): void
    {
        $transport = new StubTransport(Response::json($status, ['message' => 'bad input']), Response::json(200, []));

        $e = $this->expectFailure(fn () => $this->client($transport)->request('POST', '/v1/rooms', body: ['name' => 'x']));

        self::assertSame($status, $e->statusCode);
        self::assertCount(1, $transport->requests);
        self::assertSame([], $this->sleeps);
    }

    public function testNeverRetriesWhenRetryableIsFalse(): void
    {
        $transport = new StubTransport(Response::json(503, ['message' => 'unavailable']), Response::json(200, []));

        $e = $this->expectFailure(fn () => $this->client($transport)->request('GET', '/v1/rooms', retryable: false));

        self::assertSame(503, $e->statusCode);
        self::assertCount(1, $transport->requests);
    }

    public function testMapsANetworkFailureToNetworkErrorAfterExhaustingRetries(): void
    {
        $transport = new StubTransport(
            new TransportException('Connection refused'),
            new TransportException('Connection refused'),
            new TransportException('Connection refused'),
        );

        $e = $this->expectFailure(fn () => $this->client($transport)->request('GET', '/v1/rooms'));

        self::assertSame('RAVEN_NETWORK_ERROR', $e->errorCode);
        self::assertSame('Could not reach the Swalvo API', $e->getMessage());
        self::assertInstanceOf(TransportException::class, $e->getPrevious());
        self::assertCount(3, $transport->requests);
        self::assertSame([300, 600], $this->sleeps);
    }

    public function testRecoversFromATransientNetworkFailure(): void
    {
        $transport = new StubTransport(new TransportException('reset'), Response::json(200, ['ok' => true]));

        self::assertSame(['ok' => true], $this->client($transport)->request('GET', '/v1/rooms'));
    }

    public function testMapsATimeoutToSwalvoTimeout(): void
    {
        $transport = new StubTransport(new TransportException('Operation timed out', true));

        $e = $this->expectFailure(fn () => $this->client($transport, maxRetries: 0, timeout: 0.25)->request('GET', '/v1/rooms'));

        self::assertSame('RAVEN_TIMEOUT', $e->errorCode);
        self::assertSame('Request timed out after 250ms', $e->getMessage());
        self::assertSame(0.25, $transport->last()->timeout);
    }

    public function testDecodesAnApiErrorWithCodeStatusRequestIdAndDetails(): void
    {
        $payload = ['statusCode' => 404, 'code' => 'RAVEN_ROOM_NOT_FOUND', 'message' => 'Room not found', 'details' => ['roomId' => 'x']];
        $transport = new StubTransport(Response::json(404, $payload, ['X-Request-Id' => 'req_abc123']));

        $e = $this->expectFailure(fn () => $this->client($transport)->request('GET', '/v1/rooms/x'));

        self::assertSame('RAVEN_ROOM_NOT_FOUND', $e->errorCode);
        self::assertSame('RAVEN_ROOM_NOT_FOUND', $e->getErrorCode());
        self::assertSame(404, $e->statusCode);
        self::assertSame(404, $e->getCode());
        self::assertSame('Room not found', $e->getMessage());
        self::assertSame('req_abc123', $e->requestId);
        self::assertSame($payload, $e->details);
        self::assertStringContainsString('RAVEN_ROOM_NOT_FOUND (HTTP 404): Room not found [request req_abc123]', (string) $e);
    }

    public function testJoinsAValidationMessageArray(): void
    {
        $transport = new StubTransport(Response::json(400, ['message' => ['name must be a string', 'name should not be empty']]));

        $e = $this->expectFailure(fn () => $this->client($transport)->request('POST', '/v1/rooms', body: []));

        self::assertSame('name must be a string; name should not be empty', $e->getMessage());
        self::assertSame('VALIDATION_ERROR', $e->errorCode);
    }

    /** @return iterable<array{int, string}> */
    public static function derivedCodes(): iterable
    {
        return [
            [400, 'VALIDATION_ERROR'],
            [401, 'RAVEN_AUTH_ERROR'],
            [403, 'RAVEN_PERMISSION_DENIED'],
            [404, 'RAVEN_NOT_FOUND'],
            [429, 'RAVEN_RATE_LIMITED'],
            [500, 'RAVEN_INTERNAL_ERROR'],
            [503, 'RAVEN_INTERNAL_ERROR'],
        ];
    }

    #[DataProvider('derivedCodes')]
    public function testDerivesACodeFromTheStatusWhenAProxyAteTheBody(int $status, string $expected): void
    {
        $transport = new StubTransport(new Response($status, ['content-type' => 'text/html'], '<html>Gateway error</html>'));

        $e = $this->expectFailure(fn () => $this->client($transport, maxRetries: 0)->request('GET', '/v1/rooms'));

        self::assertSame($expected, $e->errorCode);
        self::assertSame("Request failed with status {$status}", $e->getMessage());
        self::assertNull($e->details);
    }
}
