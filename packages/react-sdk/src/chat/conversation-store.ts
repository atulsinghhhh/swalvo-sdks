import {
  compareSeq,
  type ChatClient,
  type ChatMessage,
  type OutboxEntry,
  type OutboxStatus,
  type PresenceStatus,
  type SwalvoChatError,
  type ReactionEvent,
  type SendMessageOptions,
  type SendMessageResult,
} from '@swalvo/chat';

/**
 * A message as a conversation view renders it: a stored message, or one
 * still in the outbox.
 *
 * Outbox entries are shown as messages so the person who typed one sees it
 * at once, in place, instead of after a round trip. They are recognisable
 * by `localStatus`, and their `id` is their `clientMessageId` until the
 * server's echo replaces them with the stored row.
 */
export type ConversationMessage = ChatMessage & {
  /** Set only on a message that has not been stored yet. */
  localStatus?: OutboxStatus;
  /** Why a `failed` (or a network-bounced `pending`) send did not go through. */
  localError?: OutboxEntry['error'];
  /** True while this message is pinned in the conversation. */
  pinned?: boolean;
};

export interface ConversationSnapshot {
  /** Oldest first: stored messages in `seq` order, then unsent ones in the order they were typed. */
  messages: ConversationMessage[];
  /** True while the first page or an older page is loading. */
  loading: boolean;
  /** True when `loadOlder()` would fetch another page. */
  hasMore: boolean;
  error?: SwalvoChatError;
  /** userIds typing in this room, excluding this user. */
  typing: string[];
  /** userId -> status, for this room. */
  presence: Record<string, PresenceStatus>;
  /** The server's `presence.count` (§6) for a large room. `null` until one arrives. */
  presenceCount: number | null;
  /** Ids of the messages pinned in this room, as far as this view has seen. */
  pinned: string[];
}

export type ConversationSendInput = string | Omit<SendMessageOptions, 'room'>;

const INITIAL: ConversationSnapshot = {
  messages: [],
  loading: false,
  hasMore: false,
  typing: [],
  presence: {},
  presenceCount: null,
  pinned: [],
};

/** How long a "typing" indicator survives without a stop or a refresh. Matches SwalvoChatStore. */
const TYPING_TTL_MS = 8_000;

/**
 * One conversation's messages, for one view, kept current.
 *
 * Owns no connection: it reads a `ChatClient` that somebody else connected
 * and joins `room` on it if nobody has. The client already delivers each
 * message once and in order, recovers what a reconnect missed, and keeps
 * the outbox; this class only turns that into one immutable, render-ordered
 * list for `useSyncExternalStore`.
 *
 * ## Ordering
 *
 * By `seq` (§1) whenever both messages carry one, which is the server's own
 * per-conversation order, then by `createdAt` and `id`. Unsent messages
 * always sort after stored ones: they have no position yet, and showing
 * them anywhere but the bottom would make them jump when they get one.
 *
 * ## Room identity
 *
 * `room` may be a name or an attached RTC room id; events carry the
 * conversation's `conv_…` id. The store learns that id from the first page
 * of history (or from a message it sent) and matches events on either.
 */
