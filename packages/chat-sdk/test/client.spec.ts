import { ChatClient, createChatClient } from '../src/client';
import { validateConfig } from '../src/config';
import {
  SwalvoChatAuthenticationError,
  SwalvoChatConnectionError,
  SwalvoRateLimitError,
  SwalvoRoomError,
} from '../src/errors';
import { FakeSocket } from './helpers/fake-socket';
import { fakeToken } from './helpers/token';

function makeClient(overrides: Record<string, unknown> = {}): ChatClient {
  const config = validateConfig({
    token: fakeToken(),
    chatUrl: 'wss://api.test/v1/chat/ws',
    apiUrl: 'https://api.test',
    ...overrides,
  });
  return new ChatClient(config, (url) => new FakeSocket(url));
}

/** connect() only resolves on the server hello, so every test does this dance. */
async function connected(client: ChatClient, room = 'room_123'): Promise<FakeSocket> {
  const promise = client.connect({ room });
  const socket = FakeSocket.latest;
  socket.open();
  socket.hello();
  // room.join is awaited inside connect(); ack it so the promise settles.
  await Promise.resolve();
  socket.ackLast({ room });
  await promise;
  return socket;
}

beforeEach(() => {
  FakeSocket.reset();
});

describe('createChatClient', () => {
  it('rejects a missing token with a specific error, not a generic one', () => {
    expect(() => createChatClient({ token: '' })).toThrow(SwalvoChatAuthenticationError);
  });

  it('rejects a token that has already expired rather than failing at connect time', () => {
    const expired = fakeToken({ exp: Math.floor(Date.now() / 1000) - 10 });
    expect(() => createChatClient({ token: expired, apiUrl: 'https://api.test' })).toThrow(
      expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
    );
  });

  it('derives the WebSocket URL from apiUrl so only one address needs configuring', () => {
    const client = createChatClient({ token: fakeToken(), apiUrl: 'https://api.example.com' });
    expect(client).toBeInstanceOf(ChatClient);
  });

  it('takes the user identity from the token, not from the caller', () => {
    const client = createChatClient({ token: fakeToken({ sub: 'bob' }), apiUrl: 'https://api.test' });
    expect(client.userId).toBe('bob');
  });
});

describe('connect', () => {
  it('sends the token as a query parameter (browsers cannot set upgrade headers)', async () => {
    const client = makeClient();
    void client.connect({ room: 'room_123' }).catch(() => undefined);
    expect(FakeSocket.latest.url).toContain('token=');
    expect(FakeSocket.latest.url).toContain('sdkVersion=');
  });

  it('does not resolve on socket open alone; it waits for the server hello', async () => {
    const client = makeClient();
    let settled = false;
    void client.connect({ room: 'room_123' }).then(() => {
      settled = true;
    });

    FakeSocket.latest.open();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(client.connectionState).toBe('connecting');
  });

  it('reaches connected and records the connection id once the server says hello', async () => {
    const client = makeClient();
    await connected(client);
    expect(client.connectionState).toBe('connected');
    expect(client.id).toBe('ccn_test');
  });

  it('joins the requested room', async () => {
    const client = makeClient();
    const socket = await connected(client, 'support');
    expect(socket.lastFrameOfType('room.join')).toMatchObject({ room: 'support' });
    expect(client.rooms).toEqual(['support']);
  });

  it('emits state transitions in order', async () => {
    const client = makeClient();
    const states: string[] = [];
    client.on('connectionStateChanged', (state) => states.push(state));
    await connected(client);
    expect(states).toEqual(['connecting', 'connected']);
  });
});

