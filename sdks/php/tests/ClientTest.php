<?php

declare(strict_types=1);

namespace Swalvo\Tests;

use Swalvo\Client;
use Swalvo\Http\Response;
use Swalvo\SwalvoException;
use Swalvo\Resources\LiveStreamIngress;
use Swalvo\Resources\LiveStreamRestreams;
use Swalvo\Resources\LiveStreamStage;
use Swalvo\Tests\Support\StubTransport;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ClientTest extends TestCase
{
    private string|false $originalAppEnv;

    protected function setUp(): void
    {
        $this->originalAppEnv = getenv('APP_ENV');
        putenv('APP_ENV');
        unset($_ENV['APP_ENV'], $_SERVER['APP_ENV']);
    }

    protected function tearDown(): void
    {
        $this->originalAppEnv === false ? putenv('APP_ENV') : putenv('APP_ENV=' . $this->originalAppEnv);
        unset($_ENV['APP_ENV'], $_SERVER['APP_ENV']);
    }

    /** @return iterable<string, array{string|false|null}> */
    public static function missingKeys(): iterable
    {
        yield 'empty string' => [''];
        yield 'whitespace' => ['   '];
        yield 'getenv() false' => [false];
        yield 'null' => [null];
    }

    #[DataProvider('missingKeys')]
    public function testThrowsInvalidConfigWithoutAnApiKey(string|false|null $apiKey): void
    {
        try {
            new Client(apiKey: $apiKey);
            self::fail('expected RAVEN_INVALID_CONFIG');
        } catch (SwalvoException $e) {
            self::assertSame('RAVEN_INVALID_CONFIG', $e->errorCode);
            self::assertStringContainsString('apiKey is required', $e->getMessage());
            self::assertNull($e->statusCode);
        }
    }

    public function testNeverReadsTheApiKeyFromTheEnvironmentImplicitly(): void
    {
        putenv('SWALVO_API_KEY=should-never-be-read-implicitly');
        try {
            $this->expectException(SwalvoException::class);
            new Client(apiKey: null);
        } finally {
            putenv('SWALVO_API_KEY');
        }
    }

    public function testExposesEveryResource(): void
    {
        $client = new Client(apiKey: 'k', transport: new StubTransport());

        self::assertNotNull($client->projects);
        self::assertNotNull($client->tokens);
        self::assertNotNull($client->rooms);
        self::assertNotNull($client->rooms->participants);
        self::assertNotNull($client->connections);
        self::assertNotNull($client->errors);
        self::assertNotNull($client->metrics);
        self::assertNotNull($client->diagnostics);
        self::assertNotNull($client->chat);
        self::assertNotNull($client->liveStreams);
        self::assertInstanceOf(LiveStreamRestreams::class, $client->liveStreams->restreams);
        self::assertInstanceOf(LiveStreamIngress::class, $client->liveStreams->ingress);
        self::assertInstanceOf(LiveStreamStage::class, $client->liveStreams->stage);
    }

    public function testLiveIsTheSameObjectAsLiveStreams(): void
    {
        $client = new Client(apiKey: 'k', transport: new StubTransport());

        self::assertSame($client->liveStreams, $client->live);
    }

    public function testDefaultsToLocalhost4100OutsideProduction(): void
    {
        // Stub transport: nothing is sent anywhere.
        $transport = new StubTransport(Response::json(200, []));
        $client = new Client(apiKey: 'k', transport: $transport);

        $client->rooms->list();

        self::assertSame('http://localhost:4100/v1/rooms', $transport->last()->url);
        self::assertSame('Swalvo\\Client(http://localhost:4100)', (string) $client);
    }

    public function testStripsTrailingSlashesFromTheBaseUrl(): void
    {
        $transport = new StubTransport(Response::json(200, []));
        $client = new Client(apiKey: 'k', baseUrl: 'https://api.example.test///', transport: $transport);

        $client->rooms->list();

        self::assertSame('https://api.example.test/v1/rooms', $transport->last()->url);
    }

    /** @return iterable<string, array{string, string}> */
    public static function productionSignals(): iterable
    {
        yield 'getenv production' => ['getenv', 'production'];
        yield 'getenv prod (Symfony)' => ['getenv', 'prod'];
        yield '$_ENV production' => ['env', 'production'];
        yield '$_SERVER production' => ['server', 'Production'];
    }

    #[DataProvider('productionSignals')]
    public function testRequiresBaseUrlInProduction(string $where, string $value): void
    {
        match ($where) {
            'getenv' => putenv("APP_ENV={$value}"),
            'env' => $_ENV['APP_ENV'] = $value,
            'server' => $_SERVER['APP_ENV'] = $value,
        };

        try {
            new Client(apiKey: 'k', transport: new StubTransport());
            self::fail('expected RAVEN_INVALID_CONFIG');
        } catch (SwalvoException $e) {
            self::assertSame('RAVEN_INVALID_CONFIG', $e->errorCode);
            self::assertStringContainsString('baseUrl is required outside local development', $e->getMessage());
        }

        // getenv('SWALVO_API_URL') returning false counts as omitted, too.
        $this->expectException(SwalvoException::class);
        new Client(apiKey: 'k', baseUrl: false, transport: new StubTransport());
    }

    public function testAcceptsAnExplicitBaseUrlInProduction(): void
    {
        putenv('APP_ENV=production');
        $client = new Client(apiKey: 'k', baseUrl: 'https://api.swalvo.com', transport: new StubTransport());

        self::assertSame('Swalvo\\Client(https://api.swalvo.com)', (string) $client);
    }

    public function testRejectsANonHttpBaseUrl(): void
    {
        $this->expectException(SwalvoException::class);
        $this->expectExceptionMessage('absolute http(s) URL');
        new Client(apiKey: 'k', baseUrl: 'api.swalvo.com');
    }

    public function testRejectsANonPositiveTimeout(): void
    {
        $this->expectException(SwalvoException::class);
        new Client(apiKey: 'k', timeout: 0);
    }
}
