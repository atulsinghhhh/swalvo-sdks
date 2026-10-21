import type { SwalvoChatError } from './errors';
import type { Unsubscribe } from './events';
import type { Logger } from './logger';
import { compareSeq } from './internal/seq';
import type {
  ChatMessage,
  InboxConversation,
  InboxPage,
  NotificationPreferences,
  QueryConversationsOptions,
  ReadState,
} from './types';

export interface InboxSnapshot {
  /** Newest activity first, the order an inbox renders in. */
  conversations: InboxConversation[];
  /** Sum of every loaded conversation's `unreadCount`, muted ones excluded. What a badge shows. */
  totalUnread: number;
  loading: boolean;
  /** True when `loadMore()` would fetch another page. */
  hasMore: boolean;
  /** True once the first page has come back (even an empty one). */
  loaded: boolean;
  error?: SwalvoChatError;
}

export interface InboxLoadOptions {
  /** Conversations per page, at most 100. Defaults to 30. */
  limit?: number;
  /**
   * Join the listed conversations so their new messages update the inbox
   * live. Defaults to `true`, capped by `watchLimit`.
   *
   * A chat connection only hears about conversations it has joined — there
   * is no per-user inbox channel (§2) — so an unwatched row only changes
   * on the next `refresh()`. Joining has a cost: the server allows 20
   * subscriptions per connection and marks the user present in each room
   * joined.
   */
  watch?: boolean;
  /** How many conversations `watch` may join. Defaults to 15, leaving headroom for the one being viewed. */
  watchLimit?: number;
}

/** What the inbox needs from the client. An interface so it can be tested without one. */
export interface InboxDeps {
  query: (options: QueryConversationsOptions) => Promise<InboxPage>;
  userId: () => string;
  joinRoom: (room: string) => Promise<void>;
  /** Subscribes to the client events the inbox reacts to. Returns one unsubscribe for all of them. */
  listen: (handlers: InboxEventHandlers) => Unsubscribe;
  logger: Logger;
}

export interface InboxEventHandlers {
  message: (message: ChatMessage) => void;
  read: (event: { roomId: string; userId: string; messageId: string | null }) => void;
  removed: (roomId: string) => void;
  reconnected: () => void;
}

const EMPTY: InboxSnapshot = { conversations: [], totalUnread: 0, loading: false, hasMore: false, loaded: false };

/**
 * `chat.inbox`: the signed-in user's conversations, kept current.
 *
 * Built on `queryMyConversations()` (`GET /v1/chat/me/conversations`).
 * The first page comes from the server with its unread counts already
 * computed; after that the inbox folds in what the socket delivers — a new
 * message moves its conversation to the top and bumps its unread count, a
 * read mark clears it — without another round trip.
 *
 * ## Counting without double counting
 *
 * The page the server returns and the live messages overlap: a message can
 * be counted in the page's `unreadCount` *and* arrive over the socket a
 * moment later. Every row carries its `lastMessage.seq`, and a live message
 * at or below it is already counted, so it only refreshes the preview.
 * That is the job `seq` (§1) exists for, and why counts stay right across
 * a reconnect.
 *
 * Shaped for `useSyncExternalStore`: `subscribe()` + `getSnapshot()`,
 * immutable snapshots.
 */
