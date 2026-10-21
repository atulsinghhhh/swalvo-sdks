import { ConnectionsResource } from '../../src/resources/connections';
import { ErrorsResource } from '../../src/resources/errors-resource';
import type { SwalvoHttpClient } from '../../src/http-client';

describe('ConnectionsResource', () => {
  it('list() passes typed filters as query params, never an arbitrary query string', async () => {
    const http = { request: jest.fn().mockResolvedValue([]) };
    const resource = new ConnectionsResource(http as unknown as SwalvoHttpClient);

    await resource.list({ roomId: 'room-1', state: 'CONNECTED', limit: 25 });

    expect(http.request).toHaveBeenCalledWith('/v1/connections', {
      query: { roomId: 'room-1', state: 'CONNECTED', limit: 25 },
    });
  });

  it('get() fetches one connection by its public ID', async () => {
    const http = { request: jest.fn().mockResolvedValue({ publicId: 'conn_abc' }) };
    const resource = new ConnectionsResource(http as unknown as SwalvoHttpClient);

    await resource.get('conn_abc');

    expect(http.request).toHaveBeenCalledWith('/v1/connections/conn_abc');
  });
});

describe('ErrorsResource', () => {
  it('list() passes typed filters (category/connectionId/limit)', async () => {
    const http = { request: jest.fn().mockResolvedValue([]) };
    const resource = new ErrorsResource(http as unknown as SwalvoHttpClient);

    await resource.list({ category: 'ICE_ERROR', connectionId: 'conn_abc', limit: 10 });

    expect(http.request).toHaveBeenCalledWith('/v1/errors', {
      query: { category: 'ICE_ERROR', connectionId: 'conn_abc', limit: 10 },
    });
  });

  it('get() fetches one error by its public ID', async () => {
    const http = { request: jest.fn().mockResolvedValue({ publicId: 'err_abc', category: 'TOKEN_ERROR' }) };
    const resource = new ErrorsResource(http as unknown as SwalvoHttpClient);

    const error = await resource.get('err_abc');

    expect(http.request).toHaveBeenCalledWith('/v1/errors/err_abc');
    expect(error.category).toBe('TOKEN_ERROR');
  });
});
