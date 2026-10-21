import { SwalvoHttpClient } from '../src/http-client';
import { SwalvoError } from '../src/errors';

function mockFetchSequence(
  ...responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>
) {
  const fn = jest.fn();
  for (const response of responses) {
    if (response instanceof Error) {
      fn.mockImplementationOnce(() => Promise.reject(response));
    } else {
      fn.mockImplementationOnce(() =>
        Promise.resolve({
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          headers: { get: (name: string) => response.headers?.[name.toLowerCase()] ?? null },
          json: async () => response.body,
        }),
      );
    }
  }
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('SwalvoHttpClient', () => {
  it('throws INVALID_CONFIG synchronously when apiKey is missing', () => {
    expect(() => new SwalvoHttpClient({ apiKey: '' })).toThrow(SwalvoError);
    expect(() => new SwalvoHttpClient({ apiKey: '' })).toThrow(/apiKey is required/);
  });

  describe('baseUrl in production (external developer report #5)', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('throws instead of silently defaulting to localhost when NODE_ENV=production and baseUrl is omitted', () => {
      process.env.NODE_ENV = 'production';
      expect(() => new SwalvoHttpClient({ apiKey: 'k' })).toThrow(SwalvoError);
      expect(() => new SwalvoHttpClient({ apiKey: 'k' })).toThrow(/baseUrl is required outside local development/);
    });

    it('does not throw in production when baseUrl is given explicitly', () => {
      process.env.NODE_ENV = 'production';
      expect(() => new SwalvoHttpClient({ apiKey: 'k', baseUrl: 'https://api.livqeno.com' })).not.toThrow();
    });

    it('still defaults to localhost outside production, e.g. NODE_ENV unset or "development"', () => {
      delete process.env.NODE_ENV;
      const client = new SwalvoHttpClient({ apiKey: 'k' });
      expect(client.toString()).toBe('SwalvoHttpClient(http://localhost:4100)');
    });
  });

  it('sends the Authorization header and a User-Agent identifying the SDK', async () => {
    const fetchMock = mockFetchSequence({ status: 200, body: [] });
    const client = new SwalvoHttpClient({ apiKey: 'rvk_abc.secret' });

    await client.request('/v1/rooms');

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(options.headers.Authorization).toBe('Bearer rvk_abc.secret');
    expect(options.headers['User-Agent']).toMatch(/^Swalvo-Server-SDK\/\d+\.\d+\.\d+ \(node\)$/);
  });

  it('defaults to http://localhost:4100 when no baseUrl is given', async () => {
    const fetchMock = mockFetchSequence({ status: 200, body: [] });
    const client = new SwalvoHttpClient({ apiKey: 'k' });

    await client.request('/v1/rooms');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4100/v1/rooms');
  });

  it('serializes typed query params, omitting undefined values', async () => {
    const fetchMock = mockFetchSequence({ status: 200, body: [] });
    const client = new SwalvoHttpClient({ apiKey: 'k' });

    await client.request('/v1/connections', { query: { roomId: 'room-1', state: undefined, limit: 10 } });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('roomId=room-1');
    expect(url).toContain('limit=10');
    expect(url).not.toContain('state=');
  });

  it('returns undefined for a 204 response without parsing a body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
      json: async () => {
        throw new Error('must not be called');
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new SwalvoHttpClient({ apiKey: 'k' });

    await expect(client.request('/v1/rooms/r1')).resolves.toBeUndefined();
  });

  it('maps a 401 response to a SwalvoError with the right code/statusCode/requestId', async () => {
    mockFetchSequence({
      status: 401,
      body: { message: 'Invalid or missing credentials', code: 'UNAUTHORIZED' },
      headers: { 'x-request-id': 'req-123' },
    });
    const client = new SwalvoHttpClient({ apiKey: 'bad-key' });

    try {
      await client.request('/v1/rooms');
      throw new Error('expected request() to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SwalvoError);
      expect((error as SwalvoError).statusCode).toBe(401);
      expect((error as SwalvoError).requestId).toBe('req-123');
      expect((error as SwalvoError).message).toBe('Invalid or missing credentials');
    }
  });

  it('retries a 503 up to maxRetries, then succeeds on a later attempt', async () => {
    const fetchMock = mockFetchSequence(
      { status: 503, body: { message: 'unavailable' } },
      { status: 200, body: [{ id: 'r1' }] },
    );
    const client = new SwalvoHttpClient({ apiKey: 'k' });

    const result = await client.request('/v1/rooms');

    expect(result).toEqual([{ id: 'r1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 (rate limited)', async () => {
    const fetchMock = mockFetchSequence(
      { status: 429, body: { message: 'rate limit exceeded' } },
      { status: 200, body: [] },
    );
    const client = new SwalvoHttpClient({ apiKey: 'k' });

    await client.request('/v1/rooms');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries a 400 (validation error)', async () => {
    const fetchMock = mockFetchSequence({ status: 400, body: { message: 'bad input' } });
    const client = new SwalvoHttpClient({ apiKey: 'k' });

    await expect(client.request('/v1/rooms')).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries a 401/403/404', async () => {
    for (const status of [401, 403, 404]) {
      const fetchMock = mockFetchSequence({ status, body: { message: 'nope' } });
      const client = new SwalvoHttpClient({ apiKey: 'k' });
      await expect(client.request('/v1/rooms')).rejects.toMatchObject({ statusCode: status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('never retries when retryable: false is passed, even for a 503', async () => {
    const fetchMock = mockFetchSequence({ status: 503, body: { message: 'unavailable' } });
    const client = new SwalvoHttpClient({ apiKey: 'k' });

    await expect(client.request('/v1/rooms', { retryable: false })).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a network-level failure to a NETWORK_ERROR SwalvoError after exhausting retries', async () => {
    const fetchMock = mockFetchSequence(
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
    );
    const client = new SwalvoHttpClient({ apiKey: 'k' });

    await expect(client.request('/v1/rooms')).rejects.toMatchObject({ code: 'RAVEN_NETWORK_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('respects a configurable timeout and never hangs indefinitely', async () => {
    global.fetch = jest.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as { signal: AbortSignal }).signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;
    const client = new SwalvoHttpClient({ apiKey: 'k', timeout: 20, maxRetries: 0 });

    await expect(client.request('/v1/rooms')).rejects.toMatchObject({ code: 'RAVEN_TIMEOUT' });
  }, 2000);

  describe('the error vocabulary', () => {
    it('passes the API code through untouched', async () => {
      mockFetchSequence({ status: 404, body: { code: 'RAVEN_ROOM_NOT_FOUND', message: 'Room not found' } });
      const client = new SwalvoHttpClient({ apiKey: 'k' });

      await expect(client.request('/v1/rooms/x', { retryable: false })).rejects.toMatchObject({
        code: 'RAVEN_ROOM_NOT_FOUND',
      });
    });

    // A proxy or load balancer returning an HTML error page strips the JSON
    // body. The status still means something, and the code we derive from it
    // has to come out of the same vocabulary. Otherwise a caller's `switch`
    // on error.code quietly stops matching at the exact moment things are
    // at their worst.
    it.each([
      [401, 'RAVEN_AUTH_ERROR'],
      [403, 'RAVEN_PERMISSION_DENIED'],
      [404, 'RAVEN_NOT_FOUND'],
      [429, 'RAVEN_RATE_LIMITED'],
      [503, 'RAVEN_INTERNAL_ERROR'],
    ])('derives %s into %s when the body carries no code', async (status, expected) => {
      mockFetchSequence({ status, body: '<html>Gateway error</html>' });
      const client = new SwalvoHttpClient({ apiKey: 'k', maxRetries: 0 });

      await expect(client.request('/v1/rooms', { retryable: false })).rejects.toMatchObject({
        code: expected,
      });
    });

    it('surfaces the request id the API sent, so a bug report can name one', async () => {
      mockFetchSequence({
        status: 500,
        body: { code: 'RAVEN_INTERNAL_ERROR', message: 'boom' },
        headers: { 'x-request-id': 'req_abc123' },
      });
      const client = new SwalvoHttpClient({ apiKey: 'k', maxRetries: 0 });

      await expect(client.request('/v1/rooms', { retryable: false })).rejects.toMatchObject({
        requestId: 'req_abc123',
      });
    });
  });

  describe('secret redaction', () => {
    it('toString() never includes the API key', () => {
      const client = new SwalvoHttpClient({ apiKey: 'rvk_super-secret-value.dontleakme' });
      expect(String(client)).not.toContain('dontleakme');
      expect(client.toString()).not.toContain('rvk_super-secret-value');
    });

    it('JSON.stringify() never includes the API key', () => {
      const client = new SwalvoHttpClient({ apiKey: 'rvk_super-secret-value.dontleakme' });
      expect(JSON.stringify(client)).not.toContain('dontleakme');
    });

    it('a thrown SwalvoError never includes the API key, even when the server echoes the request', async () => {
      mockFetchSequence({ status: 400, body: { message: 'validation failed', code: 'VALIDATION_FAILED' } });
      const client = new SwalvoHttpClient({ apiKey: 'rvk_super-secret-value.dontleakme' });

      try {
        await client.request('/v1/rooms');
        throw new Error('expected to throw');
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain('dontleakme');
        expect((error as Error).message).not.toContain('dontleakme');
      }
    });
  });
});
