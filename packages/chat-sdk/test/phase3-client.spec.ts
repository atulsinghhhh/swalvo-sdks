import { ChatClient } from '../src/client';
import { validateConfig } from '../src/config';
import {
  SwalvoChatPermissionError,
  SwalvoMessageBlockedError,
  SwalvoModerationError,
  SwalvoRateLimitError,
  SwalvoSlowModeError,
  toSwalvoChatError,
} from '../src/errors';
import type { MemberModerationEvent, MessagePinEvent, PresenceCountEvent, RoomRemovedEvent } from '../src/types';
import { FakeSocket } from './helpers/fake-socket';
import { FakeRest } from './helpers/fake-rest';
import { fakeToken } from './helpers/token';

/**
 * §3–§6 client APIs, pinned to the contract: moderation (blocks, flags,
 * moderator actions, member.* events, typed refusals), push, mentions,
 * pins, search, paginated threads and presence, and audience viewers.
 */

const ROOM = 'conv_1';

function makeClient(token = fakeToken()) {
  return new ChatClient(
    validateConfig({ token, chatUrl: 'wss://api.test/v1/chat/ws', apiUrl: 'https://api.test' }),
    (url) => new FakeSocket(url),
  );
}

async function connect(client: ChatClient, room: string | null = ROOM): Promise<FakeSocket> {
  const promise = client.connect(room ? { room } : {});
  const socket = FakeSocket.latest;
  socket.open();
  socket.hello();
  await Promise.resolve();
  socket.ackLast({ room: room ?? 'conv_live' });
  await promise;
  return socket;
}

beforeEach(() => FakeSocket.reset());

describe('typed Phase 3 errors', () => {
  it.each([
    ['MUTED', SwalvoModerationError],
    ['BANNED', SwalvoModerationError],
    ['BLOCKED', SwalvoModerationError],
    ['SLOW_MODE', SwalvoSlowModeError],
    ['MESSAGE_BLOCKED', SwalvoMessageBlockedError],
  ])('maps %s to its class', (code, expected) => {
    const error = toSwalvoChatError(code, 'x', { retryAfterSeconds: 3, reason: 'r' });
    expect(error).toBeInstanceOf(expected);
    expect(error.code).toBe(code);
  });

  it('carries the rate-limit scope', () => {
    const error = toSwalvoChatError('RATE_LIMITED', 'busy room', { scope: 'conversation' }) as SwalvoRateLimitError;
    expect(error.scope).toBe('conversation');
  });

  it('maps an HTTP error by its chat code, not the canonical RAVEN_ code', async () => {
    const rest = new FakeRest();
    rest.on('POST', /\/me\/blocks\/bob$/, () => ({
      status: 429,
      body: { code: 'RAVEN_RATE_LIMITED', legacyCode: 'RATE_LIMITED', message: 'slow', retryAfterSeconds: 4 },
    }));
    rest.on('DELETE', /\/me\/blocks\/bob$/, () => ({ status: 403, body: { code: 'RAVEN_MUTED', message: 'muted' } }));
    const client = makeClient();
    await expect(client.moderation.block('bob')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 4 });
    await expect(client.moderation.block('bob')).rejects.toBeInstanceOf(SwalvoRateLimitError);
    // No legacyCode: the RAVEN_ prefix is stripped instead.
    await expect(client.moderation.unblock('bob')).rejects.toBeInstanceOf(SwalvoModerationError);
  });
});

