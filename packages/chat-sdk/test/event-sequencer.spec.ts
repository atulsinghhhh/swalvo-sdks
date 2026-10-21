import { ChatClient, type RecoverySummary } from '../src/client';
import { validateConfig } from '../src/config';
import { toSwalvoChatError } from '../src/errors';
import { EventSequencer, type ChatEventPage, type ChatEventRecord } from '../src/internal/event-sequencer';
import { compareSeq, parseSeq } from '../src/internal/seq';
import { createLogger } from '../src/logger';
import type { ChatMessage, MessagePage } from '../src/types';
import { FakeSocket } from './helpers/fake-socket';
import { FakeRest } from './helpers/fake-rest';
import { fakeToken } from './helpers/token';

/**
 * §1 ordering and gap detection: eventSeq-ordered application,
 * de-duplication, live gap backfill, catch-up after a reconnect, and the
 * EVENTS_EXPIRED fallback to re-reading history.
 */

const ROOM = 'conv_1';

function frame(seq: number, type = 'reaction.added', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    roomId: ROOM,
    eventSeq: String(seq),
    messageId: 'msg_1',
    userId: 'bob',
    emoji: '👍',
    at: 'now',
    ...extra,
  };
}

function record(seq: number, type = 'reaction.added', extra: Record<string, unknown> = {}): ChatEventRecord {
  const { type: _type, eventSeq: _seq, ...payload } = frame(seq, type, extra);
  return { eventSeq: String(seq), type, payload };
}

