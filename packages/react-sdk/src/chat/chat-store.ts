import {
  createChatClient,
  type ChatClient,
  type ChatClientConfig,
  type ChatConnectionState,
  type ChatMessage,
  type PresenceStatus,
  type SwalvoChatError,
  type ReadState,
} from '@swalvo/chat';

export interface SwalvoChatSnapshot {
  connectionState: ChatConnectionState;
  client?: ChatClient;
  /** Oldest-first, the order a message list renders in. */
  messages: ChatMessage[];
  /** userId -> presence status, for whoever's around. */
  presence: Record<string, PresenceStatus>;
  /**
   * The server's `presence.count` for this room (§6), sent instead of
   * per-member presence frames once a room is large. `null` until one
   * arrives; count `presence` yourself until then (`usePresenceCount` does).
   */
  presenceCount: number | null;
  /** userIds currently typing, excluding this user. */
  typing: string[];
  /** userId -> the message id they have read up to. */
  readReceipts: Record<string, string | null>;
  /** True while the first page of history is loading. */
  loadingHistory: boolean;
  /** Cursor for the next older page. Null once history runs out. */
  nextCursor: string | null;
  hasMoreHistory: boolean;
  error?: SwalvoChatError;
  userId?: string;
}

const INITIAL_SNAPSHOT: SwalvoChatSnapshot = {
  connectionState: 'idle',
  messages: [],
  presence: {},
  presenceCount: null,
  typing: [],
  readReceipts: {},
  loadingHistory: false,
  nextCursor: null,
  hasMoreHistory: false,
};

/**
 * Owns one `ChatClient` and turns its event stream into immutable snapshots
 * for `useSyncExternalStore`. Every hook in this package reads a single
 * slice, so a new message doesn't re-render a component that only cares
 * about typing indicators (spec §59, "avoid unnecessary SDK rerenders").
 *
 * Same shape as `SwalvoStore` on the RTC side, and that's on purpose:
 * anyone using both learns one pattern instead of two (spec §43, extend
 * the existing React ecosystem, not building a parallel one).
 *
 * The actual chat logic all lives in `@swalvo/chat`. This class only
 * translates. It never touches a WebSocket.
 */
