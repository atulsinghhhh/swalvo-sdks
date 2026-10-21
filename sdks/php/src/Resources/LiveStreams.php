<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Http\HttpClient;
use Swalvo\Model\IssuedStreamCredential;
use Swalvo\Model\LiveStream;
use Swalvo\Model\LiveStreamDeliveryView;

/**
 * Swalvo Live Streaming, server-side. A stream composes an RTC room and a chat conversation.
 *
 * `addHost()` and `createViewerToken()` are the security-critical pair: the role your caller ends up with
 * is decided entirely by which method you call, never by a field in the request body. A viewer token is
 * always subscribe-only. `addHost()`, called after your own auth check, is the only route to publish.
 */
final class LiveStreams extends ApiResource
{
    /** RTMP/RTMPS destinations (YouTube, Twitch, ...) a stream is pushed to. */
    public readonly LiveStreamRestreams $restreams;
    /** The stream's ingest endpoint for OBS and other encoders, over WHIP or RTMP/RTMPS. */
    public readonly LiveStreamIngress $ingress;
    /** The stage: invite, promote and demote. */
    public readonly LiveStreamStage $stage;

    public function __construct(HttpClient $http)
    {
        parent::__construct($http);
        $this->restreams = new LiveStreamRestreams($http);
        $this->ingress = new LiveStreamIngress($http);
        $this->stage = new LiveStreamStage($http);
    }

    /**
     * `POST /v1/live-streams`
     *
     * @param array{
     *     title: string,
     *     hostIdentity: string,
     *     description?: string,
     *     thumbnailUrl?: string,
     *     category?: string,
     *     tags?: list<string>,
     *     language?: string,
     *     visibility?: 'PUBLIC'|'PRIVATE'|'AUTHENTICATED',
     *     metadata?: array<string, mixed>,
     *     scheduledAt?: string,
     *     deliveryMode?: 'RTC_ONLY'|'BROADCAST',
     *     edgeScaling?: bool
     * } $params
     */
    public function create(array $params): LiveStream
    {
        return LiveStream::fromArray((array) $this->http->request('POST', '/v1/live-streams', body: $params));
    }

    /**
     * `GET /v1/live-streams`
     *
     * @param array{status?: 'CREATED'|'STARTING'|'LIVE'|'ENDING'|'ENDED'} $params
     * @return list<LiveStream>
     */
    public function list(array $params = []): array
    {
        $status = $params['status'] ?? null;

        return LiveStream::listFrom($this->http->request('GET', '/v1/live-streams', query: [
            'status' => ($status === null || $status === '') ? null : $status,
        ]));
    }

    /** `GET /v1/live-streams/{streamId}`. Includes the live viewer count, which `list()` doesn't. */
    public function get(string $streamId): LiveStream
    {
        return LiveStream::fromArray((array) $this->http->request('GET', self::streamPath($streamId)));
    }

    /**
     * `PATCH /v1/live-streams/{streamId}`. Never the status: `start()` and `end()` handle that.
     *
     * @param array{
     *     title?: string,
     *     description?: string,
     *     thumbnailUrl?: string,
     *     category?: string,
     *     tags?: list<string>,
     *     language?: string,
     *     visibility?: 'PUBLIC'|'PRIVATE'|'AUTHENTICATED',
     *     metadata?: array<string, mixed>
     * } $params
     */
    public function update(string $streamId, array $params): LiveStream
    {
        return LiveStream::fromArray((array) $this->http->request('PATCH', self::streamPath($streamId), body: $params));
    }

    /** `POST /v1/live-streams/{streamId}/start`: CREATED to LIVE. */
    public function start(string $streamId): LiveStream
    {
        return LiveStream::fromArray((array) $this->http->request('POST', self::streamPath($streamId) . '/start'));
    }

    /** `POST /v1/live-streams/{streamId}/end`: LIVE to ENDED, which is terminal. */
    public function end(string $streamId): LiveStream
    {
        return LiveStream::fromArray((array) $this->http->request('POST', self::streamPath($streamId) . '/end'));
    }

    /**
     * `POST /v1/live-streams/{streamId}/hosts`: registers a host or co-host and mints full-publish RTC plus
     * moderator-or-above chat credentials. Call again with the same identity to re-mint.
     *
     * @param array{identity: string, role?: 'HOST'|'CO_HOST'} $params role defaults to CO_HOST
     */
    public function addHost(string $streamId, array $params): IssuedStreamCredential
    {
        return IssuedStreamCredential::fromArray((array) $this->http->request('POST', self::streamPath($streamId) . '/hosts', body: $params));
    }

    /** `DELETE /v1/live-streams/{streamId}/hosts/{identity}`: a soft removal; chat history survives. */
    public function removeHost(string $streamId, string $identity): void
    {
        $this->http->request('DELETE', self::streamPath($streamId) . '/hosts/' . self::seg($identity, 'identity'));
    }

    /**
     * `POST /v1/live-streams/{streamId}/viewer-tokens`. Always subscribe-only on RTC and MEMBER on chat.
     *
     * Pass `['acceptPlayback' => true]` when your client can play HLS: a BROADCAST stream then returns a
     * playback credential (chat + `playback->url`/`playback->llhlsUrl`) instead of a 409.
     *
     * @param array{acceptPlayback?: bool} $options
     */
    public function createViewerToken(string $streamId, string $identity, array $options = []): IssuedStreamCredential
    {
        $body = ['identity' => $identity];
        if (!empty($options['acceptPlayback'])) {
            $body['acceptPlayback'] = true;
        }

        return IssuedStreamCredential::fromArray((array) $this->http->request('POST', self::streamPath($streamId) . '/viewer-tokens', body: $body));
    }

    /**
     * `GET /v1/live-streams/{streamId}/playback`: whether HLS playback is ready, and its URLs.
     * Works for RTC_ONLY streams too (status NOT_APPLICABLE).
     *
     * Not in the TypeScript SDK yet; the endpoint is the API's `getPlaybackInfo`.
     */
    public function getPlayback(string $streamId): LiveStreamDeliveryView
    {
        return LiveStreamDeliveryView::fromArray((array) $this->http->request('GET', self::streamPath($streamId) . '/playback'));
    }

    /**
     * `POST /v1/live-streams/{streamId}/leave`: a clean-leave signal for `live_stream.viewer_left`.
     * Not a disconnect detector; call it when your app knows a viewer left.
     */
    public function leave(string $streamId, string $identity): void
    {
        $this->http->request('POST', self::streamPath($streamId) . '/leave', body: ['identity' => $identity]);
    }

    /** @internal */
    public static function streamPath(string $streamId): string
    {
        return '/v1/live-streams/' . self::seg($streamId, 'streamId');
    }
}