/** A sequencer with a controllable event log. */
function makeSequencer(log: ChatEventRecord[] = [], options: { gapFillDelayMs?: number } = {}) {
  const applied: string[] = [];
  const fetches: string[] = [];
  const failures: Array<Error | null> = [];
  const expired: string[] = [];
  const sequencer = new EventSequencer({
    fetchEvents: async (_room, after, limit): Promise<ChatEventPage> => {
      fetches.push(after);
      const failure = failures.shift();
      if (failure) throw failure;
      const rest = log.filter((entry) => BigInt(entry.eventSeq) > BigInt(after));
      return { events: rest.slice(0, limit), hasMore: rest.length > limit };
    },
    apply: (f, origin) => applied.push(`${f.eventSeq}:${origin}`),
    onExpired: async (room) => {
      expired.push(room);
    },
    logger: createLogger('silent'),
    isConnected: () => true,
    maxAttempts: 3,
    retryDelayMs: () => 0,
    sleep: async () => undefined,
    gapFillDelayMs: options.gapFillDelayMs ?? 5,
  });
  return { sequencer, applied, fetches, failures, expired };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('seq helpers', () => {
  it('compares 64-bit seqs numerically, not as strings', () => {
    // The whole reason seq is compared through a helper: "10" < "9" as strings.
    expect(compareSeq('10', '9')).toBeGreaterThan(0);
    expect(compareSeq('9007199254740993', '9007199254740992')).toBeGreaterThan(0);
    expect(compareSeq('5', '5')).toBe(0);
  });

  it('sorts a missing seq first, so an old-server message never jumps ahead', () => {
    expect(compareSeq(undefined, '1')).toBeLessThan(0);
    expect(compareSeq('1', null)).toBeGreaterThan(0);
  });

  it('rejects anything that is not a non-negative integer', () => {
    expect(parseSeq('-1')).toBeNull();
    expect(parseSeq('1.5')).toBeNull();
    expect(parseSeq('abc')).toBeNull();
    expect(parseSeq(42)).toBe(42n);
  });
});

describe('EventSequencer, live', () => {
  it('applies in-order events as they arrive', () => {
    const { sequencer, applied } = makeSequencer();
    sequencer.ingest(ROOM, frame(1));
    sequencer.ingest(ROOM, frame(2));
    sequencer.ingest(ROOM, frame(3));
    expect(applied).toEqual(['1:live', '2:live', '3:live']);
    expect(sequencer.lastEventSeq(ROOM)).toBe('3');
  });

  it('drops an event it has already applied', () => {
    const { sequencer, applied } = makeSequencer();
    sequencer.ingest(ROOM, frame(1));
    sequencer.ingest(ROOM, frame(2));
    sequencer.ingest(ROOM, frame(2));
    sequencer.ingest(ROOM, frame(1));
    expect(applied).toEqual(['1:live', '2:live']);
  });

  it('passes frames without an eventSeq straight through (typing, presence, older servers)', () => {
    const { sequencer, applied } = makeSequencer();
    sequencer.ingest(ROOM, { type: 'typing.started', roomId: ROOM });
    expect(applied).toEqual(['undefined:live']);
    expect(sequencer.lastEventSeq(ROOM)).toBeNull();
  });

  it('reorders a pair that arrives swapped without asking the server', async () => {
    const { sequencer, applied, fetches } = makeSequencer([], { gapFillDelayMs: 50 });
    sequencer.ingest(ROOM, frame(1));
    sequencer.ingest(ROOM, frame(3));
    sequencer.ingest(ROOM, frame(2));
    expect(applied).toEqual(['1:live', '2:live', '3:live']);
    await wait(80);
    // The hole closed by itself inside the grace period, so no backfill.
    expect(fetches).toEqual([]);
  });

  it('backfills a gap that does not close by itself, then releases what it held', async () => {
    const log = [record(1), record(2), record(3), record(4)];
    const { sequencer, applied, fetches } = makeSequencer(log);
    sequencer.ingest(ROOM, frame(1));
    sequencer.ingest(ROOM, frame(4));
    expect(applied).toEqual(['1:live']);

    await wait(30);
    expect(fetches).toEqual(['1']);
    // 2 and 3 from the log, 4 from the log too (the held live copy is the same event and is dropped).
    expect(applied).toEqual(['1:live', '2:catchup', '3:catchup', '4:catchup']);
    expect(sequencer.lastEventSeq(ROOM)).toBe('4');
  });

  it('steps over a hole the log cannot fill (an event filtered for this user, e.g. a blocked sender)', async () => {
    // seq 2 belongs to a blocked user: not delivered live, not in this user's log.
    const log = [record(1), record(3)];
    const { sequencer, applied } = makeSequencer(log);
    sequencer.ingest(ROOM, frame(1));
    sequencer.ingest(ROOM, frame(3));
    sequencer.ingest(ROOM, frame(5));
    await wait(30);
    expect(applied).toEqual(['1:live', '3:catchup', '5:live']);
    expect(sequencer.lastEventSeq(ROOM)).toBe('5');
  });

  it('pages through a long backlog', async () => {
    const log = Array.from({ length: 1_200 }, (_, i) => record(i + 1));
    const { sequencer, applied, fetches } = makeSequencer(log);
    sequencer.baseline(ROOM, '1');
    await sequencer.catchUp(ROOM);
    expect(fetches).toEqual(['1', '501', '1001']);
    expect(applied).toHaveLength(1_199);
    expect(sequencer.lastEventSeq(ROOM)).toBe('1200');
  });
});

describe('EventSequencer, catch-up', () => {
  it('holds live frames during a catch-up and applies them after the older events', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const applied: string[] = [];
    const sequencer = new EventSequencer({
      fetchEvents: async () => {
        await gate;
        return { events: [record(2), record(3)], hasMore: false };
      },
      apply: (f, origin) => applied.push(`${f.eventSeq}:${origin}`),
      onExpired: async () => undefined,
      logger: createLogger('silent'),
      isConnected: () => true,
      maxAttempts: 1,
      retryDelayMs: () => 0,
      sleep: async () => undefined,
      gapFillDelayMs: 5,
    });
    sequencer.baseline(ROOM, '1');

    const running = sequencer.catchUp(ROOM);
    sequencer.ingest(ROOM, frame(4));
    sequencer.ingest(ROOM, frame(3));
    expect(applied).toEqual([]);

    release();
    await running;
    expect(applied).toEqual(['2:catchup', '3:catchup', '4:live']);
  });

  it('retries a failing log read, then reports the error without losing the resume point', async () => {
    const { sequencer, failures } = makeSequencer([record(2)]);
    sequencer.baseline(ROOM, '1');
    failures.push(new Error('boom'), new Error('boom'), new Error('boom'));
    const result = await sequencer.catchUp(ROOM);
    expect(result.error).toBeDefined();
    expect(sequencer.lastEventSeq(ROOM)).toBe('1');
  });

  it('falls back to re-reading history when the log has expired', async () => {
    const { sequencer, failures, expired } = makeSequencer();
    sequencer.baseline(ROOM, '1');
    failures.push(toSwalvoChatError('EVENTS_EXPIRED', 'gone'));
    const result = await sequencer.catchUp(ROOM);
    expect(result.expired).toBe(true);
    expect(expired).toEqual([ROOM]);
    // The old resume point is meaningless now; the next event starts afresh.
    expect(sequencer.lastEventSeq(ROOM)).toBeNull();
  });

  it('does nothing for a room it has never seen an event in', async () => {
    const { sequencer, fetches } = makeSequencer();
    const result = await sequencer.catchUp(ROOM);
    expect(result).toEqual({ room: ROOM, applied: 0, expired: false });
    expect(fetches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Through the client: what an application actually observes.
// ---------------------------------------------------------------------------

function message(n: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, n)).toISOString();
  const id = `msg_${String(n).padStart(4, '0')}`;
  return {
    id,
    cursor: btoa(`${createdAt}|${id}`),
    seq: String(n),
    roomId: ROOM,
    conversationId: ROOM,
    senderId: 'bob',
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
    ...extra,
  };
}

const clients: ChatClient[] = [];

function makeClient() {
  const config = validateConfig({
    token: fakeToken(),
    chatUrl: 'wss://api.test/v1/chat/ws',
    apiUrl: 'https://api.test',
    initialReconnectDelayMs: 5,
    maxReconnectDelayMs: 10,
    gapFillDelayMs: 5,
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

async function reconnect(socket: FakeSocket): Promise<FakeSocket> {
  const before = FakeSocket.instances.length;
  socket.serverClose();
  const deadline = Date.now() + 4_000;
  while (FakeSocket.instances.length === before) {
    if (Date.now() > deadline) throw new Error('no replacement socket');
    await wait(2);
  }
  const next = FakeSocket.instances[before];
  next.open();
  next.hello({ connectionId: 'ccn_2' });
  await Promise.resolve();
  next.ackLast({ room: ROOM });
  return next;
}

function recoveryOf(client: ChatClient): Promise<RecoverySummary> {
  return new Promise((resolve) => client.once('recovered', resolve));
}

beforeEach(() => FakeSocket.reset());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.disconnect().catch(() => undefined)));
});

describe('ChatClient eventSeq integration', () => {
  it('catches up an edit, a delete and a reaction missed while offline', async () => {
    const rest = new FakeRest();
    const client = makeClient();
    // Recovery's message replay: nothing new to replay.
    (client.messages as unknown as { listRaw: () => Promise<MessagePage> }).listRaw = async () => ({
      data: [],
      nextCursor: null,
      previousCursor: null,
      hasMore: false,
    });
    rest.on('GET', /\/conversations\/conv_1\/events$/, (call) => {
      expect(call.query.get('afterEventSeq')).toBe('1');
      return {
        body: {
          events: [
            {
              eventSeq: '2',
              type: 'message.updated',
              payload: { roomId: ROOM, message: message(1, { text: 'edited', edited: true }) },
            },
            {
              eventSeq: '3',
              type: 'reaction.added',
              payload: { roomId: ROOM, messageId: 'msg_0001', userId: 'carol', emoji: '🔥', at: 'now' },
            },
            {
              eventSeq: '4',
              type: 'message.deleted',
              payload: { roomId: ROOM, messageId: 'msg_0001', deletedAt: 'now', deletedBy: 'bob' },
            },
          ],
          hasMore: false,
        },
      };
    });

    const updates: string[] = [];
    const reactions: string[] = [];
    const deletes: string[] = [];
    client.on('messageUpdated', (m) => updates.push(String(m.text)));
    client.on('reactionAdded', (e) => reactions.push(e.emoji));
    client.on('messageDeleted', (e) => deletes.push(e.messageId));

    const socket = await connect(client);
    socket.emit({ type: 'message', eventSeq: '1', message: message(1) });

    const recovered = recoveryOf(client);
    await reconnect(socket);
    const summary = await recovered;

    expect(updates).toEqual(['edited']);
    expect(reactions).toEqual(['🔥']);
    expect(deletes).toEqual(['msg_0001']);
    expect(summary.events).toBe(3);
    expect(summary.resynced).toEqual([]);
  });

  it('applies a live frame that arrives during catch-up after the events before it, not ahead of them', async () => {
    const rest = new FakeRest();
    const client = makeClient();
    (client.messages as unknown as { listRaw: () => Promise<MessagePage> }).listRaw = async () => ({
      data: [],
      nextCursor: null,
      previousCursor: null,
      hasMore: false,
    });
    // Assigned once, after the handler that closes over it is registered.
    // eslint-disable-next-line prefer-const
    let next!: FakeSocket;
    rest.on('GET', /\/events$/, async () => {
      // The live frame for seq 3 lands while the log read for 2 is in flight.
      next.emit({
        type: 'reaction.removed',
        eventSeq: '3',
        roomId: ROOM,
        messageId: 'msg_0001',
        userId: 'carol',
        emoji: '🔥',
        at: 'now',
      });
      return {
        body: {
          events: [
            {
              eventSeq: '2',
              type: 'reaction.added',
              payload: { roomId: ROOM, messageId: 'msg_0001', userId: 'carol', emoji: '🔥', at: 'now' },
            },
          ],
          hasMore: false,
        },
      };
    });

    const order: string[] = [];
    client.on('reactionAdded', () => order.push('added'));
    client.on('reactionRemoved', () => order.push('removed'));

    const socket = await connect(client);
    socket.emit({ type: 'message', eventSeq: '1', message: message(1) });

    const recovered = recoveryOf(client);
    const before = FakeSocket.instances.length;
    socket.serverClose();
    while (FakeSocket.instances.length === before) await wait(2);
    next = FakeSocket.instances[before];
    next.open();
    next.hello({ connectionId: 'ccn_2' });
    await Promise.resolve();
    next.ackLast({ room: ROOM });
    await recovered;

    expect(order).toEqual(['added', 'removed']);
  });

  it('re-reads history and emits resync when the event log has expired', async () => {
    const rest = new FakeRest();
    const client = makeClient();
    const latest: MessagePage = {
      data: [message(9), message(8)],
      nextCursor: null,
      previousCursor: null,
      hasMore: false,
    };
    (client.messages as unknown as { listRaw: () => Promise<MessagePage> }).listRaw = async () => latest;
    rest.on('GET', /\/events$/, () => ({
      status: 410,
      body: { code: 'RAVEN_EVENTS_EXPIRED', legacyCode: 'EVENTS_EXPIRED', message: 'older than retention' },
    }));

    const resyncs: Array<{ roomId: string; page: MessagePage }> = [];
    client.on('resync', (event) => resyncs.push(event));

    const socket = await connect(client);
    socket.emit({ type: 'message', eventSeq: '1', message: message(1) });

    const recovered = recoveryOf(client);
    await reconnect(socket);
    const summary = await recovered;

    expect(resyncs).toHaveLength(1);
    expect(resyncs[0].roomId).toBe(ROOM);
    expect(resyncs[0].page.data.map((m) => m.id)).toEqual(['msg_0009', 'msg_0008']);
    expect(summary.resynced).toEqual([ROOM]);
    expect(summary.gap).toBe(true);
  });

  it('backfills a live gap through the events endpoint', async () => {
    const rest = new FakeRest();
    rest.on('GET', /\/events$/, () => ({
      body: {
        events: [
          {
            eventSeq: '2',
            type: 'reaction.added',
            payload: { roomId: ROOM, messageId: 'msg_0001', userId: 'carol', emoji: '✅', at: 'now' },
          },
        ],
        hasMore: false,
      },
    }));
    const client = makeClient();
    const emojis: string[] = [];
    client.on('reactionAdded', (e) => emojis.push(e.emoji));

    const socket = await connect(client);
    socket.emit({ type: 'message', eventSeq: '1', message: message(1) });
    socket.emit({
      type: 'reaction.added',
      eventSeq: '3',
      roomId: ROOM,
      messageId: 'msg_0001',
      userId: 'dan',
      emoji: '🎉',
      at: 'now',
    });
    expect(emojis).toEqual([]);

    await wait(40);
    expect(rest.callsTo(/\/events$/)).toHaveLength(1);
    expect(emojis).toEqual(['✅', '🎉']);
  });

  it('normalizes seq and lifts metadata.linkPreview onto live messages', async () => {
    new FakeRest();
    const client = makeClient();
    const seen: ChatMessage[] = [];
    client.on('message', (m) => seen.push(m));
    const socket = await connect(client);
    socket.emit({
      type: 'message',
      message: {
        ...message(1),
        seq: 41,
        metadata: { linkPreview: { url: 'https://example.com', title: 'Example', extra: 'dropped' } },
      },
    });
    expect(seen[0].seq).toBe('41');
    expect(seen[0].linkPreview).toEqual({
      url: 'https://example.com',
      title: 'Example',
      description: undefined,
      imageUrl: undefined,
      siteName: undefined,
    });
    expect(seen[0].mentions).toEqual([]);
  });

  it('passes the update reason through messageUpdated', async () => {
    new FakeRest();
    const client = makeClient();
    const reasons: Array<string | undefined> = [];
    client.on('messageUpdated', (_m, info) => reasons.push(info.reason));
    const socket = await connect(client);
    socket.emit({ type: 'message.updated', reason: 'link_preview', message: message(1) });
    socket.emit({ type: 'message.updated', message: message(1) });
    expect(reasons).toEqual(['link_preview', undefined]);
  });
});