export class ConversationStore {
  private snapshot: ConversationSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  /** Stored messages by id. */
  private readonly stored = new Map<string, ConversationMessage>();
  private outboxEntries: OutboxEntry[] = [];
  private conversationId?: string;
  private nextCursor: string | null = null;
  private started = false;
  private readonly pinnedIds = new Set<string>();
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly client: ChatClient,
    readonly room: string,
    private readonly options: { pageSize?: number } = {},
  ) {}

  getSnapshot = (): ConversationSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Joins the room if needed, loads the newest page, and starts following it. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.attach();
    this.outboxEntries = this.client.outbox?.list(this.room) ?? [];
    this.rebuild();

    if (!this.client.rooms.includes(this.room)) {
      try {
        await this.client.joinRoom(this.room);
      } catch (error) {
        this.patch({ error: error as SwalvoChatError });
      }
    }
    await this.loadNewest();
    void this.hydratePresence();
  }

  /** Stops following the room. The client stays connected and the room stays joined. */
  stop(): void {
    this.started = false;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
  }

  /** The next older page, prepended. A no-op while loading or once history runs out. */
  loadOlder = async (): Promise<void> => {
    if (!this.nextCursor || this.snapshot.loading) return;
    this.patch({ loading: true });
    try {
      const page = await this.client.messages.list({
        room: this.room,
        limit: this.options.pageSize ?? 50,
        before: this.nextCursor,
      });
      for (const message of page.data) this.upsert(message, false);
      this.nextCursor = page.nextCursor;
      this.rebuild({ loading: false, hasMore: page.hasMore && page.nextCursor !== null });
    } catch (error) {
      this.patch({ loading: false, error: error as SwalvoChatError });
    }
  };

  /**
   * Sends to this room. The message shows at once as `localStatus:
   * 'sending'` (from the outbox) and is replaced in place by the stored row.
   *
   * A send the connection dropped resolves `undefined` rather than
   * rejecting: it is still queued, the list shows it as `pending`, and it
   * goes out on reconnect. A send the server refused (muted, slow mode…)
   * rejects, and also stays in the list as `failed` for retry or cancel.
   */
  send = async (input: ConversationSendInput): Promise<SendMessageResult | undefined> => {
    const options = typeof input === 'string' ? { text: input } : input;
    try {
      const result = await this.client.sendMessage({ ...options, room: this.room });
      this.upsert(result, true);
      return result;
    } catch (error) {
      if ((error as SwalvoChatError)?.queued) return undefined;
      throw error;
    }
  };

  retry = async (clientMessageId: string): Promise<SendMessageResult | undefined> => {
    if (!this.client.outbox) return undefined;
    try {
      const result = await this.client.outbox.retry(clientMessageId);
      this.upsert(result, true);
      return result;
    } catch (error) {
      if ((error as SwalvoChatError)?.queued) return undefined;
      throw error;
    }
  };

  cancel = async (clientMessageId: string): Promise<boolean> => {
    return (await this.client.outbox?.cancel(clientMessageId)) ?? false;
  };

  /** Marks the newest stored message read. Skipped for audience viewers, who have no read state (§6). */
  markRead = async (): Promise<void> => {
    if (this.client.isAudienceViewer) return;
    const newest = [...this.snapshot.messages].reverse().find((message) => !message.localStatus);
    if (!newest) return;
    await this.client.markAsRead(newest.id).catch(() => undefined);
  };

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private attach(): void {
    const client = this.client;
    this.unsubscribers = [
      client.on('message', (message) => {
        if (!this.mine(message.roomId)) return;
        this.upsert(message, true);
      }),
      client.on('messageUpdated', (message) => {
        if (!this.mine(message.roomId) || !this.stored.has(message.id)) return;
        this.upsert(message, true);
      }),
      client.on('messageDeleted', (event) => {
        if (!this.mine(event.roomId)) return;
        const existing = this.stored.get(event.messageId);
        if (!existing) return;
        // A tombstone keeps the row, so the list does not jump.
        this.stored.set(event.messageId, {
          ...existing,
          deleted: true,
          deletedAt: event.deletedAt,
          text: null,
          attachment: null,
          reactions: [],
          linkPreview: null,
        });
        this.rebuild();
      }),
      client.on('reactionAdded', (event) => this.applyReaction(event, 'add')),
      client.on('reactionRemoved', (event) => this.applyReaction(event, 'remove')),
      client.on('messagePinned', (event) => {
        if (!this.mine(event.roomId)) return;
        this.pinnedIds.add(event.messageId);
        this.rebuild();
      }),
      client.on('messageUnpinned', (event) => {
        if (!this.mine(event.roomId)) return;
        this.pinnedIds.delete(event.messageId);
        this.rebuild();
      }),
      client.on('resync', (event) => {
        if (!this.mine(event.roomId)) return;
        // The event log could not say what changed, so nothing held here
        // can be trusted. Start again from the page the SDK re-read.
        this.stored.clear();
        for (const message of event.page.data) this.upsert(message, false);
        this.nextCursor = event.page.nextCursor;
        this.rebuild({ hasMore: event.page.hasMore && event.page.nextCursor !== null });
      }),
      // The stored message arrives here just before its outbox entry is
      // dropped, so the optimistic row is swapped for the real one in one
      // rebuild rather than vanishing for a tick until the echo lands.
      client.on('outboxSent', (event) => {
        if (event.room !== this.room && !this.mine(event.room)) return;
        if (event.message && typeof event.message.id === 'string' && event.message.createdAt) {
          this.upsert({ ...event.message, roomId: event.message.roomId ?? this.room }, true);
        }
      }),
      client.on('outboxChanged', (entries) => {
        this.outboxEntries = entries.filter((entry) => entry.room === this.room || this.mine(entry.room));
        this.rebuild();
      }),
      client.on('typing', (event) => {
        if (!this.mine(event.roomId)) return;
        this.applyTyping(event.userId, event.isTyping);
      }),
      client.on('presence', (event) => {
        if (!this.mine(event.roomId)) return;
        this.patch({ presence: { ...this.snapshot.presence, [event.userId]: event.status } });
      }),
      client.on('presenceCount', (event) => {
        if (!this.mine(event.roomId)) return;
        this.patch({ presenceCount: event.online });
      }),
    ];
  }

  private async loadNewest(): Promise<void> {
    this.patch({ loading: true, error: undefined });
    try {
      const page = await this.client.messages.list({ room: this.room, limit: this.options.pageSize ?? 50 });
      const first = page.data[0];
      if (first?.roomId) this.conversationId = first.roomId;
      for (const message of page.data) this.upsert(message, false);
      this.nextCursor = page.nextCursor;
      this.rebuild({ loading: false, hasMore: page.hasMore && page.nextCursor !== null });
    } catch (error) {
      this.patch({ loading: false, error: error as SwalvoChatError });
    }
  }

  private async hydratePresence(): Promise<void> {
    try {
      const present = await this.client.getPresence(this.room);
      this.patch({
        presence: {
          ...Object.fromEntries(present.map((entry) => [entry.userId, entry.status])),
          ...this.snapshot.presence,
        },
      });
    } catch {
      // Presence is a nice-to-have; a room without it still renders.
    }
  }

  /** Whether an event's room id is this view's room. */
  private mine(roomId: string | undefined): boolean {
    if (!roomId) return false;
    return roomId === this.room || roomId === this.conversationId;
  }

  private upsert(message: ChatMessage, rebuild: boolean): void {
    if (!message?.id) return;
    if (!this.conversationId && message.roomId) this.conversationId = message.roomId;
    const existing = this.stored.get(message.id);
    // An edit or a link-preview re-delivery replaces the row; a duplicate
    // (an ack and its fan-out echo) is the same row again, harmlessly.
    this.stored.set(message.id, { ...existing, ...message, localStatus: undefined, localError: undefined });
    if (rebuild) this.rebuild();
  }

  private applyReaction(event: ReactionEvent, action: 'add' | 'remove'): void {
    if (!this.mine(event.roomId)) return;
    const message = this.stored.get(event.messageId);
    if (!message) return;
    const reactions = message.reactions.filter((r) => r.emoji !== event.emoji);
    const userIds = new Set(message.reactions.find((r) => r.emoji === event.emoji)?.userIds ?? []);
    if (action === 'add') userIds.add(event.userId);
    else userIds.delete(event.userId);
    if (userIds.size > 0) reactions.push({ emoji: event.emoji, count: userIds.size, userIds: Array.from(userIds) });
    this.stored.set(message.id, { ...message, reactions });
    this.rebuild();
  }

  private applyTyping(userId: string, isTyping: boolean): void {
    if (userId === this.client.userId) return;
    const existing = this.typingTimers.get(userId);
    if (existing) clearTimeout(existing);
    this.typingTimers.delete(userId);
    if (!isTyping) {
      this.patch({ typing: this.snapshot.typing.filter((id) => id !== userId) });
      return;
    }
    if (!this.snapshot.typing.includes(userId)) this.patch({ typing: [...this.snapshot.typing, userId] });
    this.typingTimers.set(
      userId,
      setTimeout(() => {
        this.typingTimers.delete(userId);
        this.patch({ typing: this.snapshot.typing.filter((id) => id !== userId) });
      }, TYPING_TTL_MS),
    );
  }

  /** Recomputes the render list: stored messages in order, then unsent ones not yet echoed. */
  private rebuild(extra: Partial<ConversationSnapshot> = {}): void {
    const stored = Array.from(this.stored.values())
      .map((message) => {
        const pinned = this.pinnedIds.has(message.id);
        return message.pinned === pinned ? message : { ...message, pinned };
      })
      .sort(compareMessages);
    const echoed = new Set(stored.map((message) => message.clientMessageId).filter(Boolean));
    const local = this.outboxEntries
      .filter((entry) => !echoed.has(entry.clientMessageId))
      .map((entry) => this.toLocalMessage(entry));
    this.patch({ ...extra, messages: [...stored, ...local], pinned: Array.from(this.pinnedIds) });
  }

  private toLocalMessage(entry: OutboxEntry): ConversationMessage {
    return {
      id: entry.clientMessageId,
      cursor: '',
      roomId: this.conversationId ?? entry.room,
      conversationId: this.conversationId ?? entry.room,
      senderId: entry.userId,
      type: entry.type ?? (entry.attachmentId ? 'attachment' : 'text'),
      text: entry.text ?? null,
      replyTo: entry.replyTo ?? null,
      threadRootId: null,
      clientMessageId: entry.clientMessageId,
      metadata: entry.metadata ?? null,
      attachment: null,
      reactions: [],
      mentions: entry.mentions ?? [],
      linkPreview: null,
      edited: false,
      deleted: false,
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      editedAt: null,
      deletedAt: null,
      localStatus: entry.status,
      localError: entry.error,
    };
  }

  private patch(partial: Partial<ConversationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of Array.from(this.listeners)) listener();
  }
}