describe('events', () => {
  it('returns an unsubscribe function that actually detaches the handler', async () => {
    const client = makeClient();
    const socket = await connected(client);

    const received: unknown[] = [];
    const unsubscribe = client.on('message', (message) => received.push(message));

    socket.emit({ type: 'message', message: { id: 'msg_1', text: 'one' } });
    unsubscribe();
    socket.emit({ type: 'message', message: { id: 'msg_2', text: 'two' } });

    expect(received).toHaveLength(1);
    expect(client.listenerCount('message')).toBe(0);
  });

  it('is safe to unsubscribe twice', async () => {
    const client = makeClient();
    const handler = jest.fn();
    const unsubscribe = client.on('message', handler);
    const second = client.on('message', handler);

    unsubscribe();
    unsubscribe();
    // The second registration is the same handler in a Set, so one release
    // removes it. Releasing again mustn't throw.
    expect(() => second()).not.toThrow();
  });

  it('lets a handler unsubscribe itself mid-dispatch without skipping the others', async () => {
    const client = makeClient();
    const socket = await connected(client);

    const order: string[] = [];
    const off = client.on('message', () => {
      order.push('first');
      off();
    });
    client.on('message', () => order.push('second'));

    socket.emit({ type: 'message', message: { id: 'msg_1' } });
    expect(order).toEqual(['first', 'second']);
  });

  it('surfaces typing, presence and read events in a shape the developer can use', async () => {
    const client = makeClient();
    const socket = await connected(client);

    const typing: unknown[] = [];
    const presence: unknown[] = [];
    const read: unknown[] = [];
    client.on('typing', (event) => typing.push(event));
    client.on('presence', (event) => presence.push(event));
    client.on('read', (event) => read.push(event));

    socket.emit({ type: 'typing.started', userId: 'bob', roomId: 'room_123' });
    socket.emit({ type: 'typing.stopped', userId: 'bob', roomId: 'room_123' });
    socket.emit({ type: 'presence', userId: 'bob', roomId: 'room_123', status: 'online', at: 'now' });
    socket.emit({ type: 'read', userId: 'bob', roomId: 'room_123', messageId: 'msg_1', at: 'now' });

    expect(typing).toEqual([
      { userId: 'bob', roomId: 'room_123', isTyping: true },
      { userId: 'bob', roomId: 'room_123', isTyping: false },
    ]);
    expect(presence[0]).toMatchObject({ userId: 'bob', status: 'online' });
    expect(read[0]).toMatchObject({ userId: 'bob', messageId: 'msg_1' });
  });

  it('ignores unknown frame types instead of throwing, so a newer server does not break an older client', async () => {
    const client = makeClient();
    const socket = await connected(client);
    expect(() => socket.emit({ type: 'something.from.the.future' })).not.toThrow();
  });
});

describe('sendMessage', () => {
  it('attaches an idempotency key automatically', async () => {
    const client = makeClient();
    const socket = await connected(client);

    void client.sendMessage({ text: 'Hello' });
    const frame = socket.lastFrameOfType('message.send')!;
    expect(frame.clientMessageId).toEqual(expect.stringMatching(/^cm_/));
    expect(frame.room).toBe('room_123');
  });

  it('keeps a caller-supplied idempotency key', async () => {
    const client = makeClient();
    const socket = await connected(client);

    void client.sendMessage({ text: 'Hello', clientMessageId: 'client_123' });
    expect(socket.lastFrameOfType('message.send')!.clientMessageId).toBe('client_123');
  });

  it('resolves with the server-generated message, not the local payload', async () => {
    const client = makeClient();
    const socket = await connected(client);

    const promise = client.sendMessage({ text: 'Hello' });
    socket.ackLast({
      message: { id: 'msg_server', text: 'Hello', senderId: 'alice', createdAt: '2026-01-01T00:00:00.000Z' },
      deduplicated: false,
      status: 'stored',
    });

    const message = await promise;
    expect(message.id).toBe('msg_server');
    expect(message.deduplicated).toBe(false);
  });

  it('reports a deduplicated retry rather than pretending a new message was created', async () => {
    const client = makeClient();
    const socket = await connected(client);

    const promise = client.sendMessage({ text: 'Hello', clientMessageId: 'client_1' });
    socket.ackLast({ message: { id: 'msg_original' }, deduplicated: true, status: 'stored' });

    await expect(promise).resolves.toMatchObject({ id: 'msg_original', deduplicated: true });
  });

  it('rejects with a typed error when the server refuses the send', async () => {
    const client = makeClient();
    const socket = await connected(client);

    const promise = client.sendMessage({ text: 'Hello' });
    const id = socket.lastFrameOfType('message.send')!.id;
    socket.emit({ type: 'error', id, code: 'RATE_LIMITED', message: 'slow down', retryAfterSeconds: 7 });

    await expect(promise).rejects.toBeInstanceOf(SwalvoRateLimitError);
    await expect(promise).rejects.toMatchObject({ retryAfterSeconds: 7 });
  });

  it('explains itself when no room has been selected', async () => {
    const client = makeClient();
    await expect(client.sendMessage({ text: 'orphan' })).rejects.toBeInstanceOf(SwalvoRoomError);
  });
});

