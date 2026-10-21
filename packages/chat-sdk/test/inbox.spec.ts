import { ChatClient } from '../src/client';
import { validateConfig } from '../src/config';
import { Inbox, type InboxEventHandlers } from '../src/inbox';
import { createLogger } from '../src/logger';
import type { ChatMessage, InboxConversation, InboxPage } from '../src/types';
import { FakeSocket } from './helpers/fake-socket';
import { FakeRest } from './helpers/fake-rest';
import { fakeToken } from './helpers/token';

/** §2: the inbox query, and the live store that keeps unread counts right. */

function row(id: string, overrides: Partial<InboxConversation> = {}): InboxConversation {
  return {
    id,
    name: id,
    type: 'CHANNEL',
    metadata: {},
    role: 'MEMBER',
    muted: false,
    lastMessage: {
      id: `${id}_m10`,
      seq: '10',
      senderId: 'bob',
      content: 'hi',
      type: 'TEXT',
      createdAt: '2026-01-01T00:00:10.000Z',
    },
    unreadCount: 2,
    unreadMentions: 0,
    lastReadSeq: '8',
    updatedAt: '2026-01-01T00:00:10.000Z',
    ...overrides,
  };
}

function live(room: string, seq: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 1, seq)).toISOString();
  return {
    id: `${room}_m${seq}`,
    cursor: 'c',
    seq: String(seq),
    roomId: room,
    conversationId: room,
    senderId: 'bob',
    type: 'text',
    text: `m${seq}`,
    replyTo: null,
    threadRootId: null,
    clientMessageId: null,
    metadata: null,
    attachment: null,
    reactions: [],
    mentions: [],
    edited: false,
    deleted: false,
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeInbox(pages: InboxPage[]) {
  let handlers!: InboxEventHandlers;
  const joined: string[] = [];
  const queries: unknown[] = [];
  const inbox = new Inbox({
    query: async (options) => {
      queries.push(options);
      return pages.shift() ?? { conversations: [], nextCursor: null };
    },
    userId: () => 'alice',
    joinRoom: async (room) => {
      joined.push(room);
    },
    listen: (h) => {
      handlers = h;
      return () => undefined;
    },
    logger: createLogger('silent'),
  });
  return { inbox, joined, queries, emit: () => handlers };
}

describe('Inbox', () => {
  it('loads the first page newest-activity first and sums the badge', async () => {
    const { inbox } = makeInbox([
      {
        conversations: [
          row('conv_a', { updatedAt: '2026-01-01T00:00:01.000Z', lastMessage: null, unreadCount: 1 }),
          row('conv_b', { unreadCount: 3 }),
          row('conv_muted', { muted: true, unreadCount: 7 }),
        ],
        nextCursor: 'next',
      },
    ]);
    const snapshot = await inbox.load();
    expect(snapshot.conversations.map((c) => c.id)).toEqual(['conv_b', 'conv_muted', 'conv_a']);
    // Muted conversations do not contribute to the badge.
    expect(snapshot.totalUnread).toBe(4);
    expect(snapshot.hasMore).toBe(true);
  });

  it('bumps unread and moves a conversation to the top on a new message', async () => {
    const { inbox, emit } = makeInbox([
      { conversations: [row('conv_a'), row('conv_b', { updatedAt: '2026-01-01T00:00:20.000Z' })], nextCursor: null },
    ]);
    await inbox.load();
    emit().message(live('conv_a', 11));
    const [top] = inbox.getSnapshot().conversations;
    expect(top.id).toBe('conv_a');
    expect(top.unreadCount).toBe(3);
    expect(top.lastMessage).toMatchObject({ id: 'conv_a_m11', seq: '11', content: 'm11' });
  });

  it('does not double count a message the server page already included', async () => {
    const { inbox, emit } = makeInbox([{ conversations: [row('conv_a')], nextCursor: null }]);
    await inbox.load();
    // seq 10 is the page's lastMessage: it is already in unreadCount.
    emit().message(live('conv_a', 10));
    emit().message(live('conv_a', 9));
    expect(inbox.getSnapshot().conversations[0].unreadCount).toBe(2);
  });

  it('counts mentions of this user separately', async () => {
    const { inbox, emit } = makeInbox([{ conversations: [row('conv_a')], nextCursor: null }]);
    await inbox.load();
    emit().message(live('conv_a', 11, { mentions: ['alice'] }));
    emit().message(live('conv_a', 12, { mentions: ['carol'] }));
    expect(inbox.getSnapshot().conversations[0]).toMatchObject({ unreadCount: 4, unreadMentions: 1 });
  });

  it("treats this user's own message as reading the conversation", async () => {
    const { inbox, emit } = makeInbox([{ conversations: [row('conv_a')], nextCursor: null }]);
    await inbox.load();
    emit().message(live('conv_a', 11, { senderId: 'alice' }));
    expect(inbox.getSnapshot().conversations[0]).toMatchObject({ unreadCount: 0, lastReadSeq: '11' });
    expect(inbox.getSnapshot().totalUnread).toBe(0);
  });

  it('clears unread when this user reads up to the newest message, from any device', async () => {
    const { inbox, emit } = makeInbox([{ conversations: [row('conv_a')], nextCursor: null }]);
    await inbox.load();
    emit().read({ roomId: 'conv_a', userId: 'bob', messageId: 'conv_a_m10' });
    expect(inbox.getSnapshot().conversations[0].unreadCount).toBe(2);
    emit().read({ roomId: 'conv_a', userId: 'alice', messageId: 'conv_a_m10' });
    expect(inbox.getSnapshot().conversations[0]).toMatchObject({ unreadCount: 0, lastReadSeq: '10' });
  });

  it('takes the server count from a read mark as authoritative', async () => {
    const { inbox } = makeInbox([{ conversations: [row('conv_a', { unreadCount: 9 })], nextCursor: null }]);
    await inbox.load();
    inbox.applyReadState({
      roomId: 'conv_a',
      userId: 'alice',
      lastReadMessageId: 'x',
      lastReadAt: 'now',
      unreadCount: 4,
    });
    expect(inbox.getSnapshot().conversations[0].unreadCount).toBe(4);
  });

  it('drops a conversation this user was removed from', async () => {
    const { inbox, emit } = makeInbox([{ conversations: [row('conv_a'), row('conv_b')], nextCursor: null }]);
    await inbox.load();
    emit().removed('conv_a');
    expect(inbox.getSnapshot().conversations.map((c) => c.id)).toEqual(['conv_b']);
  });

  it('refreshes from the server for a message in a conversation it does not have', async () => {
    const { inbox, emit, queries } = makeInbox([
      { conversations: [row('conv_a')], nextCursor: null },
      { conversations: [row('conv_new', { updatedAt: '2026-02-01T00:00:00.000Z' }), row('conv_a')], nextCursor: null },
    ]);
    await inbox.load();
    emit().message(live('conv_new', 1));
    emit().message(live('conv_new', 2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Coalesced: two messages, one refresh.
    expect(queries).toHaveLength(2);
    expect(inbox.getSnapshot().conversations[0].id).toBe('conv_new');
  });

  it('watches at most watchLimit conversations', async () => {
    const { inbox, joined } = makeInbox([
      { conversations: [row('c1'), row('c2'), row('c3'), row('c4')], nextCursor: null },
    ]);
    await inbox.load({ watchLimit: 2 });
    expect(joined).toHaveLength(2);
  });

  it('pages with the cursor and merges', async () => {
    const { inbox, queries } = makeInbox([
      { conversations: [row('c1')], nextCursor: 'cur_2' },
      { conversations: [row('c2', { updatedAt: '2025-01-01T00:00:00.000Z', lastMessage: null })], nextCursor: null },
    ]);
    await inbox.load({ limit: 1, watch: false });
    await inbox.loadMore();
    expect(queries[1]).toEqual({ limit: 1, cursor: 'cur_2' });
    expect(inbox.getSnapshot().conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(inbox.getSnapshot().hasMore).toBe(false);
  });
});

describe('client.queryMyConversations', () => {
  it('reads the chat-token inbox route and normalizes rows', async () => {
    const rest = new FakeRest();
    rest.on('GET', /\/v1\/chat\/me\/conversations$/, () => ({
      body: {
        conversations: [
          {
            id: 'conv_a',
            type: 'DIRECT',
            role: 'MEMBER',
            unreadCount: 1,
            lastMessage: { id: 'm', seq: 41, senderId: 'b', content: 'x', type: 'TEXT', createdAt: 'now' },
            updatedAt: 'now',
          },
        ],
        nextCursor: null,
      },
    }));
    const client = new ChatClient(
      validateConfig({ token: fakeToken(), apiUrl: 'https://api.test' }),
      (url) => new FakeSocket(url),
    );
    const page = await client.queryMyConversations({ limit: 20, cursor: 'abc' });
    const [call] = rest.calls;
    expect(call.query.get('limit')).toBe('20');
    expect(call.query.get('cursor')).toBe('abc');
    expect(page.conversations[0]).toMatchObject({
      id: 'conv_a',
      unreadMentions: 0,
      muted: false,
      metadata: {},
      lastReadSeq: null,
    });
    expect(page.conversations[0].lastMessage?.seq).toBe('41');
  });

  it('updates the inbox from markAsRead and from notification preferences', async () => {
    const rest = new FakeRest();
    rest.on('GET', /\/me\/conversations$/, () => ({
      body: { conversations: [row('conv_a', { unreadCount: 5 })], nextCursor: null },
    }));
    rest.on('POST', /\/messages\/.+\/read$/, () => ({
      body: { roomId: 'conv_a', userId: 'alice', lastReadMessageId: 'x', lastReadAt: 'now', unreadCount: 0 },
    }));
    rest.on('PATCH', /\/me\/conversations\/conv_a$/, (call) => ({
      body: { roomId: 'conv_a', ...(call.body as object) },
    }));
    const client = new ChatClient(
      validateConfig({ token: fakeToken(), apiUrl: 'https://api.test' }),
      (url) => new FakeSocket(url),
    );
    await client.inbox.load({ watch: false });
    await client.markAsRead('x');
    expect(client.inbox.getSnapshot().conversations[0].unreadCount).toBe(0);

    const prefs = await client.setNotificationLevel('conv_a', 'mentions');
    expect(prefs).toEqual({ roomId: 'conv_a', notifications: 'mentions', muted: false });
    expect(rest.callsTo(/\/me\/conversations\/conv_a$/, 'PATCH')[0].body).toEqual({ notifications: 'mentions' });

    await client.muteConversation('conv_a');
    expect(client.inbox.getSnapshot().conversations[0]).toMatchObject({ muted: true });
  });
});