/** `seq` when both have one (the server's order), then `createdAt`, then `id`. */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.seq && b.seq) {
    const bySeq = compareSeq(a.seq, b.seq);
    if (bySeq !== 0) return bySeq;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

interface Registration {
  store: ConversationStore;
  refs: number;
  disposeTimer?: ReturnType<typeof setTimeout>;
}

const registry = new WeakMap<object, Map<string, Registration>>();

/**
 * One store per client and room, however many components render it: a
 * message list, a composer and an unread badge for the same room must not
 * each load history and each keep their own copy of the outbox.
 */
export function getConversationStore(
  client: ChatClient,
  room: string,
  options: { pageSize?: number } = {},
): ConversationStore {
  let rooms = registry.get(client);
  if (!rooms) {
    rooms = new Map();
    registry.set(client, rooms);
  }
  let registration = rooms.get(room);
  if (!registration) {
    registration = { store: new ConversationStore(client, room, options), refs: 0 };
    rooms.set(room, registration);
  }
  return registration.store;
}

/**
 * Takes a reference on a room's store, starting it on the first. The last
 * release stops it a tick later rather than at once, so React Strict Mode's
 * mount → unmount → mount does not tear down and reload the room.
 */
export function retainConversationStore(
  client: ChatClient,
  room: string,
  options: { pageSize?: number } = {},
): () => void {
  const store = getConversationStore(client, room, options);
  const registration = registry.get(client)!.get(room)!;
  if (registration.disposeTimer !== undefined) {
    clearTimeout(registration.disposeTimer);
    registration.disposeTimer = undefined;
  }
  registration.refs += 1;
  void store.start();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    registration.refs -= 1;
    if (registration.refs > 0) return;
    registration.disposeTimer = setTimeout(() => {
      registration.disposeTimer = undefined;
      if (registration.refs > 0) return;
      store.stop();
      registry.get(client)?.delete(room);
    }, 0);
  };
}
