import type { SwalvoHttpClient } from '../http-client';
import type {
  AddHostParams,
  CreateIngressParams,
  CreateLiveStreamParams,
  CreateRestreamParams,
  IngressView,
  IngressWithKey,
  IssuedStreamCredential,
  LiveStream,
  ListLiveStreamsParams,
  RestreamView,
  UpdateLiveStreamParams,
  UpdateRestreamParams,
} from '../types';

/**
 * Swalvo Live Streaming, server-side (Phase 14).
 *
 * A stream composes an RTC room and a chat conversation. This resource only
 * owns lifecycle and role bookkeeping on top of those, following the same
 * reuse discipline the backend itself does.
 *
 * `addHost` and `createViewerToken` are the security-critical pair. The role
 * your caller ends up with is decided entirely by which method you call,
 * never by a field in the request body. A viewer token is always
 * subscribe-only, and there's no way to ask this SDK for anything else.
 * `addHost`, called from your own backend after your own auth check, is the
 * only route to publish access.
 */
export class LiveStreamsResource {
  /** RTMP/RTMPS destinations (YouTube, Twitch, ...) a stream is pushed to. */
  readonly restreams: LiveStreamRestreamsResource;
  /** The stream's ingest endpoint for OBS and other encoders, over WHIP or RTMP/RTMPS. */
  readonly ingress: LiveStreamIngressResource;

  constructor(private readonly http: SwalvoHttpClient) {
    this.restreams = new LiveStreamRestreamsResource(http);
    this.ingress = new LiveStreamIngressResource(http);
  }

  create(params: CreateLiveStreamParams): Promise<LiveStream> {
    return this.http.request<LiveStream>('/v1/live-streams', { method: 'POST', body: params });
  }

  list(params: ListLiveStreamsParams = {}): Promise<LiveStream[]> {
    const query = params.status ? `?status=${encodeURIComponent(params.status)}` : '';
    return this.http.request<LiveStream[]>(`/v1/live-streams${query}`);
  }

  /** Includes the stream's live viewer count. `list()` doesn't, to avoid an SFU round trip per row. */
  get(streamId: string): Promise<LiveStream> {
    return this.http.request<LiveStream>(`/v1/live-streams/${encodeURIComponent(streamId)}`);
  }

  update(streamId: string, params: UpdateLiveStreamParams): Promise<LiveStream> {
    return this.http.request<LiveStream>(`/v1/live-streams/${encodeURIComponent(streamId)}`, {
      method: 'PATCH',
      body: params,
    });
  }

  /** CREATED → LIVE. */
  start(streamId: string): Promise<LiveStream> {
    return this.http.request<LiveStream>(`/v1/live-streams/${encodeURIComponent(streamId)}/start`, {
      method: 'POST',
    });
  }

  /** LIVE → ENDED, and that's terminal. You can't restart an ended stream; create a new one. */
  end(streamId: string): Promise<LiveStream> {
    return this.http.request<LiveStream>(`/v1/live-streams/${encodeURIComponent(streamId)}/end`, {
      method: 'POST',
    });
  }

  /**
   * Registers a host or co-host and mints full-publish RTC credentials plus
   * moderator-or-above chat credentials, all in one call. Call it again with
   * the same identity to re-mint fresh ones, say after the originals
   * expired.
   */
  addHost(streamId: string, params: AddHostParams): Promise<IssuedStreamCredential> {
    return this.http.request<IssuedStreamCredential>(`/v1/live-streams/${encodeURIComponent(streamId)}/hosts`, {
      method: 'POST',
      body: params,
    });
  }

  /** A soft removal. The host's chat history in the stream survives. */
  removeHost(streamId: string, identity: string): Promise<void> {
    return this.http.request<void>(
      `/v1/live-streams/${encodeURIComponent(streamId)}/hosts/${encodeURIComponent(identity)}`,
      { method: 'DELETE' },
    );
  }

  /**
   * Always subscribe-only on RTC and MEMBER on chat. See the class doc.
   *
   * Pass `{ acceptPlayback: true }` when your client can play HLS
   * (`@swalvo/live`, the React Native and Flutter SDKs all can): a
   * BROADCAST stream then returns a playback credential (chat +
   * `playback.url`) instead of a 409, so one call serves every delivery mode.
   */
  createViewerToken(
    streamId: string,
    identity: string,
    options: { acceptPlayback?: boolean } = {},
  ): Promise<IssuedStreamCredential> {
    return this.http.request<IssuedStreamCredential>(`/v1/live-streams/${encodeURIComponent(streamId)}/viewer-tokens`, {
      method: 'POST',
      body: { identity, ...(options.acceptPlayback ? { acceptPlayback: true } : {}) },
    });
  }

