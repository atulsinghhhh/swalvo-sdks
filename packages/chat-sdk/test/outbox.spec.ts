import { ChatClient } from '../src/client';
import { validateConfig } from '../src/config';
import { SwalvoModerationError, SwalvoSlowModeError } from '../src/errors';
import { LocalStorageOutboxStorage, MemoryOutboxStorage, type OutboxEntry, type OutboxStorage } from '../src/outbox';
import { FakeSocket } from './helpers/fake-socket';
import { FakeRest } from './helpers/fake-rest';
import { fakeToken } from './helpers/token';

/**
 * The offline outbox: a send the connection loses is queued and re-sent on
 * reconnect with the same idempotency key, a send the server refuses is
 * `failed` until retried or cancelled, and the queue survives a reload
 * when given storage.
 */

const ROOM = 'conv_1';
const clients: ChatClient[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient(overrides: Record<string, unknown> = {}, token = fakeToken()) {
  const config = validateConfig({
    token,
    chatUrl: 'wss://api.test/v1/chat/ws',
    apiUrl: 'https://api.test',
    initialReconnectDelayMs: 5,
    maxReconnectDelayMs: 10,
    ...overrides,
  });
  const client = new ChatClient(config, (url) => new FakeSocket(url));
  clients.push(client);
  return client;
}

async function connect(client: ChatClient): Promise<FakeSocket> {
  const promise = client.connect({ room: ROOM });
  const socket = FakeSocket.latest;
  socket.open();
  socket.hello();
  await Promise.resolve();
  socket.ackLast({ room: ROOM });
  await promise;
  return socket;
}

async function nextSocket(before: number): Promise<FakeSocket> {
  const deadline = Date.now() + 4_000;
  while (FakeSocket.instances.length === before) {
    if (Date.now() > deadline) throw new Error('no replacement socket');
    await wait(2);
  }
  return FakeSocket.instances[before];
}

/** Acks every message.send on a socket as it arrives, like a healthy server. */
function autoAck(socket: FakeSocket): void {
  const original = socket.send.bind(socket);
  socket.send = (data: string) => {
    original(data);
    const sent = JSON.parse(data) as Record<string, unknown>;
    if (sent.type === 'room.join') {
      queueMicrotask(() => socket.emit({ type: 'ack', id: sent.id, ok: true, data: { room: sent.room } }));
    }
    if (sent.type === 'message.send') {
      queueMicrotask(() =>
        socket.emit({
          type: 'ack',
          id: sent.id,
          ok: true,
          data: {
            message: {
              id: `msg_${String(sent.clientMessageId)}`,
              clientMessageId: sent.clientMessageId,
              text: sent.text,
            },
            deduplicated: false,
          },
        }),
      );
    }
  };
}

beforeEach(() => FakeSocket.reset());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.disconnect().catch(() => undefined)));
});

