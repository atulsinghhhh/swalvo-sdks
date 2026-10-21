import { RestClient } from '../src/internal/rest-client';
import { MessagesApi } from '../src/messages-api';
import { SwalvoMessageError, SwalvoRateLimitError } from '../src/errors';

/** Captures whatever request the SDK would have made, so we can assert on the URL it builds. */
function stubFetch(response: { status?: number; body?: unknown } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      json: async () => response.body ?? {},
    } as unknown as Response;
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  return calls;
}

function makeApi(room = 'room_123') {
  const rest = new RestClient('https://api.test', 'token');
  return new MessagesApi(
    rest,
    () => room,
    async () => ({}) as never,
  );
}

describe('messages.list', () => {
  it('paginates by cursor, not by offset', async () => {
    const calls = stubFetch({ body: { data: [], nextCursor: null, hasMore: false } });
    await makeApi().list({ limit: 50, before: 'CURSOR_A' });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('before')).toBe('CURSOR_A');
    // Offset pagination isn't offered at all. It can't be; there's no
    // parameter for it.
    expect(url.searchParams.get('offset')).toBeNull();
  });

  it('supports walking forward with `after`, which is how a client catches up after a reconnect', async () => {
    const calls = stubFetch({ body: { data: [], nextCursor: null, hasMore: false } });
    await makeApi().list({ after: 'CURSOR_B' });
    expect(new URL(calls[0].url).searchParams.get('after')).toBe('CURSOR_B');
  });

  it('omits parameters that were not supplied instead of sending empty ones', async () => {
    const calls = stubFetch({ body: { data: [] } });
    await makeApi().list({});
    const url = new URL(calls[0].url);
    expect(url.searchParams.has('before')).toBe(false);
    expect(url.searchParams.has('senderId')).toBe(false);
  });

  it('falls back to the connected room when none is given', async () => {
    const calls = stubFetch({ body: { data: [] } });
    await makeApi('support').list({});
    expect(calls[0].url).toContain('/v1/chat/conversations/support/messages');
  });

  it('URL-encodes the room reference', async () => {
    const calls = stubFetch({ body: { data: [] } });
    await makeApi('conv_a/b').list({});
    expect(calls[0].url).toContain('conv_a%2Fb');
  });
});

describe('messages mutations', () => {
  it('edits via PATCH', async () => {
    const calls = stubFetch({ body: { id: 'msg_1', edited: true } });
    const result = await makeApi().update('msg_1', { text: 'Updated message' });

    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: 'Updated message' });
    expect(result.edited).toBe(true);
  });

  it('deletes via DELETE and returns the tombstone', async () => {
    const calls = stubFetch({ body: { id: 'msg_1', deleted: true, text: null } });
    const result = await makeApi().delete('msg_1');

    expect(calls[0].init.method).toBe('DELETE');
    expect(result.deleted).toBe(true);
    expect(result.text).toBeNull();
  });

  it('adds a reaction', async () => {
    const calls = stubFetch({ body: { reactions: [{ emoji: '👍', count: 1, userIds: ['alice'] }] } });
    const result = await makeApi().addReaction('msg_1', '👍');

    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ emoji: '👍' });
    expect(result.reactions[0].count).toBe(1);
  });

  it('encodes the emoji in the remove URL', async () => {
    const calls = stubFetch({ body: { reactions: [] } });
    await makeApi().removeReaction('msg_1', '👍');
    expect(calls[0].url).toContain(encodeURIComponent('👍'));
  });
});

describe('error translation', () => {
  it('turns a server error body into the specific Swalvo error class', async () => {
    stubFetch({ status: 413, body: { code: 'MESSAGE_TOO_LARGE', message: 'too long' } });
    await expect(makeApi().update('msg_1', { text: 'x' })).rejects.toBeInstanceOf(SwalvoMessageError);
  });

  it('carries retryAfterSeconds through from a 429', async () => {
    stubFetch({ status: 429, body: { code: 'RATE_LIMITED', message: 'slow down', retryAfterSeconds: 5 } });
    await expect(makeApi().list({})).rejects.toMatchObject({ retryAfterSeconds: 5 });
    await expect(makeApi().list({})).rejects.toBeInstanceOf(SwalvoRateLimitError);
  });

  it('reports a network failure as a Swalvo error, not a raw TypeError', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(makeApi().list({})).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