describe('moderation', () => {
  it('blocks, unblocks and lists blocks through the me routes', async () => {
    const rest = new FakeRest();
    rest.on('POST', /\/v1\/chat\/me\/blocks\/bob$/, () => ({ status: 204 }));
    rest.on('DELETE', /\/v1\/chat\/me\/blocks\/bob$/, () => ({ status: 204 }));
    rest.on('GET', /\/v1\/chat\/me\/blocks$/, () => ({ body: { blocks: [{ blockedId: 'bob', createdAt: 't' }] } }));
    const client = makeClient();
    await client.moderation.block('bob');
    await client.moderation.unblock('bob');
    await expect(client.moderation.listBlocks()).resolves.toEqual([{ userId: 'bob', createdAt: 't' }]);
  });

  it('flags a message with a reason and note', async () => {
    const rest = new FakeRest();
    rest.on('POST', /\/v1\/chat\/messages\/msg_9\/flags$/, () => ({ body: { id: 'flag_1', status: 'OPEN' } }));
    const client = makeClient();
    await expect(client.moderation.flagMessage('msg_9', 'spam', 'link farm')).resolves.toEqual({
      id: 'flag_1',
      status: 'OPEN',
    });
    expect(rest.calls[0].body).toEqual({ reason: 'spam', note: 'link farm' });
  });

  it('sends moderator actions as acked socket frames', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);

    const banning = client.moderation.ban('mallory', { durationSeconds: 3600, reason: 'spam' });
    expect(socket.lastFrameOfType('moderation.ban')).toMatchObject({
      room: ROOM,
      userId: 'mallory',
      durationSeconds: 3600,
      reason: 'spam',
    });
    socket.ackLast({});
    await banning;

    for (const action of ['unban', 'mute', 'unmute'] as const) {
      const pending = client.moderation[action]('mallory', { room: 'conv_2' });
      expect(socket.lastFrameOfType(`moderation.${action}`)).toMatchObject({ room: 'conv_2', userId: 'mallory' });
      socket.ackLast({});
      await pending;
    }
  });

  it('rejects a moderator action the server refuses', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const muting = client.moderation.mute('bob');
    socket.emit({
      type: 'error',
      id: socket.lastFrameOfType('moderation.mute')!.id,
      code: 'PERMISSION_DENIED',
      message: 'not a moderator',
    });
    await expect(muting).rejects.toBeInstanceOf(SwalvoChatPermissionError);
  });

  it("emits member.* events and tracks this user's own mute", async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const events: Array<[string, MemberModerationEvent]> = [];
    for (const name of ['memberBanned', 'memberUnbanned', 'memberMuted', 'memberUnmuted'] as const) {
      client.on(name, (event) => events.push([name, event]));
    }

    const until = new Date(Date.now() + 60_000).toISOString();
    socket.emit({ type: 'member.muted', room: ROOM, userId: 'alice', by: 'mod', expiresAt: until, eventSeq: '1' });
    expect(client.moderation.getMyState(ROOM)).toEqual({
      muted: true,
      mutedUntil: until,
      banned: false,
      bannedUntil: null,
    });
    socket.emit({ type: 'member.unmuted', room: ROOM, userId: 'alice', by: 'mod', eventSeq: '2' });
    expect(client.moderation.getMyState(ROOM).muted).toBe(false);
    socket.emit({ type: 'member.banned', room: ROOM, userId: 'bob', by: 'mod', eventSeq: '3' });
    socket.emit({ type: 'member.unbanned', room: ROOM, userId: 'bob', by: 'mod', eventSeq: '4' });

    expect(events.map(([name, e]) => `${name}:${e.userId}`)).toEqual([
      'memberMuted:alice',
      'memberUnmuted:alice',
      'memberBanned:bob',
      'memberUnbanned:bob',
    ]);
    expect(events[0][1]).toEqual({ roomId: ROOM, userId: 'alice', by: 'mod', expiresAt: until });
  });

  it('lets an expired timed mute lapse by itself', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    socket.emit({
      type: 'member.muted',
      room: ROOM,
      userId: 'alice',
      by: 'mod',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(client.moderation.getMyState(ROOM).muted).toBe(false);
  });

  it('stops re-joining a room after a ban (room.left reason BANNED)', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const removed: RoomRemovedEvent[] = [];
    client.on('removedFromRoom', (event) => removed.push(event));

    socket.emit({ type: 'room.left', room: ROOM, reason: 'BANNED' });
    expect(removed).toEqual([{ roomId: ROOM, reason: 'BANNED' }]);
    expect(client.rooms).toEqual([]);
    expect(client.moderation.getMyState(ROOM).banned).toBe(true);
  });

  it("treats the gateway's uncorrelated NOT_A_MEMBER as a removal too", async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const removed: RoomRemovedEvent[] = [];
    client.on('removedFromRoom', (event) => removed.push(event));
    client.on('error', () => undefined);
    socket.emit({ type: 'error', code: 'NOT_A_MEMBER', message: 'removed', room: ROOM });
    expect(removed).toEqual([{ roomId: ROOM, reason: 'REMOVED' }]);
    expect(client.rooms).toEqual([]);
  });

  it('maps a room alias to its public id so a removal by id clears the alias', async () => {
    new FakeRest();
    const client = makeClient();
    const promise = client.connect({ room: 'support' });
    const socket = FakeSocket.latest;
    socket.open();
    socket.hello();
    await Promise.resolve();
    socket.emit({ type: 'room.joined', id: socket.lastFrameOfType('room.join')!.id, room: 'conv_support' });
    await promise;

    socket.emit({ type: 'room.left', room: 'conv_support', reason: 'BANNED' });
    expect(client.rooms).toEqual([]);
  });
});

