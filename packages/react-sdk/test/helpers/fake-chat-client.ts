import { Inbox, ModerationApi, type InboxPage, type OutboxEntry } from '@swalvo/chat';

/**
 * A `ChatClient` stand-in for the Phase 3 hooks and UI kit.
 *
 * The inbox and the moderation state are the real `@swalvo/chat`
 * classes wired to fakes, so the hooks are tested against the behaviour
 * they will actually see; the socket, REST and outbox transport are fakes
 * a test drives by hand.
 */
export class FakeChatClient {
  readonly userId = 'alice';
  connectionState = 'connected';
  isAudienceViewer = false;
  rooms: string[] = [];
  readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly sent: Array<Record<string, unknown>> = [];
  readonly joined: string[] = [];
  readonly marked: string[] = [];
  /** Pages `messages.list` returns, consumed in order; the last one repeats. */
  pages: Array<{ data: unknown[]; nextCursor: string | null; hasMore: boolean; previousCursor?: string | null }> = [
    { data: [], nextCursor: null, hasMore: false },
  ];
  readonly listed: Array<Record<string, unknown>> = [];
  inboxPages: InboxPage[] = [{ conversations: [], nextCursor: null }];
  outboxEntries: OutboxEntry[] = [];
  /** How the next sendMessage settles. Default: resolves with a stored copy. */
  sendBehaviour: (options: Record<string, unknown>, entry: OutboxEntry) => Promise<unknown> = async (options, entry) =>
    message(`msg_${entry.clientMessageId}`, { text: options.text, clientMessageId: entry.clientMessageId });
  readonly moderationRequests: Array<{ type: string; payload: Record<string, unknown> }> = [];
  readonly restCalls: Array<{ path: string; options?: unknown }> = [];

  readonly messages = {
    list: async (options: Record<string, unknown>) => {
      this.listed.push(options);
      return this.pages.length > 1 ? this.pages.shift()! : this.pages[0];
    },
    threadPage: async (_id: string, options: Record<string, unknown>) => {
      this.listed.push({ thread: _id, ...options });
      return this.pages.length > 1 ? this.pages.shift()! : this.pages[0];
    },
  };

  readonly attachments = {
    upload: jest.fn(async (file: { name: string }) => ({ id: 'att_1', filename: file.name })),
  };

  readonly outbox = {
    list: (room?: string) => this.outboxEntries.filter((entry) => room === undefined || entry.room === room),
    retry: jest.fn(async (id: string) => {
      const entry = this.outboxEntries.find((candidate) => candidate.clientMessageId === id)!;
      this.outboxEntries = this.outboxEntries.filter((candidate) => candidate !== entry);
      this.emit('outboxChanged', this.outboxEntries);
      return message(`msg_${id}`, { text: entry.text, clientMessageId: id });
    }),
    cancel: jest.fn(async (id: string) => {
      this.outboxEntries = this.outboxEntries.filter((candidate) => candidate.clientMessageId !== id);
      this.emit('outboxChanged', this.outboxEntries);
      return true;
    }),
  };

  readonly inbox: Inbox;
  readonly moderation: ModerationApi;

  constructor() {
    this.inbox = new Inbox({
      query: async () => (this.inboxPages.length > 1 ? this.inboxPages.shift()! : this.inboxPages[0]),
      userId: () => this.userId,
      joinRoom: async (room) => {
        this.joined.push(room);
      },
      listen: (handlers) => {
        const offs = [
          this.on('message', handlers.message as never),
          this.on('read', handlers.read as never),
          this.on('removedFromRoom', ((event: { roomId: string }) => handlers.removed(event.roomId)) as never),
          this.on('reconnected', handlers.reconnected as never),
        ];
        return () => offs.forEach((off) => off());
      },
      logger: { error() {}, warn() {}, info() {}, debug() {} },
    });
    const rest = {
      request: async (path: string, options?: unknown) => {
        this.restCalls.push({ path, options });
        return [];
      },
    };
    this.moderation = new ModerationApi(
      rest as never,
      () => 'conv_1',
      async (type, payload) => {
        this.moderationRequests.push({ type, payload });
        return {};
      },
    );
  }

  on(event: string, handler: (...args: never[]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (...args: unknown[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(handler as (...args: unknown[]) => void);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of Array.from(this.handlers.get(event) ?? [])) handler(...args);
  }

  /** Emits a member.* event the way ChatClient does: folding it into moderation state first when it is about us. */
  emitModeration(kind: 'banned' | 'unbanned' | 'muted' | 'unmuted', event: Record<string, unknown>): void {
    const full = { roomId: 'conv_1', by: 'mod', expiresAt: null, ...event } as never;
    if ((event.userId as string) === this.userId) this.moderation.observe(kind, full);
    const name = { banned: 'memberBanned', unbanned: 'memberUnbanned', muted: 'memberMuted', unmuted: 'memberUnmuted' }[
      kind
    ];
    this.emit(name, full);
  }

  async joinRoom(room: string): Promise<void> {
    this.joined.push(room);
    this.rooms.push(room);
  }

  /** Mirrors the real outbox flow: queued (sending) synchronously, removed once settled. */
  sendMessage(options: Record<string, unknown>): Promise<unknown> {
    this.sent.push(options);
    const entry: OutboxEntry = {
      clientMessageId: (options.clientMessageId as string) ?? `cm_${this.sent.length}`,
      room: options.room as string,
      userId: this.userId,
      text: options.text as string | undefined,
      mentions: options.mentions as string[] | undefined,
      createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, this.sent.length)).toISOString(),
      status: 'sending',
      attempts: 1,
    };
    this.outboxEntries = [...this.outboxEntries, entry];
    this.emit('outboxChanged', this.outboxEntries);
    return this.sendBehaviour(options, entry).then(
      (result) => {
        // Same order as the real outbox: the stored message first, then the removal.
        this.emit('outboxSent', { clientMessageId: entry.clientMessageId, room: entry.room, message: result });
        this.outboxEntries = this.outboxEntries.filter((candidate) => candidate !== entry);
        this.emit('outboxChanged', this.outboxEntries);
        return result;
      },
      (error: { queued?: boolean; code?: string; message?: string }) => {
        this.outboxEntries = this.outboxEntries.map((candidate) =>
          candidate === entry
            ? {
                ...entry,
                status: error.queued ? 'pending' : 'failed',
                error: { code: error.code as never, message: error.message ?? '' },
              }
            : candidate,
        );
        this.emit('outboxChanged', this.outboxEntries);
        throw error;
      },
    );
  }

  async markAsRead(messageId: string): Promise<unknown> {
    this.marked.push(messageId);
    return {};
  }
  async getPresence(): Promise<unknown[]> {
    return [];
  }
  async startTyping(): Promise<void> {}
  async stopTyping(): Promise<void> {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
}

export function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    cursor: `c_${id}`,
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
    mentions: [],
    linkPreview: null,
    edited: false,
    deleted: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function inboxRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Room ${id}`,
    type: 'CHANNEL',
    metadata: {},
    role: 'MEMBER',
    muted: false,
    lastMessage: {
      id: `last_${id}`,
      seq: '10',
      senderId: 'bob',
      content: 'hello',
      type: 'TEXT',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    unreadCount: 0,
    unreadMentions: 0,
    lastReadSeq: '10',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as never;
}
