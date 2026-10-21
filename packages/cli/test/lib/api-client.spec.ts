import { jest } from '@jest/globals';
import { SwalvoApiClient } from '../../src/lib/api-client.js';
import { CliError } from '../../src/lib/errors.js';

function mockFetchSequence(...responses: Array<{ status: number; body?: unknown } | Error>) {
  const fn = jest.fn();
  for (const response of responses) {
    if (response instanceof Error) {
      fn.mockImplementationOnce(() => Promise.reject(response));
    } else {
      fn.mockImplementationOnce(() =>
        Promise.resolve({
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => response.body,
        }),
      );
    }
  }
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('SwalvoApiClient', () => {
  it('sends the Authorization header when a token is provided', async () => {
    const fetchMock = mockFetchSequence({ status: 200, body: [] });
    const client = new SwalvoApiClient('http://api.test', 'my-token');

    await client.listProjects();

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(options.headers.Authorization).toBe('Bearer my-token');
  });

  it('omits the Authorization header when no token is provided', async () => {
    const fetchMock = mockFetchSequence({ status: 200, body: { status: 'ok' } });
    const client = new SwalvoApiClient('http://api.test');

    await client.getHealth();

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(options.headers.Authorization).toBeUndefined();
  });

  it('returns undefined for a 204 response without attempting to parse a body', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error('must not be called');
      },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new SwalvoApiClient('http://api.test', 'token');

    await expect(client.deleteProject('p1')).resolves.toBeUndefined();
  });

  it('maps 401 to an auth CliError suggesting `swalvo login`', async () => {
    mockFetchSequence({ status: 401, body: { message: 'Invalid or missing credentials' } });
    const client = new SwalvoApiClient('http://api.test', 'bad-token');

    await expect(client.listProjects()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps 404 to a not_found CliError', async () => {
    mockFetchSequence({ status: 404, body: { message: 'Project not found' } });
    const client = new SwalvoApiClient('http://api.test', 'token');

    try {
      await client.getProject('missing');
      throw new Error('expected getProject to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('not_found');
      expect((error as CliError).message).toBe('Project not found');
    }
  });

  it('maps 403 to an authz CliError', async () => {
    mockFetchSequence({ status: 403, body: { message: 'Forbidden' } });
    const client = new SwalvoApiClient('http://api.test', 'token');

    await expect(client.listProjects()).rejects.toMatchObject({ kind: 'authz' });
  });

  it('retries a 5xx response up to the retry limit, then succeeds if a later attempt works', async () => {
    const fetchMock = mockFetchSequence(
      { status: 503, body: { message: 'unavailable' } },
      { status: 200, body: [{ id: 'p1' }] },
    );
    const client = new SwalvoApiClient('http://api.test', 'token');

    const result = await client.listProjects();

    expect(result).toEqual([{ id: 'p1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 404; not-found is never transient', async () => {
    const fetchMock = mockFetchSequence({ status: 404, body: { message: 'not found' } });
    const client = new SwalvoApiClient('http://api.test', 'token');

    await expect(client.getProject('x')).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 401; auth failures are never transient', async () => {
    const fetchMock = mockFetchSequence({ status: 401, body: { message: 'unauthorized' } });
    const client = new SwalvoApiClient('http://api.test', 'token');

    await expect(client.listProjects()).rejects.toMatchObject({ kind: 'auth' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a network-level failure (fetch throwing) to a network CliError after exhausting retries', async () => {
    const fetchMock = mockFetchSequence(
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
    );
    const client = new SwalvoApiClient('http://api.test', 'token');

    await expect(client.listProjects()).rejects.toMatchObject({ kind: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10000);

  it('never retries the public, non-retryable getHealth() call', async () => {
    // A 500 is a genuine unexpected failure with no structured body worth
    // trusting, unlike the health endpoint's own 503-for-degraded which is
    // tested below. So this still has to throw, and still never retry.
    const fetchMock = mockFetchSequence({ status: 500, body: { message: 'boom' } });
    const client = new SwalvoApiClient('http://api.test');

    await expect(client.getHealth()).rejects.toMatchObject({ kind: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getHealth() returns the parsed body for a 503 "degraded" response instead of throwing; the dependency breakdown is real, structured data, not a failure to surface as an error', async () => {
    const degradedBody = {
      status: 'degraded',
      dependencies: { database: 'up', redis: 'up', sfu: 'down', turn: 'up' },
      signaling: { activeConnections: 0, activeRooms: 0, activeParticipants: 0 },
    };
    mockFetchSequence({ status: 503, body: degradedBody });
    const client = new SwalvoApiClient('http://api.test');

    await expect(client.getHealth()).resolves.toEqual(degradedBody);
  });
});