describe('push', () => {
  it('registers, lists and unregisters devices', async () => {
    const rest = new FakeRest();
    rest.on('POST', /\/v1\/chat\/me\/devices$/, (call) => ({
      body: { ...(call.body as object), lastSeenAt: null, createdAt: 'now' },
    }));
    rest.on('GET', /\/v1\/chat\/me\/devices$/, () => ({ body: { devices: [{ token: 'tok', provider: 'fcm' }] } }));
    rest.on('DELETE', /\/v1\/chat\/me\/devices\/tok%2F1$/, () => ({ status: 204 }));
    const client = makeClient();

    await client.registerDevice({ provider: 'apns', token: 'abc', platform: 'ios', appBundleId: 'com.example' });
    expect(rest.calls[0].body).toEqual({ provider: 'apns', token: 'abc', platform: 'ios', appBundleId: 'com.example' });
    await expect(client.listDevices()).resolves.toEqual([{ token: 'tok', provider: 'fcm' }]);
    // Tokens can contain characters that need escaping in a path.
    await client.unregisterDevice('tok/1');
    expect(rest.callsTo(/devices\/tok%2F1$/, 'DELETE')).toHaveLength(1);
  });
});

describe('§5: pins, search, threads', () => {
  it('pins, unpins and lists pins', async () => {
    const rest = new FakeRest();
    rest.on('POST', /\/messages\/msg_1\/pin$/, () => ({ status: 204 }));
    rest.on('DELETE', /\/messages\/msg_1\/pin$/, () => ({ status: 204 }));
    rest.on('GET', /\/conversations\/conv_1\/pins$/, () => ({
      body: {
        data: [
          { message: { id: 'msg_1', seq: 3, roomId: ROOM }, pinnedBy: 'mod' },
          { id: 'msg_2', roomId: ROOM },
        ],
      },
    }));
    const client = makeClient();
    await client.messages.pin('msg_1');
    await client.messages.unpin('msg_1');
    const pins = await client.messages.listPins(ROOM);
    expect(pins.map((m) => m.id)).toEqual(['msg_1', 'msg_2']);
    expect(pins[0].seq).toBe('3');
  });

  it('emits pin events', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const pins: Array<[string, MessagePinEvent]> = [];
    client.on('messagePinned', (e) => pins.push(['pinned', e]));
    client.on('messageUnpinned', (e) => pins.push(['unpinned', e]));
    socket.emit({ type: 'message.pinned', roomId: ROOM, messageId: 'msg_1', by: 'mod', at: 't1' });
    socket.emit({ type: 'message.unpinned', roomId: ROOM, messageId: 'msg_1', by: 'mod', at: 't2' });
    expect(pins).toEqual([
      ['pinned', { roomId: ROOM, messageId: 'msg_1', message: null, by: 'mod', at: 't1' }],
      ['unpinned', { roomId: ROOM, messageId: 'msg_1', message: null, by: 'mod', at: 't2' }],
    ]);
  });

  it('searches one conversation with a cursor', async () => {
    const rest = new FakeRest();
    rest.on('GET', /\/conversations\/conv_1\/search$/, () => ({
      body: { data: [{ id: 'msg_5', roomId: ROOM }], nextCursor: 'n2' },
    }));
    const client = makeClient();
    const page = await client.messages.search({ room: ROOM, q: 'deploy', limit: 10, cursor: 'n1' });
    expect(rest.calls[0].query.get('q')).toBe('deploy');
    expect(rest.calls[0].query.get('cursor')).toBe('n1');
    expect(page).toMatchObject({ nextCursor: 'n2', hasMore: true });
    expect(page.data[0].id).toBe('msg_5');
  });

  it('paginates threads, and still accepts the bare array an older server returns', async () => {
    const rest = new FakeRest();
    rest.on('GET', /\/messages\/msg_root\/thread$/, (call) =>
      call.query.get('cursor')
        ? { body: { data: [{ id: 'msg_r3' }], nextCursor: null } }
        : { body: { data: [{ id: 'msg_root', replyCount: 3, lastReplyAt: 't' }, { id: 'msg_r1' }], nextCursor: 'c2' } },
    );
    rest.on('GET', /\/messages\/msg_old\/thread$/, () => ({ body: [{ id: 'msg_old' }, { id: 'msg_old_r' }] }));
    const client = makeClient();

    const first = await client.messages.threadPage('msg_root', { limit: 2 });
    expect(first).toMatchObject({ nextCursor: 'c2', hasMore: true });
    expect(first.data[0]).toMatchObject({ replyCount: 3, lastReplyAt: 't' });
    const second = await client.messages.threadPage('msg_root', { cursor: first.nextCursor });
    expect(second.data.map((m) => m.id)).toEqual(['msg_r3']);

    await expect(client.messages.thread('msg_old')).resolves.toHaveLength(2);
    expect((await client.messages.threadPage('msg_old')).hasMore).toBe(false);
  });

  it('passes afterSeq / beforeSeq to history', async () => {
    const rest = new FakeRest();
    rest.on('GET', /\/conversations\/conv_1\/messages$/, () => ({
      body: { data: [], nextCursor: null, hasMore: false },
    }));
    const client = makeClient();
    await client.messages.list({ room: ROOM, afterSeq: '10', beforeSeq: '20' });
    expect(rest.calls[0].query.get('afterSeq')).toBe('10');
    expect(rest.calls[0].query.get('beforeSeq')).toBe('20');
  });
});