  /**
   * The stage (Agora's setClientRole). Invite announces it to the viewer's
   * client; promote registers them as a co-host and returns host
   * credentials, which their client passes to `LiveStream.switchRole()`;
   * demote takes a co-host off stage and stops their publishing at once.
   */
  readonly stage = {
    invite: (streamId: string, identity: string): Promise<void> =>
      this.http.request<void>(`/v1/live-streams/${encodeURIComponent(streamId)}/stage/invites`, {
        method: 'POST',
        body: { identity },
      }),
    promote: (
      streamId: string,
      identity: string,
      options: { role?: 'CO_HOST' | 'HOST' } = {},
    ): Promise<IssuedStreamCredential> =>
      this.http.request<IssuedStreamCredential>(`/v1/live-streams/${encodeURIComponent(streamId)}/stage/promote`, {
        method: 'POST',
        body: { identity, ...options },
      }),
    demote: (streamId: string, identity: string): Promise<void> =>
      this.http.request<void>(`/v1/live-streams/${encodeURIComponent(streamId)}/stage/demote`, {
        method: 'POST',
        body: { identity },
      }),
  };

  /**
   * A clean-leave signal for `live_stream.viewer_left`. Not a disconnect
   * detector: Swalvo has no way to spot an abrupt viewer disconnect in this
   * phase. Call it when your own app knows a viewer left.
   */
  leave(streamId: string, identity: string): Promise<void> {
    return this.http.request<void>(`/v1/live-streams/${encodeURIComponent(streamId)}/leave`, {
      method: 'POST',
      body: { identity },
    });
  }
}

/**
 * Restream ("RTMP out"): push a live stream to up to 5 RTMP/RTMPS
 * destinations at once, alongside RTC viewers and HLS.
 *
 * Destinations can be added, paused and removed while the stream is LIVE.
 * One destination failing never affects HLS or the other destinations; it
 * retries with backoff, then lands in `FAILED` and fires
 * `live_stream.restream_failed`.
 *
 * The destination's stream key is a third party's credential. It's encrypted
 * at rest and never returned by the API: `keyLast4` is all you get back. To
 * change a key, delete the destination and create it again.
 */
export class LiveStreamRestreamsResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  /** Adds a destination. If the stream is LIVE, pushing starts immediately. */
  create(streamId: string, params: CreateRestreamParams): Promise<RestreamView> {
    return this.http.request<RestreamView>(`/v1/live-streams/${encodeURIComponent(streamId)}/restreams`, {
      method: 'POST',
      body: params,
    });
  }

  list(streamId: string): Promise<RestreamView[]> {
    return this.http.request<RestreamView[]>(`/v1/live-streams/${encodeURIComponent(streamId)}/restreams`);
  }

  /** `enabled: false` pauses one destination mid-stream; `true` resumes it. */
  update(streamId: string, restreamId: string, params: UpdateRestreamParams): Promise<RestreamView> {
    return this.http.request<RestreamView>(
      `/v1/live-streams/${encodeURIComponent(streamId)}/restreams/${encodeURIComponent(restreamId)}`,
      { method: 'PATCH', body: params },
    );
  }

  /** Stops pushing to the destination and removes it. */
  delete(streamId: string, restreamId: string): Promise<void> {
    return this.http.request<void>(
      `/v1/live-streams/${encodeURIComponent(streamId)}/restreams/${encodeURIComponent(restreamId)}`,
      { method: 'DELETE' },
    );
  }
}

/**
 * Ingest: broadcast into a stream from OBS, vMix, ffmpeg or a hardware
 * encoder instead of a Swalvo SDK. One ingest per stream.
 *
 * The encoder joins the stream's room as an ordinary host (by default the
 * stream's HOST identity, so it replaces a browser host on the same identity),
 * which means RTC viewers, HLS and restream destinations all see it like any
 * other host.
 *
 * The stream key (`sk_...`) is the RTMP stream key and the WHIP bearer token.
 * It's stored only as a hash and returned only by `create()` and `reset()`.
 */
export class LiveStreamIngressResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  /** Creates the stream's ingest and returns its URLs plus the stream key. The key is shown this once. */
  create(streamId: string, params: CreateIngressParams = {}): Promise<IngressWithKey> {
    return this.http.request<IngressWithKey>(`/v1/live-streams/${encodeURIComponent(streamId)}/ingress`, {
      method: 'POST',
      body: params,
    });
  }

  /** Current status and the encoder's observed input. Never includes the stream key. */
  get(streamId: string): Promise<IngressView> {
    return this.http.request<IngressView>(`/v1/live-streams/${encodeURIComponent(streamId)}/ingress`);
  }

  /** Rotates the stream key and disconnects any connected encoder. The old key stops working immediately. */
  reset(streamId: string): Promise<IngressWithKey> {
    return this.http.request<IngressWithKey>(`/v1/live-streams/${encodeURIComponent(streamId)}/ingress/reset`, {
      method: 'POST',
    });
  }

  /** Deletes the ingest and disconnects any connected encoder. The stream itself keeps running. */
  delete(streamId: string): Promise<void> {
    return this.http.request<void>(`/v1/live-streams/${encodeURIComponent(streamId)}/ingress`, {
      method: 'DELETE',
    });
  }
}
