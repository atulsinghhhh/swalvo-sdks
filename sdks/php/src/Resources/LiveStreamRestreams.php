<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Model\RestreamView;

/**
 * Restream ("RTMP out"): push a live stream to up to 5 RTMP/RTMPS destinations at once.
 *
 * The destination's stream key is a third party's credential: encrypted at rest, never returned
 * (`keyLast4` only). To change a key, delete the destination and create it again.
 */
final class LiveStreamRestreams extends ApiResource
{
    /**
     * `POST /v1/live-streams/{streamId}/restreams`. If the stream is LIVE, pushing starts immediately.
     *
     * @param array{url: string, streamKey: string, label?: string} $params
     */
    public function create(string $streamId, array $params): RestreamView
    {
        return RestreamView::fromArray((array) $this->http->request('POST', LiveStreams::streamPath($streamId) . '/restreams', body: $params));
    }

    /**
     * `GET /v1/live-streams/{streamId}/restreams`
     *
     * @return list<RestreamView>
     */
    public function list(string $streamId): array
    {
        return RestreamView::listFrom($this->http->request('GET', LiveStreams::streamPath($streamId) . '/restreams'));
    }

    /**
     * `PATCH /v1/live-streams/{streamId}/restreams/{restreamId}`. `enabled: false` pauses; `true` resumes.
     *
     * @param array{enabled?: bool, label?: string} $params
     */
    public function update(string $streamId, string $restreamId, array $params): RestreamView
    {
        return RestreamView::fromArray((array) $this->http->request('PATCH', self::path($streamId, $restreamId), body: $params));
    }

    /** `DELETE /v1/live-streams/{streamId}/restreams/{restreamId}`: stops pushing and removes it. */
    public function delete(string $streamId, string $restreamId): void
    {
        $this->http->request('DELETE', self::path($streamId, $restreamId));
    }

    private static function path(string $streamId, string $restreamId): string
    {
        return LiveStreams::streamPath($streamId) . '/restreams/' . self::seg($restreamId, 'restreamId');
    }
}
