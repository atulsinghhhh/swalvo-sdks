<?php

declare(strict_types=1);

namespace Swalvo\Tests;

use Swalvo\SwalvoException;
use Swalvo\Webhook;
use PHPUnit\Framework\TestCase;

final class WebhookTest extends TestCase
{
    private const SECRET = 'whsec_test_secret';
    private const BODY = '{"id":"evt_1","type":"live_stream.started"}';
    private const NOW = 1700000000;
    // openssl: printf '%s' '1700000000.{"id":"evt_1","type":"live_stream.started"}' | openssl dgst -sha256 -hmac whsec_test_secret
    private const KNOWN_SIGNATURE = '4df6a42b45b9345832ed21adf356edbe98b34a6bb644fdaad6f686be0c46d3c1';

    public function testExposesTheHeaderNamesAndTolerance(): void
    {
        self::assertSame('raven-signature', Webhook::SIGNATURE_HEADER);
        self::assertSame('raven-event-id', Webhook::EVENT_ID_HEADER);
        self::assertSame('raven-event-type', Webhook::EVENT_TYPE_HEADER);
        self::assertSame('swalvo-signature', Webhook::SWALVO_SIGNATURE_HEADER);
        self::assertSame('swalvo-event-id', Webhook::SWALVO_EVENT_ID_HEADER);
        self::assertSame('swalvo-event-type', Webhook::SWALVO_EVENT_TYPE_HEADER);
        self::assertSame(300, Webhook::TOLERANCE_SECONDS);
    }

    public function testSignsExactlyLikeTheApi(): void
    {
        self::assertSame('t=1700000000,v1=' . self::KNOWN_SIGNATURE, Webhook::sign(self::BODY, self::SECRET, self::NOW));
    }

    public function testAcceptsAValidSignature(): void
    {
        $webhook = new Webhook(self::SECRET);
        $header = 't=1700000000,v1=' . self::KNOWN_SIGNATURE;

        self::assertTrue($webhook->verify(self::BODY, $header, self::NOW));
        self::assertTrue($webhook->verify(self::BODY, $header, self::NOW + 300), 'exactly at the tolerance edge');
        self::assertTrue($webhook->verify(self::BODY, ' t=1700000000 , v1=' . self::KNOWN_SIGNATURE . ' ', self::NOW), 'whitespace around parts');
        self::assertTrue(Webhook::verifySignature(self::BODY, $header, self::SECRET, self::NOW));
    }

    public function testAcceptsAFreshSignatureWithTheRealClock(): void
    {
        $webhook = new Webhook(self::SECRET);

        self::assertTrue($webhook->verify(self::BODY, Webhook::sign(self::BODY, self::SECRET)));
    }

    public function testRejectsATamperedBody(): void
    {
        $webhook = new Webhook(self::SECRET);
        $header = Webhook::sign(self::BODY, self::SECRET, self::NOW);

        self::assertFalse($webhook->verify('{"id":"evt_1","type":"live_stream.ended"}', $header, self::NOW));
        self::assertFalse($webhook->verify(self::BODY . ' ', $header, self::NOW));
    }

    public function testRejectsATamperedSignatureOrTimestamp(): void
    {
        $webhook = new Webhook(self::SECRET);
        $flipped = substr(self::KNOWN_SIGNATURE, 0, -1) . (str_ends_with(self::KNOWN_SIGNATURE, '1') ? '2' : '1');

        self::assertFalse($webhook->verify(self::BODY, 't=1700000000,v1=' . $flipped, self::NOW));
        self::assertFalse($webhook->verify(self::BODY, 't=1700000001,v1=' . self::KNOWN_SIGNATURE, self::NOW), 'timestamp is inside the signed payload');
        self::assertFalse($webhook->verify(self::BODY, 't=1700000000,v1=' . strtoupper(self::KNOWN_SIGNATURE), self::NOW));
        self::assertFalse((new Webhook('another-secret'))->verify(self::BODY, 't=1700000000,v1=' . self::KNOWN_SIGNATURE, self::NOW));
    }

    public function testRejectsAnExpiredOrFutureTimestamp(): void
    {
        $webhook = new Webhook(self::SECRET);
        $header = 't=1700000000,v1=' . self::KNOWN_SIGNATURE;

        self::assertFalse($webhook->verify(self::BODY, $header, self::NOW + 301), 'replayed after 5 minutes');
        self::assertFalse($webhook->verify(self::BODY, $header, self::NOW - 301), 'from the future');
        self::assertTrue((new Webhook(self::SECRET, toleranceSeconds: 600))->verify(self::BODY, $header, self::NOW + 500));
    }

    public function testRejectsMalformedHeaders(): void
    {
        $webhook = new Webhook(self::SECRET);

        foreach ([null, '', 'garbage', 't=1700000000', 'v1=' . self::KNOWN_SIGNATURE, 't=abc,v1=' . self::KNOWN_SIGNATURE, 't=,v1=' . self::KNOWN_SIGNATURE, 't=1700000000,v1='] as $header) {
            self::assertFalse($webhook->verify(self::BODY, $header, self::NOW), var_export($header, true));
        }
    }

    public function testAcceptsWhenAnyOfSeveralV1SignaturesMatches(): void
    {
        $header = 't=1700000000,v1=' . str_repeat('0', 64) . ',v1=' . self::KNOWN_SIGNATURE;

        self::assertTrue((new Webhook(self::SECRET))->verify(self::BODY, $header, self::NOW));
    }

    public function testConstructEventReturnsTheDecodedPayloadOrThrows(): void
    {
        $webhook = new Webhook(self::SECRET);

        self::assertSame(['id' => 'evt_1', 'type' => 'live_stream.started'], $webhook->constructEvent(self::BODY, 't=1700000000,v1=' . self::KNOWN_SIGNATURE, self::NOW));

        try {
            $webhook->constructEvent(self::BODY, 't=1700000000,v1=' . self::KNOWN_SIGNATURE, self::NOW + 3600);
            self::fail('expected RAVEN_WEBHOOK_SIGNATURE_INVALID');
        } catch (SwalvoException $e) {
            self::assertSame('RAVEN_WEBHOOK_SIGNATURE_INVALID', $e->errorCode);
        }

        $this->expectException(SwalvoException::class);
        $webhook->constructEvent('not json', Webhook::sign('not json', self::SECRET, self::NOW), self::NOW);
    }

    public function testRequiresASecretAndNeverDumpsIt(): void
    {
        $webhook = new Webhook('whsec_dontleakme');
        ob_start();
        var_dump($webhook);
        print_r($webhook);
        var_export($webhook);
        $out = (string) ob_get_clean();
        self::assertStringNotContainsString('dontleakme', $out);

        $this->expectException(SwalvoException::class);
        new Webhook(getenv('SWALVO_WEBHOOK_SECRET_THAT_IS_NOT_SET'));
    }
}
