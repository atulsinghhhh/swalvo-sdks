import { ChatClient } from '../src/client';
import { validateConfig } from '../src/config';
import type { ChatMessage, MessagePage } from '../src/types';
import { FakeSocket } from './helpers/fake-socket';
import { fakeToken } from './helpers/token';

/**
 * Automatic catch-up after a reconnect, against a fake socket and a fake
 * history endpoint.
 *
 * These cover the parts an end-to-end test can only observe by luck: the
 * exact interleaving of a live message arriving mid-catch-up, a socket
 * dropping halfway through, and a history call failing then succeeding.
 * The end-to-end suite proves the same behaviour against the real server.
 */

const ROOM = 'conv_room1';
const OTHER = 'conv_room2';

/** Builds a message the way the server serializes one, cursor included. */
function message(n: number, room = ROOM, sender = 'bob'): ChatMessage {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, n)).toISOString();
  const id = `msg_${String(n).padStart(4, '0')}`;
  return {
    id,
    // The real encoding: base64url of `createdAt|publicId`.
    cursor: btoa(`${createdAt}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    roomId: room,
    conversationId: room,
    senderId: sender,
    type: 'text',
    text: `m${n}`,
    replyTo: null,
    threadRootId: null,
    clientMessageId: null,
    metadata: null,
    attachment: null,
    reactions: [],
    edited: false,
    deleted: false,
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    deletedAt: null,
  };
}

/**
 * Stands in for `GET /v1/chat/conversations/:room/messages`, including the
 * bits recovery actually depends on: newest-first pages, `previousCursor`
 * as the forward anchor, and `hasMore`.
 */
class FakeHistory {
  readonly calls: Array<{ room: string; after?: string; limit?: number }> = [];
  private readonly store = new Map<string, ChatMessage[]>();
  /** Queued failures, consumed one per call. */
  failures: Array<Error | null> = [];
  onCall?: () => void;

  seed(room: string, messages: ChatMessage[]): void {
    this.store.set(room, messages);
  }

  handler = async (options: { room: string; after?: string; limit?: number }): Promise<MessagePage> => {
    this.calls.push(options);
    this.onCall?.();

    const failure = this.failures.shift();
    if (failure) throw failure;

    const all = this.store.get(options.room) ?? [];
    const limit = options.limit ?? 50;

    let start = 0;
    if (options.after) {
      const index = all.findIndex((m) => m.cursor === options.after);
      if (index === -1) {
        const error = new Error('Cursor is malformed') as Error & { code: string };
        error.code = 'INVALID_CURSOR';
        throw error;
      }
      start = index + 1;
    }

    const slice = all.slice(start, start + limit);
    const hasMore = all.length > start + limit;
    // The server returns newest-first whichever way it scanned.
    const data = [...slice].reverse();
    return {
      data,
      nextCursor: hasMore ? (data[data.length - 1]?.cursor ?? null) : null,
      previousCursor: data[0]?.cursor ?? null,
      hasMore,
    };
  };
}

/**
 * Every client built by a test, so teardown can stop them.
 *
 * Without this, a client left connected at the end of a test carries on
 * reconnecting in the background and constructs FakeSockets during the
 * *next* test — which then drives the wrong socket and hangs. That is a
 * property of the tests, not of the SDK, but it makes the suite flaky in
 * exactly the way that wastes an afternoon.
 */
const clients: ChatClient[] = [];

function makeClient(history: FakeHistory) {
  const config = validateConfig({
    token: fakeToken(),
    chatUrl: 'wss://api.test/v1/chat/ws',
    apiUrl: 'https://api.test',
    initialReconnectDelayMs: 10,
    maxReconnectDelayMs: 20,
    maxReconnectAttempts: 5,
  });
  const client = new ChatClient(config, (url) => new FakeSocket(url));
  // Recovery goes through MessagesApi.listRaw; point that at the fake.
  (client.messages as unknown as { listRaw: FakeHistory['handler'] }).listRaw = history.handler;
  clients.push(client);
  return client;
}

async function connect(client: ChatClient, rooms: string[]): Promise<FakeSocket> {
  const promise = client.connect({ rooms });
  const socket = FakeSocket.latest;
  socket.open();
  socket.hello();
  await Promise.resolve();
  for (const room of rooms) {
    socket.ackLast({ room });
    await Promise.resolve();
  }
  await promise;
  return socket;
}

/**
 * Drops the socket and lets the transport's backoff bring a new one up.
 *
 * Waits for the replacement socket to actually be constructed rather than
 * sleeping a fixed interval: the backoff is jittered, and a loaded machine
 * can fire the timer late enough that a fixed wait drives the *old* socket
 * and the test hangs waiting for a hello that never comes.
 */
async function reconnect(client: ChatClient, socket: FakeSocket, rooms: string[]): Promise<FakeSocket> {
  const before = FakeSocket.instances.length;
  socket.serverClose();
  const deadline = Date.now() + 4_000;
  while (FakeSocket.instances.length === before) {
    if (Date.now() > deadline) throw new Error('transport never opened a replacement socket');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // instances[before], not latest: the replacement this client just built,
  // rather than whichever socket happens to be newest globally.
  const next = FakeSocket.instances[before];
  next.open();
  next.hello({ connectionId: 'ccn_test_2' });
  await Promise.resolve();
  for (const room of rooms) {
    next.ackLast({ room });
    await Promise.resolve();
  }
  return next;
}

/** Waits for the `recovered` summary the client emits once catch-up finishes. */
function recoveryOf(client: ChatClient) {
  return new Promise<{ recovered: number; gap: boolean; errors: unknown[] }>((resolve) => {
    client.on('recovered', (summary) => resolve(summary));
  });
}

beforeEach(() => {
  FakeSocket.reset();
});

afterEach(async () => {
  // Stop every client this test created before the next one starts, so no
  // background reconnect can construct a socket the next test then grabs.
  await Promise.all(clients.splice(0).map((client) => client.disconnect().catch(() => undefined)));
});

describe('automatic recovery after reconnect', () => {
  it('delivers a single message missed while disconnected, exactly once', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));

    const socket = await connect(client, [ROOM]);

    // One message arrives live, establishing the resume point.
    socket.emit({ type: 'message', message: message(1) });
    expect(seen.map((m) => m.text)).toEqual(['m1']);

    // While the client is away, a second is stored.
    history.seed(ROOM, [message(1), message(2)]);

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    const summary = await done;

    expect(summary.recovered).toBe(1);
    expect(seen.map((m) => m.text)).toEqual(['m1', 'm2']);
    // Resumed from where it got to, not from the beginning of history.
    expect(history.calls[0].after).toBe(message(1).cursor);
  });

  it('recovers 10 missed messages in send order', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));

    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });

    history.seed(
      ROOM,
      Array.from({ length: 11 }, (_, i) => message(i + 1)),
    );

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    expect((await done).recovered).toBe(10);

    expect(seen.map((m) => m.text)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11']);
  });

  it('pages through an outage longer than one page (100 missed, page size 100)', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));

    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });

    // 250 missed: three pages at the 100-message recovery page size.
    history.seed(
      ROOM,
      Array.from({ length: 251 }, (_, i) => message(i + 1)),
    );

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    expect((await done).recovered).toBe(250);

    expect(seen).toHaveLength(251);
    expect(new Set(seen.map((m) => m.id)).size).toBe(251);
    // Strictly increasing: the documented per-sender order is preserved
    // across page boundaries, not just within a page.
    const ids = seen.map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);
    expect(history.calls.filter((c) => c.room === ROOM).length).toBe(3);
  });

  it('recovers each conversation independently', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));

    const socket = await connect(client, [ROOM, OTHER]);
    socket.emit({ type: 'message', message: message(1, ROOM) });
    socket.emit({ type: 'message', message: message(1, OTHER) });

    history.seed(ROOM, [message(1, ROOM), message(2, ROOM), message(3, ROOM)]);
    history.seed(OTHER, [message(1, OTHER), message(2, OTHER)]);

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM, OTHER]);
    expect((await done).recovered).toBe(3);

    expect(seen.filter((m) => m.roomId === ROOM)).toHaveLength(3);
    expect(seen.filter((m) => m.roomId === OTHER)).toHaveLength(2);
    // Each room resumed from its own position, not a shared one.
    const afters = history.calls.map((c) => `${c.room}:${c.after}`);
    expect(afters).toContain(`${ROOM}:${message(1, ROOM).cursor}`);
    expect(afters).toContain(`${OTHER}:${message(1, OTHER).cursor}`);
  });

  it('does not deliver a message twice when it arrives live and again from history', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));

    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });
    // Delivered live just before the drop — and still inside the window
    // the catch-up will re-read.
    socket.emit({ type: 'message', message: message(2) });

    history.seed(ROOM, [message(1), message(2), message(3)]);

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    await done;

    expect(seen.map((m) => m.text)).toEqual(['m1', 'm2', 'm3']);
    expect(new Set(seen.map((m) => m.id)).size).toBe(seen.length);
  });

  it('holds back a live message that arrives mid-catch-up so it cannot overtake older ones', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));

    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });
    history.seed(ROOM, [message(1), message(2), message(3)]);

    // Fire a *newer* live message while the history call is in flight.
    // FakeSocket.latest, not a captured variable: the catch-up starts
    // during reconnect(), before it has returned anything to capture.
    history.onCall = () => {
      history.onCall = undefined;
      FakeSocket.latest.emit({ type: 'message', message: message(9) });
    };

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    await done;
    await new Promise((resolve) => setTimeout(resolve, 10));

    // m9 must land after m2 and m3, not between them.
    expect(seen.map((m) => m.text)).toEqual(['m1', 'm2', 'm3', 'm9']);
  });

  it('retries a failing history call rather than reporting a clean recovery', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));

    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });
    history.seed(ROOM, [message(1), message(2)]);
    history.failures = [new Error('network down'), new Error('still down')];

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    const summary = await done;

    expect(history.calls.length).toBe(3); // two failures, then success
    expect(summary.recovered).toBe(1);
    expect(summary.errors).toHaveLength(0);
    expect(seen.map((m) => m.text)).toEqual(['m1', 'm2']);
    // Waits out two real backoff delays; generous so a loaded CI box does
    // not fail this for timing rather than behaviour.
  }, 20_000);

  it('reports the room as incomplete when retries run out, and keeps the cursor for next time', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });
    history.seed(ROOM, [message(1), message(2)]);
    history.failures = [new Error('down'), new Error('down'), new Error('down')];

    const done = recoveryOf(client);
    const live = await reconnect(client, socket, [ROOM]);
    const summary = await done;

    expect(summary.errors).toHaveLength(1);
    expect(summary.recovered).toBe(0);

    // The next reconnect resumes from the same point rather than skipping
    // the messages that were never recovered.
    history.failures = [];
    const secondDone = recoveryOf(client);
    await reconnect(client, live, [ROOM]);
    expect((await secondDone).recovered).toBe(1);
  }, 20_000);

  it('recovers from the newest page and flags a gap when the resume point is rejected', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });

    // History no longer contains the anchor — retention aged it out, or the
    // cursor was corrupted in storage.
    history.seed(ROOM, [message(50), message(51)]);

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    const summary = await done;

    expect(summary.gap).toBe(true);
    // And it does not pretend the missing messages were recovered.
    expect(summary.recovered).toBe(0);
  });

  it('abandons catch-up when the socket drops again, without losing its place', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));

    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });
    history.seed(
      ROOM,
      Array.from({ length: 251 }, (_, i) => message(i + 1)),
    );

    let calls = 0;
    history.onCall = () => {
      // Drop the socket while the first page is being fetched, so the
      // catch-up loop finds a dead connection on its next iteration.
      if (++calls === 1) FakeSocket.latest.serverClose();
    };

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    const summary = await done;

    // It stopped early rather than carrying on against a dead connection.
    expect(summary.recovered).toBeLessThan(250);
    expect(seen.length).toBeGreaterThan(1);
    // Everything it did deliver was in order and unique.
    const ids = seen.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('does not attempt recovery for a room that never delivered anything', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const socket = await connect(client, [ROOM]);

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    const summary = await done;

    expect(summary.recovered).toBe(0);
    expect(history.calls).toHaveLength(0);
  });

  it("uses a resume point established by the application's own history load", async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));

    // A quiet room: the app loads history, and the socket drops before any
    // live message has ever arrived.
    const socket = await connect(client, [ROOM]);
    (client.messages as unknown as { listRaw: FakeHistory['handler'] }).listRaw = history.handler;
    history.seed(ROOM, [message(1), message(2)]);
    await client.messages.list({ room: ROOM, limit: 50 });

    history.seed(ROOM, [message(1), message(2), message(3)]);
    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    const summary = await done;

    expect(summary.recovered).toBe(1);
    expect(seen.map((m) => m.text)).toEqual(['m3']);
  });

  it('never rewinds the resume point when older history is paged in', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const socket = await connect(client, [ROOM]);

    socket.emit({ type: 'message', message: message(10) });
    // The app scrolls back through older messages afterwards.
    history.seed(ROOM, [message(1), message(2)]);
    await client.messages.list({ room: ROOM, limit: 50 });

    history.seed(
      ROOM,
      Array.from({ length: 12 }, (_, i) => message(i + 1)),
    );
    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    await done;

    // Resumed from m10, the newest thing delivered — not from m2.
    expect(history.calls.at(-1)?.after).toBe(message(10).cursor);
  });

  it('forgets a room the caller deliberately left', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });

    const leaving = client.leaveRoom(ROOM);
    socket.ackLast({ room: ROOM });
    await leaving;

    history.seed(ROOM, [message(1), message(2)]);
    const done = recoveryOf(client);
    await reconnect(client, socket, []);
    expect((await done).recovered).toBe(0);
    expect(history.calls).toHaveLength(0);
  });

  it('does not replay typing, presence or read events', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const typing: unknown[] = [];
    const presence: unknown[] = [];
    const reads: unknown[] = [];
    client.on('typing', (e) => typing.push(e));
    client.on('presence', (e) => presence.push(e));
    client.on('read', (e) => reads.push(e));

    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });
    socket.emit({ type: 'typing.started', userId: 'bob', roomId: ROOM });
    socket.emit({ type: 'presence', userId: 'bob', roomId: ROOM, status: 'online', at: 'now' });
    socket.emit({ type: 'read', userId: 'bob', roomId: ROOM, messageId: 'msg_0001', at: 'now' });

    const before = { typing: typing.length, presence: presence.length, reads: reads.length };
    history.seed(ROOM, [message(1), message(2)]);

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    await done;

    // Catch-up reads messages and nothing else: ephemeral signals are
    // meaningless after the fact and are never replayed.
    expect(typing).toHaveLength(before.typing);
    expect(presence).toHaveLength(before.presence);
    expect(reads).toHaveLength(before.reads);
  });

  it('carries current reaction state on recovered messages', async () => {
    const history = new FakeHistory();
    const client = makeClient(history);
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));

    const socket = await connect(client, [ROOM]);
    socket.emit({ type: 'message', message: message(1) });

    const reacted = { ...message(2), reactions: [{ emoji: '👍', count: 2, userIds: ['bob', 'carol'] }] };
    history.seed(ROOM, [message(1), reacted]);

    const done = recoveryOf(client);
    await reconnect(client, socket, [ROOM]);
    await done;

    // Reactions come from the persisted message, not from replayed
    // reaction events, so they are whatever is true now.
    expect(seen.at(-1)?.reactions).toEqual([{ emoji: '👍', count: 2, userIds: ['bob', 'carol'] }]);
  });
});
