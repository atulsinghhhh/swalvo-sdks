<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** A BROADCAST viewer's HLS playback, on a credential minted with `acceptPlayback`. TS: `IssuedStreamCredential['playback']`. */
final class StreamPlayback extends Model
{
    /** May 404 briefly while the stream starts. */
    public readonly ?string $url;
    /** Low-latency HLS when the worker serves it; players prefer it and fall back to `url`. */
    public readonly ?string $llhlsUrl;
    public readonly string $status;
    /** Watch-time heartbeat for viewer-minute billing: `['url', 'token', 'intervalSec']`, or null. Forwarded as-is by json_encode(). */
    public readonly ?array $beacon;

    protected function hydrate(array $data): void
    {
        $this->url = self::nstr($data, 'url');
        $this->llhlsUrl = self::nstr($data, 'llhlsUrl');
        $this->status = self::str($data, 'status');
        $this->beacon = isset($data['beacon']) && is_array($data['beacon']) ? $data['beacon'] : null;
    }
}
