import { LiveStreamsResource } from '../../src/resources/live-streams';
import type { SwalvoHttpClient } from '../../src/http-client';

describe('LiveStreamsResource', () => {
  it('create() POSTs the stream params', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'stream_1' }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.create({ title: 'Q&A', hostIdentity: 'user-1' });

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams', {
      method: 'POST',
      body: { title: 'Q&A', hostIdentity: 'user-1' },
    });
  });

  it('list() calls GET /v1/live-streams with no query by default', async () => {
    const http = { request: jest.fn().mockResolvedValue([]) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.list();

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams');
  });

  it('list() filters by status', async () => {
    const http = { request: jest.fn().mockResolvedValue([]) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.list({ status: 'LIVE' });

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams?status=LIVE');
  });

  it('get() calls GET /v1/live-streams/:id', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'stream_1' }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.get('stream_1');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1');
  });

  it('update() PATCHes the given fields', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'stream_1' }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.update('stream_1', { title: 'New title' });

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1', {
      method: 'PATCH',
      body: { title: 'New title' },
    });
  });

  it('start() POSTs to the start endpoint', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'stream_1', status: 'LIVE' }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.start('stream_1');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/start', { method: 'POST' });
  });

  it('end() POSTs to the end endpoint', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'stream_1', status: 'ENDED' }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.end('stream_1');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/end', { method: 'POST' });
  });

  it('addHost() POSTs identity and role, minting host credentials', async () => {
    const http = { request: jest.fn().mockResolvedValue({ identity: 'user-2', role: 'CO_HOST', rtc: {}, chat: {} }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.addHost('stream_1', { identity: 'user-2' });

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/hosts', {
      method: 'POST',
      body: { identity: 'user-2' },
    });
  });

  it('removeHost() DELETEs the host by identity', async () => {
    const http = { request: jest.fn().mockResolvedValue(undefined) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.removeHost('stream_1', 'user-2');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/hosts/user-2', { method: 'DELETE' });
  });

  it('createViewerToken() POSTs the identity, never a role', async () => {
    const http = { request: jest.fn().mockResolvedValue({ identity: 'user-3', role: 'VIEWER', rtc: {} }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.createViewerToken('stream_1', 'user-3');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/viewer-tokens', {
      method: 'POST',
      body: { identity: 'user-3' },
    });
  });

  it('leave() POSTs the identity as a clean-leave signal', async () => {
    const http = { request: jest.fn().mockResolvedValue(undefined) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.leave('stream_1', 'user-3');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/leave', {
      method: 'POST',
      body: { identity: 'user-3' },
    });
  });
});

describe('LiveStreamsResource.restreams', () => {
  const view = { id: 'rst_1', url: 'rtmps://a.rtmp.youtube.com/live2', keyLast4: 'ab12' };

  it('is reachable from the parent resource', () => {
    const http = { request: jest.fn() };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    expect(resource.restreams).toBeDefined();
    expect(resource.ingress).toBeDefined();
  });

  it('create() POSTs url, streamKey and label', async () => {
    const http = { request: jest.fn().mockResolvedValue(view) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.restreams.create('stream_1', {
      url: 'rtmps://a.rtmp.youtube.com/live2',
      streamKey: 'xxxx-ab12',
      label: 'YouTube',
    });

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/restreams', {
      method: 'POST',
      body: { url: 'rtmps://a.rtmp.youtube.com/live2', streamKey: 'xxxx-ab12', label: 'YouTube' },
    });
  });

  it('list() GETs the stream restreams', async () => {
    const http = { request: jest.fn().mockResolvedValue([view]) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await expect(resource.restreams.list('stream_1')).resolves.toEqual([view]);
    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/restreams');
  });

  it('update() PATCHes enabled/label on one restream', async () => {
    const http = { request: jest.fn().mockResolvedValue({ ...view, enabled: false }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.restreams.update('stream_1', 'rst_1', { enabled: false });

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/restreams/rst_1', {
      method: 'PATCH',
      body: { enabled: false },
    });
  });

  it('delete() DELETEs one restream', async () => {
    const http = { request: jest.fn().mockResolvedValue(undefined) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.restreams.delete('stream_1', 'rst_1');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/restreams/rst_1', { method: 'DELETE' });
  });

  it('url-encodes ids', async () => {
    const http = { request: jest.fn().mockResolvedValue(undefined) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.restreams.delete('stream/1', 'rst 1');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream%2F1/restreams/rst%201', { method: 'DELETE' });
  });
});

describe('LiveStreamsResource.ingress', () => {
  it('create() POSTs the params', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'ing_1', streamKey: 'sk_abc' }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    const created = await resource.ingress.create('stream_1', { protocol: 'WHIP', reconnectWindowSec: 30 });

    expect(created.streamKey).toBe('sk_abc');
    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/ingress', {
      method: 'POST',
      body: { protocol: 'WHIP', reconnectWindowSec: 30 },
    });
  });

  it('create() sends an empty body by default', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'ing_1', streamKey: 'sk_abc' }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.ingress.create('stream_1');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/ingress', { method: 'POST', body: {} });
  });

  it('get() GETs the ingress', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'ing_1' }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.ingress.get('stream_1');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/ingress');
  });

  it('reset() POSTs to the reset endpoint', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'ing_1', streamKey: 'sk_new' }) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.ingress.reset('stream_1');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/ingress/reset', { method: 'POST' });
  });

  it('delete() DELETEs the ingress', async () => {
    const http = { request: jest.fn().mockResolvedValue(undefined) };
    const resource = new LiveStreamsResource(http as unknown as SwalvoHttpClient);

    await resource.ingress.delete('stream_1');

    expect(http.request).toHaveBeenCalledWith('/v1/live-streams/stream_1/ingress', { method: 'DELETE' });
  });
});

function fakeHttp() {
  const request = jest.fn().mockResolvedValue({});
  return { http: { request } as unknown as SwalvoHttpClient, request };
}

describe('live streams — stage and playback (v2)', () => {
  it('mints a playback-capable viewer token only when asked', async () => {
    const { http, request } = fakeHttp();
    const streams = new LiveStreamsResource(http);
    await streams.createViewerToken('stream_1', 'dave');
    await streams.createViewerToken('stream_1', 'dave', { acceptPlayback: true });
    expect(request.mock.calls[0]).toEqual([
      '/v1/live-streams/stream_1/viewer-tokens',
      { method: 'POST', body: { identity: 'dave' } },
    ]);
    expect(request.mock.calls[1]).toEqual([
      '/v1/live-streams/stream_1/viewer-tokens',
      { method: 'POST', body: { identity: 'dave', acceptPlayback: true } },
    ]);
  });

  it('routes stage calls', async () => {
    const { http, request } = fakeHttp();
    const streams = new LiveStreamsResource(http);
    await streams.stage.invite('stream_1', 'dave');
    await streams.stage.promote('stream_1', 'dave');
    await streams.stage.demote('stream_1', 'dave');
    expect(request.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      '/v1/live-streams/stream_1/stage/invites',
      '/v1/live-streams/stream_1/stage/promote',
      '/v1/live-streams/stream_1/stage/demote',
    ]);
  });
});