describe('outbox', () => {
  it('removes an entry once the server confirms it, and reports each state on the way', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const states: string[][] = [];
    client.on('outboxChanged', (entries) => states.push(entries.map((e) => e.status)));

    const sending = client.sendMessage({ text: 'hi' });
    expect(client.outbox!.list()).toEqual([expect.objectContaining({ status: 'sending', text: 'hi', room: ROOM })]);
    socket.ackLast({ message: { id: 'msg_1' }, deduplicated: false });
    await sending;

    expect(client.outbox!.list()).toEqual([]);
    expect(states).toEqual([['pending'], ['sending'], []]);
  });

  it('emits outboxSent with the stored message before the entry leaves the list', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const order: string[] = [];
    client.on('outboxSent', (e) => order.push(`sent:${e.message.id}:${client.outbox!.list().length}`));
    client.on('outboxChanged', (entries) => order.push(`changed:${entries.length}`));

    const sending = client.sendMessage({ text: 'hi' });
    socket.ackLast({ message: { id: 'msg_1' }, deduplicated: false });
    await sending;
    // While outboxSent runs the entry is still listed (1); the removal follows.
    expect(order.slice(-2)).toEqual(['sent:msg_1:1', 'changed:0']);
  });

  it('keeps a send the connection dropped and re-sends it on reconnect with the same key', async () => {
    const rest = new FakeRest();
    rest.offline = true; // The HTTP fallback is down too: a real outage.
    const client = makeClient();
    const socket = await connect(client);

    const sending = client.sendMessage({ text: 'while the train enters a tunnel' });
    const key = socket.lastFrameOfType('message.send')!.clientMessageId;
    const before = FakeSocket.instances.length;
    socket.serverClose();

    // The promise reports this attempt, flagged as queued rather than lost.
    await expect(sending).rejects.toMatchObject({ code: 'CONNECTION_CLOSED', queued: true, clientMessageId: key });
    expect(client.outbox!.list()).toEqual([expect.objectContaining({ clientMessageId: key, status: 'pending' })]);

    const next = await nextSocket(before);
    autoAck(next);
    next.open();
    next.hello({ connectionId: 'ccn_2' });
    await wait(20);

    const resent = next.sent.filter((f) => f.type === 'message.send');
    expect(resent).toHaveLength(1);
    expect(resent[0].clientMessageId).toBe(key);
    expect(client.outbox!.list()).toEqual([]);
  });

  it('queues a send made while disconnected and flushes it, in order, on connect', async () => {
    const rest = new FakeRest();
    rest.offline = true;
    const client = makeClient();
    client.on('error', () => undefined);

    await client.joinRoom(ROOM);
    const first = client.sendMessage({ room: ROOM, text: 'one' });
    await expect(first).rejects.toMatchObject({ code: 'NETWORK_ERROR', queued: true });
    await expect(client.sendMessage({ room: ROOM, text: 'two' })).rejects.toMatchObject({ queued: true });
    expect(client.outbox!.list().map((e) => e.text)).toEqual(['one', 'two']);

    const promise = client.connect();
    const socket = FakeSocket.latest;
    autoAck(socket);
    socket.open();
    socket.hello();
    await promise;
    await wait(20);

    expect(socket.sent.filter((f) => f.type === 'message.send').map((f) => f.text)).toEqual(['one', 'two']);
    expect(client.outbox!.list()).toEqual([]);
  });

  it('marks a refused send failed instead of retrying it, with the typed error', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);

    const sending = client.sendMessage({ text: 'shh' });
    const id = socket.lastFrameOfType('message.send')!.id;
    socket.emit({ type: 'error', id, code: 'MUTED', message: 'You are muted' });

    await expect(sending).rejects.toBeInstanceOf(SwalvoModerationError);
    const [entry] = client.outbox!.list();
    expect(entry.status).toBe('failed');
    expect(entry.error).toMatchObject({ code: 'MUTED' });
    // And it knows it is muted now, without a member.muted event.
    expect(client.moderation.getMyState(ROOM).muted).toBe(true);
  });

  it('surfaces slow mode with its countdown', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const sending = client.sendMessage({ text: 'again' });
    const id = socket.lastFrameOfType('message.send')!.id;
    socket.emit({ type: 'error', id, code: 'SLOW_MODE', message: 'Slow down', retryAfterSeconds: 9 });
    await expect(sending).rejects.toBeInstanceOf(SwalvoSlowModeError);
    await expect(sending).rejects.toMatchObject({ retryAfterSeconds: 9 });
  });

  it('carries the moderation hook reason on MESSAGE_BLOCKED', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const sending = client.sendMessage({ text: 'nope' });
    const id = socket.lastFrameOfType('message.send')!.id;
    socket.emit({ type: 'error', id, code: 'MESSAGE_BLOCKED', message: 'Blocked', reason: 'spam_link' });
    await expect(sending).rejects.toMatchObject({ code: 'MESSAGE_BLOCKED', reason: 'spam_link' });
  });

  it('retry() re-sends a failed entry with its original key', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);

    const sending = client.sendMessage({ text: 'try me' });
    const first = socket.lastFrameOfType('message.send')!;
    socket.emit({ type: 'error', id: first.id, code: 'SLOW_MODE', message: 'wait', retryAfterSeconds: 1 });
    await expect(sending).rejects.toBeDefined();

    const retried = client.outbox!.retry(String(first.clientMessageId));
    const second = socket.lastFrameOfType('message.send')!;
    expect(second.clientMessageId).toBe(first.clientMessageId);
    expect(second.id).not.toBe(first.id);
    socket.ackLast({ message: { id: 'msg_ok' }, deduplicated: false });
    await expect(retried).resolves.toMatchObject({ id: 'msg_ok' });
    expect(client.outbox!.list()).toEqual([]);
  });

  it('cancel() drops a failed or pending entry, but never one already on the wire', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);

    const inFlight = client.sendMessage({ text: 'in flight' });
    const key = String(socket.lastFrameOfType('message.send')!.clientMessageId);
    await expect(client.outbox!.cancel(key)).resolves.toBe(false);

    socket.emit({ type: 'error', id: socket.lastFrameOfType('message.send')!.id, code: 'BLOCKED', message: 'blocked' });
    await expect(inFlight).rejects.toBeDefined();
    await expect(client.outbox!.cancel(key)).resolves.toBe(true);
    expect(client.outbox!.list()).toEqual([]);
    await expect(client.outbox!.cancel('cm_unknown')).resolves.toBe(false);
  });

  it('one entry per clientMessageId, even when the caller re-sends with the same key', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const first = client.sendMessage({ text: 'x', clientMessageId: 'cm_same' });
    socket.emit({ type: 'error', id: socket.lastFrameOfType('message.send')!.id, code: 'SLOW_MODE', message: 'wait' });
    await expect(first).rejects.toBeDefined();

    const again = client.sendMessage({ text: 'x', clientMessageId: 'cm_same' });
    expect(client.outbox!.list()).toHaveLength(1);
    socket.ackLast({ message: { id: 'msg_x' }, deduplicated: true });
    await expect(again).resolves.toMatchObject({ deduplicated: true });
  });

  it("survives a reload through its storage, and only replays this user's entries", async () => {
    new FakeRest();
    const stored: OutboxEntry[] = [
      {
        clientMessageId: 'cm_old',
        room: ROOM,
        userId: 'alice',
        text: 'from last session',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'sending',
        attempts: 1,
      },
      {
        clientMessageId: 'cm_other',
        room: ROOM,
        userId: 'mallory',
        text: 'not mine',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'pending',
        attempts: 0,
      },
    ];
    const saved: OutboxEntry[][] = [];
    const storage: OutboxStorage = {
      load: async () => stored,
      save: async (entries) => {
        saved.push(entries);
      },
    };
    const client = makeClient({ outbox: { storage } });

    const promise = client.connect({ room: ROOM });
    const socket = FakeSocket.latest;
    autoAck(socket);
    socket.open();
    socket.hello();
    await promise;
    await wait(20);

    const sends = socket.sent.filter((f) => f.type === 'message.send');
    // `sending` in storage means the last session died mid-send: resent, same key.
    expect(sends.map((f) => f.clientMessageId)).toEqual(['cm_old']);
    await client.outbox!.settled();
    // The other user's entry is kept in storage, untouched.
    expect(saved[saved.length - 1].map((e) => e.clientMessageId)).toEqual(['cm_other']);
  });

  it('waits out a rate limit while flushing a backlog instead of failing it', async () => {
    const rest = new FakeRest();
    rest.offline = true;
    const client = makeClient();
    await client.joinRoom(ROOM);
    await expect(client.sendMessage({ room: ROOM, text: 'queued' })).rejects.toMatchObject({ queued: true });

    const promise = client.connect();
    const socket = FakeSocket.latest;
    let refusals = 0;
    const original = socket.send.bind(socket);
    socket.send = (data: string) => {
      original(data);
      const sent = JSON.parse(data) as Record<string, unknown>;
      if (sent.type === 'room.join') {
        queueMicrotask(() => socket.emit({ type: 'ack', id: sent.id, ok: true, data: { room: sent.room } }));
      }
      if (sent.type === 'message.send') {
        queueMicrotask(() => {
          if (refusals++ === 0) {
            socket.emit({ type: 'error', id: sent.id, code: 'RATE_LIMITED', message: 'slow', retryAfterSeconds: 0.01 });
          } else {
            socket.emit({
              type: 'ack',
              id: sent.id,
              ok: true,
              data: { message: { id: 'msg_q' }, deduplicated: false },
            });
          }
        });
      }
    };
    socket.open();
    socket.hello();
    await promise;
    await wait(60);

    expect(refusals).toBe(2);
    expect(client.outbox!.list()).toEqual([]);
  });

  it('can be turned off for the pre-outbox behaviour', async () => {
    new FakeRest();
    const client = makeClient({ outbox: false });
    expect(client.outbox).toBeUndefined();
    const socket = await connect(client);
    const sending = client.sendMessage({ text: 'plain' });
    socket.ackLast({ message: { id: 'msg_plain' }, deduplicated: false });
    await expect(sending).resolves.toMatchObject({ id: 'msg_plain' });
  });

  it('refuses more than 50 mentions before queueing anything', async () => {
    new FakeRest();
    const client = makeClient();
    await connect(client);
    const mentions = Array.from({ length: 51 }, (_, i) => `u${i}`);
    await expect(client.sendMessage({ text: 'hi all', mentions })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(client.outbox!.list()).toEqual([]);
  });

  it('sends mentions over the socket and over HTTP', async () => {
    const rest = new FakeRest();
    rest.on('POST', /\/conversations\/conv_1\/messages$/, (call) => ({
      body: { id: 'msg_h', ...(call.body as object) },
    }));
    const client = makeClient();
    const socket = await connect(client);
    const viaSocket = client.sendMessage({ text: '@bob', mentions: ['bob'] }).catch(() => undefined);
    expect(socket.lastFrameOfType('message.send')).toMatchObject({ mentions: ['bob'] });

    await client.disconnect();
    await viaSocket;
    await client.sendMessage({ room: ROOM, text: '@carol', mentions: ['carol'] });
    expect(rest.callsTo(/\/messages$/, 'POST')[0].body).toMatchObject({ mentions: ['carol'] });
  });
});

