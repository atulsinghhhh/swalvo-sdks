<?php

declare(strict_types=1);

namespace Swalvo\Tests;

use Swalvo\Client;
use Swalvo\Http\HttpClient;
use Swalvo\Http\Request;
use Swalvo\Http\Response;
use Swalvo\Http\TransportException;
use Swalvo\SwalvoException;
use Swalvo\Tests\Support\StubTransport;
use PHPUnit\Framework\Attributes\RequiresPhp;
use PHPUnit\Framework\TestCase;

/** The API key must never surface through dumping, logging or exceptions. */
final class SecretRedactionTest extends TestCase
{
    private const KEY = 'rvk_super-secret-value.dontleakme';

    private static function dumpAll(mixed $value): string
    {
        ob_start();
        var_dump($value);
        print_r($value);
        echo "\n";
        if (!$value instanceof \Throwable) {
            // var_export/(array) bypass __debugInfo; the closure-held key must survive them too.
            // (Skipped for exceptions: exporting a stack trace's argument graph explodes in size.)
            var_export($value);
            echo "\n";
            var_dump(is_object($value) ? (array) $value : $value);
        }

        return (string) ob_get_clean();
    }

    /**
     * Everything an exception chain exposes: messages, string forms, string traces, details, and the
     * captured arguments of every SDK stack frame. (A full var_dump of the trace would also dump PHPUnit's
     * own runner objects, which is noise, not SDK output.)
     */
    private static function dumpException(?\Throwable $e): string
    {
        $out = '';
        for ($depth = 0; $e !== null; $e = $e->getPrevious(), $depth++) {
            // SDK frames plus the stub transport's (whose send() frame captures the Request), not test cases.
            $sdkFrames = array_values(array_filter(
                $e->getTrace(),
                static fn (array $frame): bool => str_starts_with($frame['class'] ?? '', 'Swalvo\\') && !str_ends_with($frame['class'] ?? '', 'Test'),
            ));
            if ($depth === 0) {
                self::assertNotSame([], $sdkFrames, 'expected SDK frames in the trace');
            }
            $out .= $e->getMessage() . (string) $e . $e->getTraceAsString() . print_r($sdkFrames, true) . self::dumpAll($sdkFrames);
            if ($e instanceof SwalvoException) {
                $out .= self::dumpAll($e->details);
            }
        }

        return $out;
    }

    protected function setUp(): void
    {
        ini_set('zend.exception_ignore_args', '0');
    }

    public function testTheClientNeverDumpsTheKey(): void
    {
        $client = new Client(apiKey: self::KEY, baseUrl: 'https://api.example.test', transport: new StubTransport());

        $out = self::dumpAll($client) . self::dumpAll($client->rooms) . self::dumpAll($client->liveStreams->ingress)
            . json_encode($client) . (string) $client;

        self::assertStringNotContainsString('dontleakme', $out);
        self::assertStringContainsString('[REDACTED]', $out);
        self::assertSame('{"baseUrl":"https:\/\/api.example.test"}', json_encode($client));
    }

    public function testTheClientRefusesToBeSerialized(): void
    {
        $client = new Client(apiKey: self::KEY, transport: new StubTransport());

        $this->expectException(\LogicException::class);
        serialize($client);
    }

    public function testARequestHandedToATransportRedactsAuthorizationWhenDumped(): void
    {
        $transport = new StubTransport(Response::json(200, []));
        (new Client(apiKey: self::KEY, transport: $transport))->rooms->list();
        $request = $transport->last();

        self::assertSame('Bearer ' . self::KEY, $request->header('authorization'), 'the transport still gets the real header');
        $out = self::dumpAll($request);
        self::assertStringNotContainsString('dontleakme', $out);
        self::assertStringContainsString('Bearer [REDACTED]', $out);
    }

    public function testAnApiErrorNeverCarriesTheKeyEvenWhenTheServerEchoesIt(): void
    {
        $transport = new StubTransport(Response::json(400, [
            'message' => 'bad header: Bearer ' . self::KEY,
            'code' => 'VALIDATION_FAILED',
            'echo' => ['authorization' => 'Bearer ' . self::KEY, self::KEY => 'as a key'],
        ], ['x-request-id' => 'req_1']));
        $client = new Client(apiKey: self::KEY, transport: $transport);

        try {
            $client->rooms->list();
            self::fail('expected a SwalvoException');
        } catch (SwalvoException $e) {
            $out = json_encode($e->details) . self::dumpException($e);
            self::assertStringNotContainsString('dontleakme', $out);
            self::assertSame('bad header: Bearer [REDACTED]', $e->getMessage());
        }
    }

    public function testANetworkFailureNeverCarriesTheKey(): void
    {
        // Thrown from inside send(), so its trace captures the Request argument, as a real transport's would.
        $transport = new StubTransport(static fn (Request $request) => throw new TransportException('Connection refused'));
        $client = new Client(apiKey: self::KEY, maxRetries: 0, transport: $transport);

        try {
            $client->rooms->list();
            self::fail('expected a SwalvoException');
        } catch (SwalvoException $e) {
            // The previous exception's trace captured the Request as an argument; it must stay redacted.
            $out = self::dumpException($e);
            self::assertStringContainsString('Bearer [REDACTED]', $out, 'the Request in the trace is shown, redacted');
            self::assertStringNotContainsString('dontleakme', $out);
            self::assertSame('RAVEN_NETWORK_ERROR', $e->errorCode);
        }
    }

    /** `#[\SensitiveParameter]` arrived in PHP 8.2; on 8.1 the attribute is inert. */
    #[RequiresPhp('>=8.2')]
    public function testAConfigErrorThrownWhileTheKeyIsAnArgumentNeverCarriesIt(): void
    {
        putenv('APP_ENV=production');
        try {
            new Client(apiKey: self::KEY);
            self::fail('expected RAVEN_INVALID_CONFIG');
        } catch (SwalvoException $e) {
            // #[\SensitiveParameter] replaces the key in the captured stack-frame arguments (PHP 8.2+).
            $out = self::dumpException($e);
            self::assertStringContainsString('SensitiveParameterValue', $out);
            self::assertStringNotContainsString('dontleakme', $out);
            self::assertSame('RAVEN_INVALID_CONFIG', $e->errorCode);
        } finally {
            putenv('APP_ENV');
        }
    }

    public function testTheHttpClientItselfNeverDumpsTheKey(): void
    {
        $http = new HttpClient(self::KEY, 'https://api.example.test', transport: new StubTransport());

        $out = self::dumpAll($http) . json_encode($http) . (string) $http;

        self::assertStringNotContainsString('dontleakme', $out);
    }

    public function testATransportRequestCannotBeSerialized(): void
    {
        $this->expectException(\LogicException::class);
        serialize(new Request('GET', 'https://x', ['Authorization' => 'Bearer ' . self::KEY], null, 1.0));
    }
}
