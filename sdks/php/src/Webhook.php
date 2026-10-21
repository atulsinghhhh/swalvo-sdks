<?php

declare(strict_types=1);

namespace Swalvo;

/**
 * Verifies Swalvo webhook deliveries.
 *
 * Every delivery carries `swalvo-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
 * and an identical legacy `raven-signature` twin.
 * The timestamp is inside the signed payload, so a captured delivery can't be replayed later with a fresher
 * timestamp; deliveries older (or newer) than 300 s are rejected. Same scheme as the API's
 * webhook-signature.util.ts.
 *
 * Always verify the raw request body, byte for byte (`file_get_contents('php://input')`), never a
 * re-encoded `json_decode`/`json_encode` round trip.
 *
 * ```php
 * $webhook = new \Swalvo\Webhook(getenv('SWALVO_WEBHOOK_SECRET'));
 * $event = $webhook->constructEvent(
 *     file_get_contents('php://input'),
 *     $_SERVER['HTTP_SWALVO_SIGNATURE'] ?? $_SERVER['HTTP_RAVEN_SIGNATURE'] ?? null,
 * );
 * ```
 */
final class Webhook
{
    public const SWALVO_SIGNATURE_HEADER = 'swalvo-signature';
    public const SWALVO_EVENT_ID_HEADER = 'swalvo-event-id';
    public const SWALVO_EVENT_TYPE_HEADER = 'swalvo-event-type';
    // legacy: kept for wire compatibility — pre-rename twins of the headers above.
    public const SIGNATURE_HEADER = 'raven-signature';
    public const EVENT_ID_HEADER = 'raven-event-id';
    public const EVENT_TYPE_HEADER = 'raven-event-type';
    public const TOLERANCE_SECONDS = 300;

    /** @var \WeakMap<self, string>|null kept off the object, like the client's API key */
    private static ?\WeakMap $secrets = null;

    /**
     * @param int $toleranceSeconds how far the signed timestamp may drift from now
     * @throws SwalvoException RAVEN_INVALID_CONFIG when the secret is missing
     */
    public function __construct(
        #[\SensitiveParameter] string|false|null $secret,
        private readonly int $toleranceSeconds = self::TOLERANCE_SECONDS,
    ) {
        if (!is_string($secret) || $secret === '') {
            throw new SwalvoException('A webhook signing secret is required', 'RAVEN_INVALID_CONFIG');
        }
        self::$secrets ??= new \WeakMap();
        self::$secrets[$this] = $secret;
    }

    /**
     * True only when the header is well formed, the timestamp is within tolerance and a `v1` signature
     * matches (constant-time comparison).
     *
     * @param int|null $now unix seconds; defaults to time()
     */
    public function verify(string $rawBody, ?string $signatureHeader, ?int $now = null): bool
    {
        return self::verifySignature($rawBody, $signatureHeader, (self::$secrets[$this] ?? ''), $now, $this->toleranceSeconds);
    }

    /**
     * Verifies, then decodes the JSON body.
     *
     * @return array<string, mixed>
     * @throws SwalvoException RAVEN_WEBHOOK_SIGNATURE_INVALID, or RAVEN_WEBHOOK_PAYLOAD_INVALID for a non-JSON body
     */
    public function constructEvent(string $rawBody, ?string $signatureHeader, ?int $now = null): array
    {
        if (!$this->verify($rawBody, $signatureHeader, $now)) {
            throw new SwalvoException('Webhook signature verification failed', 'RAVEN_WEBHOOK_SIGNATURE_INVALID');
        }
        try {
            $event = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $error) {
            throw new SwalvoException('Webhook payload is not valid JSON', 'RAVEN_WEBHOOK_PAYLOAD_INVALID', previous: $error);
        }
        if (!is_array($event)) {
            throw new SwalvoException('Webhook payload is not a JSON object', 'RAVEN_WEBHOOK_PAYLOAD_INVALID');
        }

        return $event;
    }

    /** `t=<timestamp>,v1=<hex hmac>`, exactly as the API signs a delivery. Handy for tests of your own receiver. */
    public static function sign(string $rawBody, #[\SensitiveParameter] string $secret, ?int $timestamp = null): string
    {
        $timestamp ??= time();

        return 't=' . $timestamp . ',v1=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
    }

    public static function verifySignature(
        string $rawBody,
        ?string $signatureHeader,
        #[\SensitiveParameter] string $secret,
        ?int $now = null,
        int $toleranceSeconds = self::TOLERANCE_SECONDS,
    ): bool {
        if ($signatureHeader === null || $signatureHeader === '' || $secret === '') {
            return false;
        }

        $timestamp = null;
        $signatures = [];
        foreach (explode(',', $signatureHeader) as $part) {
            $pair = explode('=', trim($part));
            if (count($pair) !== 2) {
                continue;
            }
            [$key, $value] = $pair;
            if ($key === 't') {
                $timestamp = $value;
            } elseif ($key === 'v1' && $value !== '') {
                $signatures[] = $value;
            }
        }

        if ($timestamp === null || !preg_match('/^\d{1,12}$/', $timestamp) || $signatures === []) {
            return false;
        }
        $timestamp = (int) $timestamp;
        if (abs(($now ?? time()) - $timestamp) > $toleranceSeconds) {
            return false;
        }

        $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
        foreach ($signatures as $signature) {
            if (hash_equals($expected, $signature)) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string, mixed> */
    public function __debugInfo(): array
    {
        return ['secret' => '[REDACTED]', 'toleranceSeconds' => $this->toleranceSeconds];
    }

    /** @return never */
    public function __serialize(): array
    {
        throw new \LogicException('A Swalvo webhook verifier holds a signing secret and cannot be serialized.');
    }
}