describe('§6: presence in large rooms, audience viewers', () => {
  it('emits presence.count', async () => {
    new FakeRest();
    const client = makeClient();
    const socket = await connect(client);
    const counts: PresenceCountEvent[] = [];
    client.on('presenceCount', (e) => counts.push(e));
    socket.emit({ type: 'presence.count', room: ROOM, online: 1234 });
    expect(counts).toEqual([{ roomId: ROOM, online: 1234 }]);
  });

  it('paginates presence, and getPresence still returns a plain list', async () => {
    const rest = new FakeRest();
    rest.on('GET', /\/conversations\/conv_1\/presence$/, (call) =>
      call.query.get('cursor')
        ? { body: { data: [{ userId: 'c', status: 'away' }], nextCursor: null } }
        : { body: { data: [{ userId: 'a', status: 'online' }], nextCursor: 'p2' } },
    );
    rest.on('GET', /\/conversations\/conv_old\/presence$/, () => ({ body: [{ userId: 'z', status: 'online' }] }));
    const client = makeClient();
    const page = await client.listPresence({ room: ROOM, limit: 1 });
    expect(page).toEqual({ data: [{ userId: 'a', status: 'online' }], nextCursor: 'p2' });
    expect((await client.listPresence({ room: ROOM, cursor: 'p2' })).data[0].userId).toBe('c');
    await expect(client.getPresence('conv_old')).resolves.toEqual([{ userId: 'z', status: 'online' }]);
  });

  it("joins the token's audience room by default and refuses member-only features locally", async () => {
    const rest = new FakeRest();
    const client = makeClient(fakeToken({ aud_room: 'conv_live', role: 'VIEWER' }));
    expect(client.isAudienceViewer).toBe(true);

    const socket = await connect(client, null);
    expect(socket.lastFrameOfType('room.join')).toMatchObject({ room: 'conv_live' });

    // Viewers can post…
    const sending = client.sendMessage({ text: 'hello from the audience' });
    expect(socket.lastFrameOfType('message.send')).toMatchObject({ room: 'conv_live' });
    socket.ackLast({ message: { id: 'msg_v' }, deduplicated: false });
    await sending;

    // …but have no inbox, read receipts or push, and nothing hits the network for them.
    await expect(client.queryMyConversations()).rejects.toBeInstanceOf(SwalvoChatPermissionError);
    await expect(client.markAsRead('msg_v')).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    await expect(client.registerDevice({ provider: 'fcm', token: 't', platform: 'web' })).rejects.toBeDefined();
    await expect(client.setNotificationLevel('conv_live', 'none')).rejects.toBeDefined();
    expect(rest.calls).toEqual([]);
  });

  it('is not an audience viewer with an ordinary token', () => {
    expect(makeClient().isAudienceViewer).toBe(false);
  });
});
