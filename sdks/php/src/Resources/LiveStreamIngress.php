<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Model\IngressView;
use Swalvo\Model\IngressWithKey;

/**
 * Ingest: broadcast into a stream from OBS, vMix, ffmpeg or a hardware encoder. One ingest per stream.
 *
 * The stream key (`sk_...`) is the RTMP stream key and the WHIP bearer token. It's stored only as a hash
 * and returned only by `create()` and `reset()`.
 */
final class LiveStreamIngress extends ApiResource
{
    /**
     * `POST /v1/live-streams/{streamId}/ingress`. The key is shown this once.
     *
     * @param array{protocol?: 'WHIP'|'RTMP', identity?: string, autoStart?: bool, reconnectWindowSec?: int} $params
     */
    public function create(string $streamId, array $params = []): IngressWithKey
    {
        return IngressWithKey::fromArray((array) $this->http->request('POST', LiveStreams::streamPath($streamId) . '/ingress', body: $params));
    }

    /** `GET /v1/live-streams/{streamId}/ingress`. Never includes the stream key. */
    public function get(string $streamId): IngressView
    {
        return IngressView::fromArray((array) $this->http->request('GET', LiveStreams::streamPath($streamId) . '/ingress'));
    }

    /** `POST /v1/live-streams/{streamId}/ingress/reset`: rotates the key and disconnects any encoder. */
    public function reset(string $streamId): IngressWithKey
    {
        return IngressWithKey::fromArray((array) $this->http->request('POST', LiveStreams::streamPath($streamId) . '/ingress/reset'));
    }

    /** `DELETE /v1/live-streams/{streamId}/ingress`. The stream itself keeps running. */
    public function delete(string $streamId): void
    {
        $this->http->request('DELETE', LiveStreams::streamPath($streamId) . '/ingress');
    }
}
