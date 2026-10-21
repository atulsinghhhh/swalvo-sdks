<?php

declare(strict_types=1);

namespace Swalvo\Resources;

use Swalvo\Model\IssuedStreamCredential;

/**
 * The stage (Agora's setClientRole). Invite announces it to the viewer's client; promote registers them as
 * a co-host and returns host credentials for their client's `switchRole()`; demote takes a co-host off
 * stage and stops their publishing at once.
 */
final class LiveStreamStage extends ApiResource
{
    /** `POST /v1/live-streams/{streamId}/stage/invites` */
    public function invite(string $streamId, string $identity): void
    {
        $this->http->request('POST', LiveStreams::streamPath($streamId) . '/stage/invites', body: ['identity' => $identity]);
    }

    /**
     * `POST /v1/live-streams/{streamId}/stage/promote`
     *
     * @param array{role?: 'CO_HOST'|'HOST'} $options
     */
    public function promote(string $streamId, string $identity, array $options = []): IssuedStreamCredential
    {
        return IssuedStreamCredential::fromArray((array) $this->http->request(
            'POST',
            LiveStreams::streamPath($streamId) . '/stage/promote',
            body: ['identity' => $identity] + $options,
        ));
    }

    /** `POST /v1/live-streams/{streamId}/stage/demote` */
    public function demote(string $streamId, string $identity): void
    {
        $this->http->request('POST', LiveStreams::streamPath($streamId) . '/stage/demote', body: ['identity' => $identity]);
    }
}