export class Inbox {
  private snapshot: InboxSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private nextCursor: string | null = null;
  private options: Required<InboxLoadOptions> = { limit: 30, watch: true, watchLimit: 15 };
  private stopListening?: Unsubscribe;
  private readonly watched = new Set<string>();
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: InboxDeps) {}

  getSnapshot = (): InboxSnapshot => this.snapshot;

  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The first page. Replaces whatever was loaded, and starts following live updates. */
  async load(options: InboxLoadOptions = {}): Promise<InboxSnapshot> {
    this.options = { ...this.options, ...options };
    this.startListening();
    this.patch({ loading: true, error: undefined });
    try {
      const page = await this.deps.query({ limit: this.options.limit });
      this.nextCursor = page.nextCursor;
      this.patch({
        conversations: sortByActivity(page.conversations.map(normalizeRow)),
        hasMore: page.nextCursor !== null,
        loading: false,
        loaded: true,
      });
      await this.watchVisible();
    } catch (error) {
      this.patch({ loading: false, error: error as SwalvoChatError });
    }
    return this.snapshot;
  }

  /** The next page, appended. A no-op once there are no more. */
  async loadMore(): Promise<InboxSnapshot> {
    if (!this.nextCursor || this.snapshot.loading) return this.snapshot;
    this.patch({ loading: true });
    try {
      const page = await this.deps.query({ limit: this.options.limit, cursor: this.nextCursor });
      this.nextCursor = page.nextCursor;
      this.patch({
        conversations: mergeRows(this.snapshot.conversations, page.conversations.map(normalizeRow)),
        hasMore: page.nextCursor !== null,
        loading: false,
      });
    } catch (error) {
      this.patch({ loading: false, error: error as SwalvoChatError });
    }
    return this.snapshot;
  }

  /**
   * Re-reads the first page and merges it in. Runs by itself after a
   * reconnect, since unwatched conversations heard nothing while the socket
   * was down; call it yourself when the app returns to the foreground.
   */
  async refresh(): Promise<InboxSnapshot> {
    if (!this.stopListening) return this.snapshot;
    try {
      const page = await this.deps.query({ limit: this.options.limit });
      this.patch({ conversations: mergeRows(this.snapshot.conversations, page.conversations.map(normalizeRow)) });
      if (this.snapshot.conversations.length <= page.conversations.length) {
        this.nextCursor = page.nextCursor;
        this.patch({ hasMore: page.nextCursor !== null });
      }
      await this.watchVisible();
    } catch (error) {
      this.deps.logger.debug(`inbox refresh failed: ${String(error)}`);
    }
    return this.snapshot;
  }

  /** Stops following live updates. The loaded rows stay readable. */
  stop(): void {
    this.stopListening?.();
    this.stopListening = undefined;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /** @internal The server's answer to a read mark: authoritative, so it overwrites the local count. */
  applyReadState(state: ReadState): void {
    this.updateRow(state.roomId, (row) => ({
      ...row,
      unreadCount: state.unreadCount,
      unreadMentions: state.unreadCount === 0 ? 0 : row.unreadMentions,
      lastReadSeq: state.unreadCount === 0 && row.lastMessage?.seq ? row.lastMessage.seq : row.lastReadSeq,
    }));
  }

  /** @internal Reflects a notification preference change made through the client. */
  applyPreferences(preferences: NotificationPreferences): void {
    this.updateRow(preferences.roomId, (row) => ({
      ...row,
      muted: preferences.muted,
      notifications: preferences.notifications,
    }));
  }

  private startListening(): void {
    if (this.stopListening) return;
    this.stopListening = this.deps.listen({
      message: (message) => this.onMessage(message),
      read: (event) => this.onRead(event),
      removed: (roomId) => this.removeRow(roomId),
      reconnected: () => void this.refresh(),
    });
  }

  private onMessage(message: ChatMessage): void {
    const row = this.snapshot.conversations.find((candidate) => candidate.id === message.roomId);
    if (!row) {
      // A conversation that is not on the loaded pages: new to this user,
      // or further down the list. Its server-computed row is the only
      // trustworthy one, so fetch it rather than invent a row from one
      // message.
      this.scheduleRefresh();
      return;
    }

    // Already counted in the page the server returned, or already seen
    // live. Either way only the preview could be stale.
    const alreadyCounted =
      row.lastMessage?.seq != null && message.seq != null && compareSeq(message.seq, row.lastMessage.seq) <= 0;
    if (alreadyCounted) return;

    const me = this.deps.userId();
    const fromSomeoneElse = message.senderId !== me;
    const unreadByMark = row.lastReadSeq == null || message.seq == null || compareSeq(message.seq, row.lastReadSeq) > 0;
    const countIt = fromSomeoneElse && unreadByMark && !message.deleted;
    const mentionsMe = countIt && (message.mentions ?? []).includes(me);

    const next: InboxConversation = {
      ...row,
      lastMessage: {
        id: message.id,
        seq: message.seq ?? null,
        senderId: message.senderId,
        content: message.text,
        type: String(message.type).toUpperCase(),
        createdAt: message.createdAt,
      },
      // Sending a message is reading the conversation, as far as the
      // server's own count is concerned (§2: adjusted for the caller's own
      // messages). Mirror that.
      unreadCount: fromSomeoneElse ? row.unreadCount + (countIt ? 1 : 0) : 0,
      unreadMentions: fromSomeoneElse ? row.unreadMentions + (mentionsMe ? 1 : 0) : 0,
      lastReadSeq: fromSomeoneElse ? row.lastReadSeq : (message.seq ?? row.lastReadSeq),
      updatedAt: message.createdAt > row.updatedAt ? message.createdAt : row.updatedAt,
    };
    this.patch({ conversations: sortByActivity(this.snapshot.conversations.map((r) => (r === row ? next : r))) });
  }

  private onRead(event: { roomId: string; userId: string; messageId: string | null }): void {
    if (event.userId !== this.deps.userId()) return;
    const row = this.snapshot.conversations.find((candidate) => candidate.id === event.roomId);
    if (!row) return;
    if (event.messageId && row.lastMessage?.id === event.messageId) {
      // Read up to the newest message: nothing is unread.
      this.updateRow(row.id, (current) => ({
        ...current,
        unreadCount: 0,
        unreadMentions: 0,
        lastReadSeq: current.lastMessage?.seq ?? current.lastReadSeq,
      }));
      return;
    }
    // Read up to somewhere in the middle, from another device. Only the
    // server can say how many are left.
    this.scheduleRefresh();
  }

  private removeRow(roomId: string): void {
    if (!this.snapshot.conversations.some((row) => row.id === roomId)) return;
    this.watched.delete(roomId);
    this.patch({ conversations: this.snapshot.conversations.filter((row) => row.id !== roomId) });
  }

  private updateRow(roomId: string, update: (row: InboxConversation) => InboxConversation): void {
    let changed = false;
    const conversations = this.snapshot.conversations.map((row) => {
      if (row.id !== roomId) return row;
      changed = true;
      return update(row);
    });
    if (changed) this.patch({ conversations });
  }

  private async watchVisible(): Promise<void> {
    if (!this.options.watch) return;
    for (const row of this.snapshot.conversations) {
      if (this.watched.size >= this.options.watchLimit) return;
      if (this.watched.has(row.id)) continue;
      this.watched.add(row.id);
      try {
        await this.deps.joinRoom(row.id);
      } catch (error) {
        // One conversation refusing a join (subscription cap, a ban) must
        // not stop the others being watched.
        this.watched.delete(row.id);
        this.deps.logger.debug(`inbox could not watch ${row.id}: ${String(error)}`);
      }
    }
  }

  /** Coalesces a burst of "I need the server's view" into one request. */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 250);
  }

  private patch(partial: Partial<InboxSnapshot>): void {
    const next = { ...this.snapshot, ...partial };
    next.totalUnread = next.conversations.reduce(
      (total, row) => total + (row.muted || row.notifications === 'none' ? 0 : row.unreadCount),
      0,
    );
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

/** Fills the fields an older server may omit, so consumers never see `undefined` counts. */
export function normalizeRow(row: InboxConversation): InboxConversation {
  return {
    ...row,
    name: row.name ?? null,
    metadata: row.metadata ?? {},
    muted: row.muted ?? false,
    unreadCount: row.unreadCount ?? 0,
    unreadMentions: row.unreadMentions ?? 0,
    lastReadSeq: row.lastReadSeq ?? null,
    lastMessage: row.lastMessage
      ? { ...row.lastMessage, seq: row.lastMessage.seq == null ? null : String(row.lastMessage.seq) }
      : null,
  };
}

function sortByActivity(rows: InboxConversation[]): InboxConversation[] {
  return [...rows].sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
}

function activityOf(row: InboxConversation): string {
  const last = row.lastMessage?.createdAt ?? '';
  return last > row.updatedAt ? last : row.updatedAt;
}

/** Server rows replace local ones with the same id; local-only rows are kept. */
function mergeRows(current: InboxConversation[], incoming: InboxConversation[]): InboxConversation[] {
  const byId = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  return sortByActivity(Array.from(byId.values()));
}
