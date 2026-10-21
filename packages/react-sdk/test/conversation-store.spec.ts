import { ConversationStore } from '../src/chat/conversation-store';
import { FakeChatClient, message } from './helpers/fake-chat-client';

/**
 * The per-room store behind useConversation and <MessageList>, against a
 * fake client: no React, no DOM, no socket.
 */
async function started(client: FakeChatClient, room = 'conv_1') {
  const store = new ConversationStore(client as never, room, { pageSize: 2 });
  await store.start();
  return store;
}

const ids = (store: ConversationStore) => store.getSnapshot().messages.map((m) => m.id);

describe('ConversationStore', () => {
  it('joins the room when the client is not in it yet, and loads history oldest-first', async () => {
    const client = new FakeChatClient();
    client.pages = [{ data: [message('m2'), message('m1')], nextCursor: 'C1', hasMore: true }];

    const store = await started(client);

    expect(client.joined).toEqual(['conv_1']);
    expect(ids(store)).toEqual(['m1', 'm2']);
    expect(store.getSnapshot().hasMore).toBe(true);
  });

  it('orders by seq, numerically, even when createdAt disagrees', async () => {
    const client = new FakeChatClient();
    const store = await started(client);

    client.emit('message', message('m10', { seq: '10', createdAt: '2026-01-01T00:00:01.000Z' }));
    client.emit('message', message('m9', { seq: '9', createdAt: '2026-01-01T00:00:05.000Z' }));
    client.emit('message', message('m100', { seq: '100', createdAt: '2026-01-01T00:00:02.000Z' }));

    // "100" < "9" as strings; the store must compare them as numbers.
    expect(ids(store)).toEqual(['m9', 'm10', 'm100']);
  });

  it('shows a send at once from the outbox, then replaces it in place with the stored message', async () => {
    const client = new FakeChatClient();
    let settle!: (value: unknown) => void;
    client.sendBehaviour = () => new Promise((resolve) => (settle = resolve));
    const store = await started(client);

    const sending = store.send('hi');
    const optimistic = store.getSnapshot().messages;
    expect(optimistic).toHaveLength(1);
    expect(optimistic[0]).toMatchObject({ text: 'hi', localStatus: 'sending', senderId: 'alice' });

    // The fan-out echo arrives carrying the same idempotency key.
    client.emit('message', message('msg_stored', { text: 'hi', senderId: 'alice', clientMessageId: 'cm_1' }));
    expect(ids(store)).toEqual(['msg_stored']);
    expect(store.getSnapshot().messages[0].localStatus).toBeUndefined();

    settle(message('msg_stored', { text: 'hi', senderId: 'alice', clientMessageId: 'cm_1' }));
    await sending;
    expect(ids(store)).toEqual(['msg_stored']);
  });

  it('never drops the row between the ack and the echo (outboxSent lands first)', async () => {
    const client = new FakeChatClient();
    let settle!: (value: unknown) => void;
    client.sendBehaviour = () => new Promise((resolve) => (settle = resolve));
    const store = await started(client);
    const counts: number[] = [];
    store.subscribe(() => counts.push(store.getSnapshot().messages.length));

    const sending = store.send('hi');
    // The ack arrives before any fan-out echo.
    settle(message('msg_acked', { text: 'hi', senderId: 'alice', clientMessageId: 'cm_1' }));
    await sending;

    expect(ids(store)).toEqual(['msg_acked']);
    expect(counts).not.toContain(0);
  });

  it('resolves undefined for a send the connection dropped, and keeps it visible as pending', async () => {
    const client = new FakeChatClient();
    client.sendBehaviour = async () => {
      throw Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED', queued: true });
    };
    const store = await started(client);

    await expect(store.send('offline')).resolves.toBeUndefined();
    expect(store.getSnapshot().messages[0]).toMatchObject({ text: 'offline', localStatus: 'pending' });
  });

  it('rejects a refused send but keeps it as failed, and retry() sends it again', async () => {
    const client = new FakeChatClient();
    client.sendBehaviour = async () => {
      throw Object.assign(new Error('muted'), { code: 'MUTED' });
    };
    const store = await started(client);

    await expect(store.send('nope')).rejects.toMatchObject({ code: 'MUTED' });
    const failed = store.getSnapshot().messages[0];
    expect(failed).toMatchObject({ localStatus: 'failed', localError: { code: 'MUTED' } });

    await store.retry(failed.clientMessageId!);
    expect(client.outbox.retry).toHaveBeenCalledWith('cm_1');
    expect(store.getSnapshot().messages).toEqual([expect.objectContaining({ id: 'msg_cm_1', text: 'nope' })]);
    expect(store.getSnapshot().messages[0].localStatus).toBeUndefined();
  });

  it('cancel() drops a queued send from the list', async () => {
    const client = new FakeChatClient();
    client.outboxEntries = [
      {
        clientMessageId: 'cm_q',
        room: 'conv_1',
        userId: 'alice',
        text: 'queued',
        createdAt: 'x',
        status: 'pending',
        attempts: 1,
      },
    ];
    const store = await started(client);
    expect(ids(store)).toEqual(['cm_q']);

    await expect(store.cancel('cm_q')).resolves.toBe(true);
    expect(ids(store)).toEqual([]);
  });

  it('keeps unsent messages after stored ones, however old they are', async () => {
    const client = new FakeChatClient();
    client.outboxEntries = [
      {
        clientMessageId: 'cm_old',
        room: 'conv_1',
        userId: 'alice',
        text: 'q',
        createdAt: '2020-01-01T00:00:00.000Z',
        status: 'pending',
        attempts: 0,
      },
    ];
    client.pages = [{ data: [message('m1', { seq: '1' })], nextCursor: null, hasMore: false }];
    const store = await started(client);

    expect(ids(store)).toEqual(['m1', 'cm_old']);
  });

  it('folds in a link preview delivered as a messageUpdated', async () => {
    const client = new FakeChatClient();
    client.pages = [{ data: [message('m1')], nextCursor: null, hasMore: false }];
    const store = await started(client);

    const preview = { url: 'https://example.com', title: 'Example' };
    client.emit('messageUpdated', message('m1', { linkPreview: preview }), { reason: 'link_preview' });

    expect(store.getSnapshot().messages[0].linkPreview).toEqual(preview);
  });

  it('keeps deletes as tombstones and applies reactions and pins', async () => {
    const client = new FakeChatClient();
    client.pages = [{ data: [message('m2'), message('m1')], nextCursor: null, hasMore: false }];
    const store = await started(client);

    client.emit('reactionAdded', { messageId: 'm1', roomId: 'conv_1', userId: 'bob', emoji: '👍', at: 'now' });
    client.emit('messagePinned', { messageId: 'm1', roomId: 'conv_1', message: null, by: 'mod', at: 'now' });
    client.emit('messageDeleted', { messageId: 'm2', roomId: 'conv_1', deletedAt: 'now', deletedBy: 'bob' });

    const [first, second] = store.getSnapshot().messages;
    expect(first.reactions).toEqual([{ emoji: '👍', count: 1, userIds: ['bob'] }]);
    expect(first.pinned).toBe(true);
    expect(store.getSnapshot().pinned).toEqual(['m1']);
    expect(second).toMatchObject({ id: 'm2', deleted: true, text: null });
  });

  it('replaces everything it holds on resync, since the event log could not say what changed', async () => {
    const client = new FakeChatClient();
    client.pages = [{ data: [message('old2'), message('old1')], nextCursor: 'C', hasMore: true }];
    const store = await started(client);

    client.emit('resync', {
      roomId: 'conv_1',
      page: { data: [message('new2'), message('new1')], nextCursor: null, previousCursor: null, hasMore: false },
    });

    expect(ids(store)).toEqual(['new1', 'new2']);
    expect(store.getSnapshot().hasMore).toBe(false);
  });

  it('pages older history onto the front, and stops when it runs out', async () => {
    const client = new FakeChatClient();
    client.pages = [
      { data: [message('m4', { seq: '4' }), message('m3', { seq: '3' })], nextCursor: 'C1', hasMore: true },
      { data: [message('m2', { seq: '2' }), message('m1', { seq: '1' })], nextCursor: null, hasMore: false },
    ];
    const store = await started(client);

    await store.loadOlder();
    expect(ids(store)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(client.listed[1]).toMatchObject({ before: 'C1', limit: 2 });
    expect(store.getSnapshot().hasMore).toBe(false);

    const calls = client.listed.length;
    await store.loadOlder();
    expect(client.listed.length).toBe(calls);
  });

  it('ignores events for other rooms, and matches the conv id when the room was given by name', async () => {
    const client = new FakeChatClient();
    client.pages = [{ data: [message('m1', { roomId: 'conv_9' })], nextCursor: null, hasMore: false }];
    const store = await started(client, 'support');

    client.emit('message', message('elsewhere', { roomId: 'conv_other' }));
    client.emit('message', message('here', { roomId: 'conv_9', createdAt: '2026-01-02T00:00:00.000Z' }));

    expect(ids(store)).toEqual(['m1', 'here']);
  });

  it('markRead marks the newest stored message, and is skipped for an audience viewer', async () => {
    const client = new FakeChatClient();
    client.pages = [{ data: [message('m2'), message('m1')], nextCursor: null, hasMore: false }];
    const store = await started(client);

    await store.markRead();
    expect(client.marked).toEqual(['m2']);

    client.isAudienceViewer = true;
    await store.markRead();
    expect(client.marked).toEqual(['m2']);
  });

  it('stops listening on stop()', async () => {
    const client = new FakeChatClient();
    const store = await started(client);
    store.stop();
    client.emit('message', message('late'));
    expect(ids(store)).toEqual([]);
  });
});
