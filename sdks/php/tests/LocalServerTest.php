<?php

declare(strict_types=1);

namespace Swalvo\Tests;

use Swalvo\Client;
use Swalvo\Http\CurlTransport;
use Swalvo\Http\HttpClient;
use Swalvo\SwalvoException;
use Swalvo\Tests\Support\LocalServer;
use Swalvo\Version;
use PHPUnit\Framework\TestCase;

/**
 * The real ext-curl transport against a real `php -S` server on 127.0.0.1 (tests/Support/router.php).
 * Never a running Swalvo API.
 */
final class LocalServerTest extends TestCase
{
    private static string $baseUrl;

    /** @var list<int> */
    private array $sleeps = [];

    public static function setUpBeforeClass(): void
    {
        self::$baseUrl = LocalServer::baseUrl();
    }

    public static function tearDownAfterClass(): void
    {
        LocalServer::stop();
    }

    private function http(string $baseUrl = '', float $timeout = 5.0, int $maxRetries = 2): HttpClient
    {
        return new HttpClient('rvk_local.secret', $baseUrl !== '' ? $baseUrl : self::$baseUrl, $timeout, $maxRetries, new CurlTransport(), function (int $ms): void {
            $this->sleeps[] = $ms;
        });
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

    public function testAuthHeaderUserAgentAndJsonBodyArriveOverTheWire(): void
    {
        $client = new Client(apiKey: 'rvk_local.secret', baseUrl: self::$baseUrl);

        $room = $client->rooms->create(['name' => 'standup é/1', 'getOrCreate' => true]);

        $echo = $room->toArray()['_echo'];
        self::assertSame('standup é/1', $room->name);
        self::assertSame('POST', $echo['method']);
        self::assertSame('/v1/rooms', $echo['path']);
        self::assertSame('Bearer rvk_local.secret', $echo['headers']['authorization']);
        self::assertStringStartsWith('Swalvo-Server-SDK/' . Version::SDK_VERSION . ' (php ', $echo['headers']['user-agent']);
        self::assertSame('application/json', $echo['headers']['content-type']);
        self::assertSame(['name' => 'standup é/1', 'getOrCreate' => true], json_decode($echo['body'], true));
    }

    public function testQueryEncodingOverTheWire(): void
    {
        $result = $this->http()->request('GET', '/v1/connections', query: ['roomId' => 'room 1&x', 'state' => null, 'limit' => 5, 'includeArchived' => true]);

        self::assertSame('roomId=room+1%26x&limit=5&includeArchived=true', $result['_echo']['query']);
    }

    public function testBodylessPostAndDeleteAndA204(): void
    {
        $result = $this->http()->request('POST', '/v1/live-streams/s/start');
        self::assertSame('', $result['_echo']['body']);
        self::assertSame('POST', $result['_echo']['method']);

        self::assertNull($this->http()->request('DELETE', '/no-content'));
    }

    public function testRetriesA503ThenSucceeds(): void
    {
        $result = $this->http()->request('GET', '/flaky/2/503', query: ['key' => uniqid('503', true)]);

        self::assertSame(3, $result['attempts']);
        self::assertSame([300, 600], $this->sleeps);
    }

    public function testRetriesA429ThenSucceeds(): void
    {
        $result = $this->http()->request('GET', '/flaky/1/429', query: ['key' => uniqid('429', true)]);

        self::assertSame(2, $result['attempts']);
    }

    public function testTheDefaultBackoffReallyWaits(): void
    {
        $http = new HttpClient('k', self::$baseUrl, 5.0, 2, new CurlTransport());
        $started = microtime(true);

        $result = $http->request('GET', '/flaky/1/503', query: ['key' => uniqid('wait', true)]);

        self::assertSame(2, $result['attempts']);
        self::assertGreaterThanOrEqual(0.3, microtime(true) - $started);
    }

    public function testDoesNotRetryA400(): void
    {
        $e = $this->expectFailure(fn () => $this->http()->request('POST', '/flaky/5/400', query: ['key' => uniqid('400', true)], body: ['x' => 1]));

        self::assertSame(400, $e->statusCode);
        self::assertSame('RAVEN_TEST_FAILURE', $e->errorCode);
        self::assertSame(1, $e->details['attempt']);
        self::assertSame('req_attempt_1', $e->requestId);
        self::assertSame([], $this->sleeps);
    }

    public function testGivesUpOnA503AfterMaxRetries(): void
    {
        $e = $this->expectFailure(fn () => $this->http()->request('GET', '/flaky/9/503', query: ['key' => uniqid('503x', true)]));

        self::assertSame(503, $e->statusCode);
        self::assertSame(3, $e->details['attempt']);
    }

    public function testDecodesAnApiError(): void
    {
        $e = $this->expectFailure(fn () => $this->http()->request('GET', '/status/404'));

        self::assertSame('RAVEN_ROOM_NOT_FOUND', $e->errorCode);
        self::assertSame(404, $e->statusCode);
        self::assertSame('Room not found', $e->getMessage());
        self::assertSame('req_local_123', $e->requestId);
        self::assertSame('RAVEN_ROOM_NOT_FOUND', $e->details['code']);
    }

    public function testDerivesACodeFromAnHtmlProxyPage(): void
    {
        $e = $this->expectFailure(fn () => $this->http(maxRetries: 0)->request('GET', '/html/502'));

        self::assertSame('RAVEN_INTERNAL_ERROR', $e->errorCode);
        self::assertSame(502, $e->statusCode);
        self::assertNull($e->details);
    }

    public function testTimesOutInsteadOfHanging(): void
    {
        // A listening socket that never accepts or answers: the TCP handshake completes, no response ever comes.
        $server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        self::assertNotFalse($server);
        $name = (string) stream_socket_get_name($server, false);

        try {
            $started = microtime(true);
            $e = $this->expectFailure(fn () => $this->http('http://' . $name, timeout: 0.3, maxRetries: 0)->request('GET', '/v1/rooms'));
            $elapsed = microtime(true) - $started;
        } finally {
            fclose($server);
        }

        self::assertSame('RAVEN_TIMEOUT', $e->errorCode);
        self::assertSame('Request timed out after 300ms', $e->getMessage());
        self::assertLessThan(2.0, $elapsed);
    }

    public function testMapsConnectionRefusedToNetworkErrorAfterRetries(): void
    {
        $port = LocalServer::closedPort();

        $e = $this->expectFailure(fn () => $this->http("http://127.0.0.1:{$port}")->request('GET', '/v1/rooms'));

        self::assertSame('RAVEN_NETWORK_ERROR', $e->errorCode);
        self::assertSame([300, 600], $this->sleeps);
    }
}
