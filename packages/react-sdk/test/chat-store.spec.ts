import { SwalvoChatStore } from '../src/chat/chat-store';

/**
 * Drives the store against a hand-rolled fake `ChatClient`.
 *
 * Which is rather the point of the store existing at all: the translation
 * from event stream to React snapshots is testable with no socket, no
 * server and no DOM.
 */
class FakeChatClient {
  readonly userId = 'alice';
  connectionState = 'connected';
  readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  readonly listed: unknown[] = [];
  page: { data: unknown[]; nextCursor: string | null; hasMore: boolean } = {
    data: [],
    nextCursor: null,
    hasMore: false,
  };

  readonly messages = {
    list: async (options: unknown) => {
      this.listed.push(options);
      return this.page;
    },
    addReaction: async () => ({ reactions: [] }),
    removeReaction: async () => ({ reactions: [] }),
  };

  on(event: string, handler: (payload: unknown) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  emit(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendMessage(): Promise<unknown> {
    return {};
  }
  async getPresence(): Promise<unknown[]> {
    return [{ userId: 'bob', status: 'online' }];
  }
  async getReadReceipts(): Promise<unknown[]> {
    return [{ userId: 'bob', lastReadMessageId: 'msg_1' }];
  }
  async markAsRead(): Promise<unknown> {
    return {};
  }
  async startTyping(): Promise<void> {}
  async stopTyping(): Promise<void> {}
}

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    roomId: 'conv_1',
    conversationId: 'conv_1',
    senderId: 'bob',
    type: 'text',
    text: `body ${id}`,
    replyTo: null,
    threadRootId: null,
    clientMessageId: null,
    metadata: null,
    attachment: null,
    reactions: [],
    edited: false,
    deleted: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/** Wires a store to a fake client, going round createChatClient. */
async function connectedStore(client: FakeChatClient) {
  const store = new SwalvoChatStore();
  (store as unknown as { client: unknown }).client = client;
  (store as unknown as { patch: (p: unknown) => void }).patch({ client, userId: client.userId });
  await store.connect('conv_1');
  return store;
}

describe('SwalvoChatStore', () => {
  it('loads history oldest-first, which is render order', async () => {
    const client = new FakeChatClient();
    // The API returns newest-first.
    client.page = { data: [message('msg_3'), message('msg_2'), message('msg_1')], nextCursor: 'C', hasMore: true };

    const store = await connectedStore(client);
    expect(store.getSnapshot().messages.map((m) => m.id)).toEqual(['msg_1', 'msg_2', 'msg_3']);
    expect(store.getSnapshot().hasMoreHistory).toBe(true);
  });

  it('appends live messages and ignores duplicates a reconnect might replay', async () => {
    const client = new FakeChatClient();
    const store = await connectedStore(client);

    client.emit('message', message('msg_1'));
    client.emit('message', message('msg_1'));
    client.emit('message', message('msg_2'));

    expect(store.getSnapshot().messages.map((m) => m.id)).toEqual(['msg_1', 'msg_2']);
  });

  it('replaces an edited message in place rather than reordering the list', async () => {
    const client = new FakeChatClient();
    const store = await connectedStore(client);

    client.emit('message', message('msg_1'));
    client.emit('message', message('msg_2'));
    client.emit('messageUpdated', message('msg_1', { text: 'Updated message', edited: true }));

    const messages = store.getSnapshot().messages;
    expect(messages.map((m) => m.id)).toEqual(['msg_1', 'msg_2']);
    expect(messages[0].text).toBe('Updated message');
    expect(messages[0].edited).toBe(true);
  });

  it('keeps a deleted message as a tombstone so the list does not jump', async () => {
    const client = new FakeChatClient();
    const store = await connectedStore(client);

    client.emit('message', message('msg_1'));
    client.emit('messageDeleted', { messageId: 'msg_1', roomId: 'conv_1', deletedAt: 'now', deletedBy: 'bob' });

    const deleted = store.getSnapshot().messages[0];
    expect(deleted.deleted).toBe(true);
    expect(deleted.text).toBeNull();
    expect(store.getSnapshot().messages).toHaveLength(1);
  });

  it('folds reactions into the message they belong to', async () => {
    const client = new FakeChatClient();
    const store = await connectedStore(client);
    client.emit('message', message('msg_1'));

    client.emit('reactionAdded', { messageId: 'msg_1', userId: 'bob', emoji: '👍', roomId: 'conv_1', at: 'now' });
    client.emit('reactionAdded', { messageId: 'msg_1', userId: 'carol', emoji: '👍', roomId: 'conv_1', at: 'now' });

    expect(store.getSnapshot().messages[0].reactions).toEqual([{ emoji: '👍', count: 2, userIds: ['bob', 'carol'] }]);

    client.emit('reactionRemoved', { messageId: 'msg_1', userId: 'bob', emoji: '👍', roomId: 'conv_1', at: 'now' });
    expect(store.getSnapshot().messages[0].reactions).toEqual([{ emoji: '👍', count: 1, userIds: ['carol'] }]);

    client.emit('reactionRemoved', { messageId: 'msg_1', userId: 'carol', emoji: '👍', roomId: 'conv_1', at: 'now' });
    expect(store.getSnapshot().messages[0].reactions).toEqual([]);
  });

  it('tracks presence as a map keyed by user', async () => {
    const client = new FakeChatClient();
    const store = await connectedStore(client);

    // Hydrated from getPresence() at connect time.
    expect(store.getSnapshot().presence).toEqual({ bob: 'online' });

    client.emit('presence', { userId: 'carol', roomId: 'conv_1', status: 'online', at: 'now' });
    client.emit('presence', { userId: 'bob', roomId: 'conv_1', status: 'offline', at: 'now' });

    expect(store.getSnapshot().presence).toEqual({ bob: 'offline', carol: 'online' });
  });

  it('expires a typing indicator locally even when the stop event never arrives', async () => {
    jest.useFakeTimers();
    try {
      const client = new FakeChatClient();
      const store = await connectedStore(client);

      client.emit('typing', { userId: 'bob', roomId: 'conv_1', isTyping: true });
      expect(store.getSnapshot().typing).toEqual(['bob']);

      // No typing.stopped ever arrives. A dropped frame mustn't leave
      // "Bob is typing…" on screen forever.
      jest.advanceTimersByTime(10_000);
      expect(store.getSnapshot().typing).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never shows the local user as typing to themselves', async () => {
    const client = new FakeChatClient();
    const store = await connectedStore(client);

    client.emit('typing', { userId: 'alice', roomId: 'conv_1', isTyping: true });
    expect(store.getSnapshot().typing).toEqual([]);
  });

  it('prepends older pages when loading more history', async () => {
    const client = new FakeChatClient();
    client.page = { data: [message('msg_5')], nextCursor: 'CURSOR', hasMore: true };
    const store = await connectedStore(client);

    client.page = { data: [message('msg_4'), message('msg_3')], nextCursor: null, hasMore: false };
    await store.loadMore();

    expect(store.getSnapshot().messages.map((m) => m.id)).toEqual(['msg_3', 'msg_4', 'msg_5']);
    expect(store.getSnapshot().hasMoreHistory).toBe(false);
  });

  it('does not fetch more once history is exhausted', async () => {
    const client = new FakeChatClient();
    const store = await connectedStore(client);
    const callsAfterConnect = client.listed.length;

    await store.loadMore();
    expect(client.listed.length).toBe(callsAfterConnect);
  });

  it('detaches every listener on dispose, so an unmounted component stops updating', async () => {
    const client = new FakeChatClient();
    const store = await connectedStore(client);

    store.dispose();
    client.emit('message', message('msg_after_dispose'));

    expect(store.getSnapshot().messages).toHaveLength(0);
  });

  it('notifies subscribers only through immutable snapshots', async () => {
    const client = new FakeChatClient();
    const store = await connectedStore(client);

    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));

    client.emit('message', message('msg_1'));
    client.emit('message', message('msg_2'));

    // Every notification has to carry a different object, or
    // useSyncExternalStore's Object.is check never fires a re-render.
    expect(seen[0]).not.toBe(seen[1]);
  });

  describe('attachExisting()', () => {
    it('wires an already-connected client without calling client.connect()', async () => {
      const client = new FakeChatClient();
      client.page = { data: [message('msg_1')], nextCursor: null, hasMore: false };
      const connectSpy = jest.spyOn(client, 'connect');
      const store = new SwalvoChatStore();

      await store.attachExisting(client as never, 'conv_1');

      expect(connectSpy).not.toHaveBeenCalled();
      expect(store.getSnapshot().client).toBe(client);
      expect(store.getSnapshot().userId).toBe('alice');
      expect(store.getSnapshot().connectionState).toBe('connected');
      expect(store.getSnapshot().messages.map((m) => m.id)).toEqual(['msg_1']);
    });

    it('reacts to events on the adopted client, same as a client from connect()', async () => {
      const client = new FakeChatClient();
      const store = new SwalvoChatStore();
      await store.attachExisting(client as never, 'conv_1');

      client.emit('message', message('msg_1'));

      expect(store.getSnapshot().messages.map((m) => m.id)).toEqual(['msg_1']);
    });
  });

  describe('detachExisting()', () => {
    it('unsubscribes from client events without calling client.disconnect()', async () => {
      const client = new FakeChatClient();
      const disconnectSpy = jest.spyOn(client, 'disconnect');
      const store = new SwalvoChatStore();
      await store.attachExisting(client as never, 'conv_1');

      store.detachExisting();
      client.emit('message', message('msg_after_detach'));

      expect(disconnectSpy).not.toHaveBeenCalled();
      expect(store.getSnapshot().messages).toHaveLength(0);
    });
  });
});
