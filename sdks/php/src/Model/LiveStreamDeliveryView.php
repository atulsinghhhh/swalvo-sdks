<?php

declare(strict_types=1);

namespace Swalvo\Model;

/** How a stream's audience watches it: `LiveStream::$delivery` and `liveStreams->getPlayback()`. API: `LiveStreamDeliveryView`. */
final class LiveStreamDeliveryView extends Model
{
    /** RTC_ONLY | BROADCAST */
    public readonly string $mode;
    /** NOT_APPLICABLE | NOT_STARTED | STARTING | READY | FAILED | ENDED */
    public readonly string $status;
    /** The HLS manifest, once it's genuinely fetchable. */
    public readonly ?string $playbackUrl;
    /** Low-latency HLS (about 2 s) when the worker serves it. Prefer it, fall back to `playbackUrl`. */
    public readonly ?string $llhlsPlaybackUrl;
    public readonly ?string $recordingUrl;
    public readonly ?float $recordingDurationSec;

    protected function hydrate(array $data): void
    {
        $this->mode = self::str($data, 'mode');
        $this->status = self::str($data, 'status');
        $this->playbackUrl = self::nstr($data, 'playbackUrl');
        $this->llhlsPlaybackUrl = self::nstr($data, 'llhlsPlaybackUrl');
        $this->recordingUrl = self::nstr($data, 'recordingUrl');
        $this->recordingDurationSec = self::nfloat($data, 'recordingDurationSec');
    }
}
