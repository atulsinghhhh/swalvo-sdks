<?php

declare(strict_types=1);

namespace Swalvo\Tests\Integration;

use Swalvo\Client;
use PHPUnit\Framework\TestCase;

/**
 * Opt-in, against a real Swalvo API you control. Skipped unless both variables are set:
 *
 *   SWALVO_IT_BASE_URL=https://api.example.test SWALVO_IT_API_KEY=rvk_... \
 *     vendor/bin/phpunit --testsuite integration
 *
 * It creates a room, mints an RTC token, creates and starts a live stream, mints a viewer token, ends the
 * stream and closes the room.
 */
final class LiveIntegrationTest extends TestCase
{
    private Client $client;

    protected function setUp(): void
    {
        $baseUrl = getenv('SWALVO_IT_BASE_URL');
        $apiKey = getenv('SWALVO_IT_API_KEY');
        if (!is_string($baseUrl) || $baseUrl === '' || !is_string($apiKey) || $apiKey === '') {
            self::markTestSkipped('Set SWALVO_IT_BASE_URL and SWALVO_IT_API_KEY to run the integration test.');
        }
        $this->client = new Client(apiKey: $apiKey, baseUrl: $baseUrl);
    }

    public function testRoomTokenStreamAndViewerToken(): void
    {
        $suffix = bin2hex(random_bytes(4));

        $room = $this->client->rooms->create(['name' => "php-sdk-it-{$suffix}", 'getOrCreate' => true]);
        self::assertNotSame('', $room->id);

        try {
            $token = $this->client->tokens->create(['room' => $room->id, 'identity' => "php-it-{$suffix}", 'expiresIn' => 300]);
            self::assertNotSame('', $token->token);
            self::assertSame($room->id, $token->roomId);

            $stream = $this->client->liveStreams->create(['title' => "PHP SDK IT {$suffix}", 'hostIdentity' => "host-{$suffix}"]);
            self::assertSame('CREATED', $stream->status);

            // Only a LIVE stream can be ended, so start it first.
            self::assertSame('LIVE', $this->client->liveStreams->start($stream->id)->status);
            try {
                $viewer = $this->client->liveStreams->createViewerToken($stream->id, "viewer-{$suffix}", ['acceptPlayback' => true]);
                self::assertSame('VIEWER', $viewer->role);
                self::assertSame($stream->id, $viewer->streamId);
                self::assertTrue($viewer->rtc !== null || $viewer->playback !== null);
            } finally {
                self::assertSame('ENDED', $this->client->liveStreams->end($stream->id)->status);
            }
        } finally {
            $this->client->rooms->delete($room->id);
        }
    }
}