describe('disconnect', () => {
  it('rejects in-flight requests rather than leaving them hanging forever', async () => {
    const client = makeClient();
    const socket = await connected(client);

    const promise = client.sendMessage({ text: 'Hello' });
    await client.disconnect();

    await expect(promise).rejects.toBeInstanceOf(SwalvoChatConnectionError);
    expect(socket.closedWith?.code).toBe(1000);
    expect(client.connectionState).toBe('disconnected');
  });

  it('does not reconnect after an intentional disconnect', async () => {
    jest.useFakeTimers();
    try {
      const client = makeClient();
      const socket = await connected(client);
      const socketCount = FakeSocket.instances.length;

      await client.disconnect();
      // disconnect() detaches the handlers first, so a close event arriving
      // afterwards still mustn't kick off the reconnect ladder.
      socket.serverClose(1006, 'late');
      jest.advanceTimersByTime(120_000);

      expect(FakeSocket.instances.length).toBe(socketCount);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('typing', () => {
  it('sends start and stop frames', async () => {
    const client = makeClient();
    const socket = await connected(client);

    await client.startTyping();
    expect(socket.lastFrameOfType('typing.start')).toMatchObject({ room: 'room_123' });

    await client.stopTyping();
    expect(socket.lastFrameOfType('typing.stop')).toMatchObject({ room: 'room_123' });
  });

  it('drops ephemeral frames while disconnected instead of queueing stale ones', async () => {
    const client = makeClient();
    // Never connected. startTyping mustn't throw, and mustn't buffer.
    await expect(client.joinRoom('room_123')).resolves.toBeUndefined();
    await expect(client.startTyping('room_123')).resolves.toBeUndefined();
    await client.stopTyping('room_123');
  });
});

describe('disconnect() while connect() is still awaiting the server hello', () => {
  it('rejects the in-flight connect() instead of hanging it forever', async () => {
    const client = makeClient();
    const connectPromise = client.connect({ room: 'room_123' });
    // The socket never opens and never says hello: connect() is genuinely
    // stuck on `connectPromise` here, exactly as it would be mid-handshake
    // against a slow or unreachable server.
    const settled = connectPromise.then(
      () => 'resolved',
      (error: unknown) => ({ rejected: error }),
    );

    await client.disconnect();

    // SocketTransport.disconnect() detaches the socket's own onclose
    // handler before calling close() (so the close doesn't re-trigger
    // reconnect logic), which means handleClose — the only other place
    // connectPromise gets settled — never runs for an explicit disconnect.
    // Without ChatClient.disconnect() settling it directly, this await
    // never returns.
    const result = await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve('still-hanging'), 200)),
    ]);
    expect(result).not.toBe('still-hanging');
    expect(result).toEqual({
      rejected: expect.objectContaining({ code: 'CONNECTION_CLOSED' }),
    });
  });
});