describe('storage adapters', () => {
  it('MemoryOutboxStorage hands back copies, not live references', () => {
    const storage = new MemoryOutboxStorage();
    const entry: OutboxEntry = {
      clientMessageId: 'a',
      room: 'r',
      userId: 'u',
      createdAt: 'now',
      status: 'pending',
      attempts: 0,
    };
    storage.save([entry]);
    entry.status = 'failed';
    expect(storage.load()[0].status).toBe('pending');
  });

  it('LocalStorageOutboxStorage round-trips and tolerates garbage and a throwing storage', () => {
    const map = new Map<string, string>();
    const fake = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    const storage = new LocalStorageOutboxStorage('k', fake);
    const entry: OutboxEntry = {
      clientMessageId: 'a',
      room: 'r',
      userId: 'u',
      createdAt: 'now',
      status: 'pending',
      attempts: 0,
    };
    storage.save([entry]);
    expect(storage.load()).toEqual([entry]);

    map.set('k', '{not json');
    expect(storage.load()).toEqual([]);
    map.set('k', JSON.stringify([{ nope: true }, entry]));
    expect(storage.load()).toEqual([entry]);

    const broken = new LocalStorageOutboxStorage('k', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    });
    expect(broken.load()).toEqual([]);
    expect(() => broken.save([entry])).not.toThrow();
  });

  it('defaults to window.localStorage in a browser', () => {
    const storage = new LocalStorageOutboxStorage('swalvo-test');
    storage.save([{ clientMessageId: 'b', room: 'r', userId: 'u', createdAt: 'now', status: 'pending', attempts: 0 }]);
    expect(JSON.parse(localStorage.getItem('swalvo-test')!)).toHaveLength(1);
  });
});