export class SwalvoChatStore {
  private snapshot: SwalvoChatSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  private client?: ChatClient;
  private room?: string;
  /** Local timers that expire a stale "typing" even when the stop event never turns up. */
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  getSnapshot = (): SwalvoChatSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private patch(partial: Partial<SwalvoChatSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) listener();
  }

  init(config: ChatClientConfig): void {
    this.client = createChatClient(config);
    this.patch({ client: this.client, userId: this.client.userId });
  }

  async connect(room: string, historyLimit = 50): Promise<void> {
    if (!this.client) {
      throw new Error('SwalvoChatStore.init() must be called before connect()');
    }
    this.room = room;
    this.attach(this.client);
    this.patch({ connectionState: 'connecting', error: undefined });

    try {
      await this.client.connect({ room });
    } catch (error) {
      this.patch({ connectionState: 'failed', error: error as SwalvoChatError });
      throw error;
    }

    await this.loadInitialHistory(historyLimit);
    await this.hydrateEphemeralState();
  }

  async disconnect(): Promise<void> {
    await this.client?.disconnect();
    this.detach();
    this.patch({
      ...INITIAL_SNAPSHOT,
      connectionState: 'disconnected',
      client: this.client,
      userId: this.client?.userId,
    });
  }

  /** Call this on unmount. Detaches every listener and closes the socket. */
  dispose(): void {
    this.detach();
    void this.client?.disconnect();
  }

  /**
   * Wires an already-connected `ChatClient` into this store's reactive
   * machinery without calling `client.connect()`.
   *
   * For a caller (Live Streaming) that got hold of the client some other
   * way and still wants every existing hook, `useMessages`,
   * `useReactions` and the rest, to work against it.
   */
  async attachExisting(client: ChatClient, room: string, historyLimit = 50): Promise<void> {
    this.client = client;
    this.room = room;
    this.attach(client);
    this.patch({ client, userId: client.userId, connectionState: client.connectionState });

    await this.loadInitialHistory(historyLimit);
    await this.hydrateEphemeralState();
  }

  /**
   * Adopts a client the app created and connected itself, with no room of
   * its own: the store only relays events, and the per-room hooks
   * (`useConversation`, `useTyping(room)`…) do the rest. Used by
   * `<ChatProvider client={…}>`. Pair with `detachExisting()`.
   */
  adopt(client: ChatClient): void {
    this.client = client;
    this.attach(client);
    this.patch({ client, userId: client.userId, connectionState: client.connectionState });
  }

  /**
   * `attachExisting()`'s counterpart to `dispose()`. Unsubscribes from
   * client events and never calls `client.disconnect()`.
   *
   * For a caller (Live Streaming) whose own `leave()` already tears the
   * connection down. Do both and you disconnect it twice.
   */
  detachExisting(): void {
    this.detach();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  send = async (text: string, options: { replyTo?: string } = {}): Promise<void> => {
    if (!this.client) return;
    // No optimistic insert. The server's fan-out echoes the message back
    // with its canonical id and timestamp, and rendering a local
    // placeholder first means reconciling two versions of the same
    // message. All to save a few milliseconds.
    await this.client.sendMessage({ text, replyTo: options.replyTo, room: this.room });
  };

  loadMore = async (limit = 50): Promise<void> => {
    if (!this.client || !this.snapshot.nextCursor || this.snapshot.loadingHistory) {
      return;
    }
    this.patch({ loadingHistory: true });
    try {
      const page = await this.client.messages.list({
        room: this.room,
        limit,
        before: this.snapshot.nextCursor,
      });
      // Older messages go on the front. The server returns newest-first.
      this.patch({
        messages: [...[...page.data].reverse(), ...this.snapshot.messages],
        nextCursor: page.nextCursor,
        hasMoreHistory: page.hasMore,
        loadingHistory: false,
      });
    } catch (error) {
      this.patch({ loadingHistory: false, error: error as SwalvoChatError });
    }
  };

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private attach(client: ChatClient): void {
    this.detach();

    this.unsubscribers = [
      client.on('connectionStateChanged', (state) => this.patch({ connectionState: state })),
      client.on('error', (error) => this.patch({ error })),

      client.on('message', (message) => {
        // Guard against a duplicate turning up when a reconnect replays
        // something we already hold.
        if (this.snapshot.messages.some((m) => m.id === message.id)) return;
        this.patch({ messages: [...this.snapshot.messages, message] });
      }),

      client.on('messageUpdated', (message) =>
        this.patch({
          messages: this.snapshot.messages.map((m) => (m.id === message.id ? message : m)),
        }),
      ),

      client.on('messageDeleted', (event) =>
        this.patch({
          // Keep the row as a tombstone so the list doesn't jump. The
          // server's soft delete is what makes that possible.
          messages: this.snapshot.messages.map((m) =>
            m.id === event.messageId
              ? { ...m, deleted: true, text: null, deletedAt: event.deletedAt, attachment: null, reactions: [] }
              : m,
          ),
        }),
      ),

      client.on('reactionAdded', (event) => this.applyReaction(event, 'add')),
      client.on('reactionRemoved', (event) => this.applyReaction(event, 'remove')),

      client.on('presence', (event) =>
        this.patch({ presence: { ...this.snapshot.presence, [event.userId]: event.status } }),
      ),

      client.on('typing', (event) => this.applyTyping(event.userId, event.isTyping)),

      client.on('presenceCount', (event) => {
        if (
          this.room === undefined ||
          event.roomId === this.room ||
          this.snapshot.messages[0]?.roomId === event.roomId
        ) {
          this.patch({ presenceCount: event.online });
        }
      }),

      client.on('read', (event) =>
        this.patch({ readReceipts: { ...this.snapshot.readReceipts, [event.userId]: event.messageId } }),
      ),

      client.on('reconnected', () => {
        // Messages are not fetched here. @swalvo/chat replays whatever
        // arrived while the socket was down and emits it through the same
        // `message` event, de-duplicated and in order — this store used to
        // do its own single-page catch-up, which silently truncated an
        // outage longer than 100 messages and hand-rolled the cursor
        // format besides.
        //
        // What does need refreshing is the state the SDK deliberately does
        // *not* replay: presence and read receipts are ephemeral or durable
        // rather than replayable, so re-read them as they are now.
        void this.hydrateEphemeralState();
      }),
    ];
  }

  private detach(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
  }

  private applyReaction(event: { messageId: string; userId: string; emoji: string }, action: 'add' | 'remove'): void {
    this.patch({
      messages: this.snapshot.messages.map((message) => {
        if (message.id !== event.messageId) return message;

        const reactions = message.reactions.filter((r) => r.emoji !== event.emoji);
        const existing = message.reactions.find((r) => r.emoji === event.emoji);
        const userIds = new Set(existing?.userIds ?? []);

        if (action === 'add') userIds.add(event.userId);
        else userIds.delete(event.userId);

        if (userIds.size > 0) {
          reactions.push({ emoji: event.emoji, count: userIds.size, userIds: Array.from(userIds) });
        }
        return { ...message, reactions };
      }),
    });
  }

  /**
   * Tracks who's typing, with a local expiry. The server does TTL typing
   * state, but a `typing.stopped` frame can go missing on a flaky
   * connection, and without this "Alice is typing…" sits on screen forever
   * (spec §21).
   */
  private applyTyping(userId: string, isTyping: boolean): void {
    if (userId === this.snapshot.userId) return;

    const existing = this.typingTimers.get(userId);
    if (existing) {
      clearTimeout(existing);
      this.typingTimers.delete(userId);
    }

    if (!isTyping) {
      this.patch({ typing: this.snapshot.typing.filter((id) => id !== userId) });
      return;
    }

    if (!this.snapshot.typing.includes(userId)) {
      this.patch({ typing: [...this.snapshot.typing, userId] });
    }
    this.typingTimers.set(
      userId,
      setTimeout(() => {
        this.typingTimers.delete(userId);
        this.patch({ typing: this.snapshot.typing.filter((id) => id !== userId) });
      }, 8_000),
    );
  }

  private async loadInitialHistory(limit: number): Promise<void> {
    if (!this.client) return;
    this.patch({ loadingHistory: true });
    try {
      const page = await this.client.messages.list({ room: this.room, limit });
      this.patch({
        // Reversed to oldest-first, which is render order. Do it here and
        // no consumer has to.
        messages: [...page.data].reverse(),
        nextCursor: page.nextCursor,
        hasMoreHistory: page.hasMore,
        loadingHistory: false,
      });
    } catch (error) {
      this.patch({ loadingHistory: false, error: error as SwalvoChatError });
    }
  }

  private async hydrateEphemeralState(): Promise<void> {
    if (!this.client) return;
    try {
      const [present, receipts] = await Promise.all([
        this.client.getPresence(this.room),
        this.client.getReadReceipts(this.room).catch(() => [] as ReadState[]),
      ]);
      this.patch({
        presence: Object.fromEntries(present.map((entry) => [entry.userId, entry.status])),
        readReceipts: Object.fromEntries(receipts.map((r) => [r.userId, r.lastReadMessageId])),
      });
    } catch {
      // Presence is a nice-to-have. Failing to hydrate it mustn't take the
      // connection down with it.
    }
  }
}
