import { SwalvoChatError, SwalvoMessageError, isConnectivityError, type ChatErrorCode } from './errors';
import type { Logger } from './logger';
import type { ChatMessageType, SendMessageResult } from './types';

/**
 * Where a queued send is in its life.
 *
 * - `pending`: waiting for a connection. Sent automatically on (re)connect.
 * - `sending`: on the wire right now.
 * - `failed`: the server refused it (muted, too large, blocked by the
 *   moderation hook…). Nothing retries it by itself; `retry()` or
 *   `cancel()` are the caller's to choose.
 *
 * A message that was stored leaves the outbox entirely: from then on it is
 * an ordinary `ChatMessage`, delivered through `message` like any other.
 */
export type OutboxStatus = 'pending' | 'sending' | 'failed';

/** A send that has not been confirmed stored yet. Plain JSON, so any storage can hold it. */
export interface OutboxEntry {
  /**
   * The idempotency key, and this entry's id. It is what makes resending
   * safe: however many times an entry goes out, the server stores it once.
   */
  clientMessageId: string;
  room: string;
  /** Whose send this is, so a storage shared by several accounts never replays one user's messages as another. */
  userId: string;
  text?: string;
  type?: ChatMessageType;
  replyTo?: string;
  attachmentId?: string;
  metadata?: Record<string, unknown>;
  mentions?: string[];
  /** When it was queued, ISO-8601. Entries are sent oldest first. */
  createdAt: string;
  status: OutboxStatus;
  attempts: number;
  /** Why the last attempt failed. Set on `failed`, and on a `pending` entry that was knocked back by the network. */
  error?: { code: ChatErrorCode; message: string; retryAfterSeconds?: number; reason?: string };
}

/**
 * Persistence for the outbox. Implement it to keep unsent messages across a
 * page reload or an app restart.
 *
 * Deliberately two methods over the whole list: the outbox is small (it is
 * only what has not been sent yet), and a load/save pair is something any
 * key-value store can do — `localStorage`, React Native's `AsyncStorage`,
 * MMKV, IndexedDB — with no schema or migrations.
 *
 * ```ts
 * // React Native
 * import AsyncStorage from '@react-native-async-storage/async-storage';
 *
 * const storage: OutboxStorage = {
 *   async load() {
 *     const raw = await AsyncStorage.getItem('raven-chat-outbox');
 *     return raw ? JSON.parse(raw) : [];
 *   },
 *   save: (entries) => AsyncStorage.setItem('raven-chat-outbox', JSON.stringify(entries)),
 * };
 * ```
 */
export interface OutboxStorage {
  load(): Promise<OutboxEntry[]> | OutboxEntry[];
  save(entries: OutboxEntry[]): Promise<void> | void;
}

/** The default: survives reconnects, not reloads. */
export class MemoryOutboxStorage implements OutboxStorage {
  private entries: OutboxEntry[] = [];

  load(): OutboxEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  save(entries: OutboxEntry[]): void {
    this.entries = entries.map((entry) => ({ ...entry }));
  }
}

/**
 * Keeps the outbox in `localStorage`, so a message typed just before the
 * tab was closed goes out the next time the app connects.
 *
 * Every access is guarded: private browsing, a full quota or a blocked
 * storage partition must cost persistence, never the send itself.
 */
export class LocalStorageOutboxStorage implements OutboxStorage {
  constructor(
    private readonly key = 'raven-chat-outbox',
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof localStorage !== 'undefined'
      ? localStorage
      : undefined,
  ) {}

  load(): OutboxEntry[] {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed.filter(isEntry) as OutboxEntry[]) : [];
    } catch {
      return [];
    }
  }

  save(entries: OutboxEntry[]): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(entries));
    } catch {
      // Quota or a disabled storage. The in-memory copy still works.
    }
  }
}

export interface OutboxDeps {
  storage: OutboxStorage;
  userId: () => string;
  /** Puts one entry on the wire: the WebSocket when connected, HTTP otherwise. */
  transmit: (entry: OutboxEntry) => Promise<SendMessageResult>;
  isConnected: () => boolean;
  onChange: (entries: OutboxEntry[]) => void;
  /**
   * An entry was confirmed stored. Called *before* the entry leaves the
   * list, so a view swapping its optimistic row for the stored message
   * never has a tick where neither is there.
   */
  onSent?: (entry: OutboxEntry, message: SendMessageResult) => void;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
}

/** How many times a flush will wait out a rate limit on one entry before marking it failed. */
const MAX_RATE_LIMIT_WAITS = 3;
/** Never wait longer than this for one rate-limit window during a flush. */
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

/**
 * `chat.outbox`: sends that have not been confirmed stored yet.
 *
 * Every `sendMessage()` goes through here. Most entries live for one round
 * trip and nobody ever sees them; the outbox matters when the round trip
 * fails because the connection did. Then the entry stays `pending` and is
 * sent again — with the same `clientMessageId`, so the server stores it
 * once however many attempts it takes — as soon as the client reconnects.
 *
 * What it does not do is guess. A send the server *refused* (muted, banned,
 * slow mode, too large, blocked by the moderation hook) goes to `failed`
 * and stays there until the app calls `retry()` or `cancel()`. Resending
 * those automatically would either fail identically forever or, for slow
 * mode, post a message the user may no longer want.
 */
export class Outbox {
  private entries: OutboxEntry[] = [];
  private loaded?: Promise<void>;
  private isLoaded = false;
  private flushing?: Promise<void>;
  /**
   * Saves are chained rather than awaited by the send path, for two
   * reasons. A send must reach the socket in the same tick it was called
   * in — awaiting a storage write first would put an async hop between
   * typing and sending for no gain. And with an async store such as
   * AsyncStorage, two un-chained writes can land in the opposite order and
   * resurrect an entry that was already sent.
   */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: OutboxDeps) {}

  /** Loads whatever a previous session left behind. Idempotent. */
  ready(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const stored = await this.deps.storage.load();
          const known = new Set(this.entries.map((entry) => entry.clientMessageId));
          for (const entry of stored ?? []) {
            if (!isEntry(entry) || known.has(entry.clientMessageId)) continue;
            // `sending` in storage means the last session died mid-send. It
            // may or may not have been stored; resending with the same key
            // finds out safely.
            this.entries.push({ ...entry, status: entry.status === 'sending' ? 'pending' : entry.status });
          }
          this.entries.sort(byCreatedAt);
        } catch (error) {
          this.deps.logger.warn(`could not load the outbox: ${String(error)}`);
        }
        this.isLoaded = true;
      })();
    }
    return this.loaded;
  }

  /** This user's queued sends, oldest first. Optionally for one room. */
  list(room?: string): OutboxEntry[] {
    const userId = this.deps.userId();
    return this.entries
      .filter((entry) => entry.userId === userId && (room === undefined || entry.room === room))
      .map((entry) => ({ ...entry }));
  }

  get(clientMessageId: string): OutboxEntry | undefined {
    const entry = this.find(clientMessageId);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Re-sends a `failed` (or still `pending`) entry now, with its original
   * idempotency key. Resolves with the stored message like `sendMessage()`.
   */
  async retry(clientMessageId: string): Promise<SendMessageResult> {
    // No await on the loaded path, so a retry reaches the socket in the
    // tick it was asked for, like a first send does.
    if (!this.isLoaded) await this.ready();
    const entry = this.find(clientMessageId);
    if (!entry) {
      throw new SwalvoMessageError(`No queued message with clientMessageId "${clientMessageId}"`, 'MESSAGE_NOT_FOUND');
    }
    if (entry.status === 'sending') {
      throw new SwalvoMessageError('That message is already being sent', 'INVALID_MESSAGE');
    }
    entry.status = 'pending';
    entry.error = undefined;
    this.persist();
    return this.deliver(entry, 'direct');
  }

  /**
   * Drops a queued send so it never goes out. Returns `false` when there
   * was nothing to cancel, or when it is already on the wire — a send in
   * flight may already be stored, and pretending to have stopped it would
   * be a lie the next history load exposes.
   */
  async cancel(clientMessageId: string): Promise<boolean> {
    await this.ready();
    const entry = this.find(clientMessageId);
    if (!entry || entry.status === 'sending') return false;
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    this.persist();
    return true;
  }

  /** @internal Queues a send and attempts it once. Used by `ChatClient.sendMessage()`. */
  async enqueueAndSend(
    fields: Omit<OutboxEntry, 'userId' | 'createdAt' | 'status' | 'attempts'>,
  ): Promise<SendMessageResult> {
    // Only the very first send of a session can find the storage unread;
    // every later one goes straight to the wire (see `saveChain`).
    if (!this.isLoaded) await this.ready();
    const existing = this.find(fields.clientMessageId);
    if (existing) {
      // A caller re-sending with a key the outbox already holds. One entry,
      // not two: the server would deduplicate them anyway.
      if (existing.status === 'sending') {
        throw new SwalvoMessageError('A message with that clientMessageId is already being sent', 'INVALID_MESSAGE');
      }
      return this.retry(existing.clientMessageId);
    }

    const entry: OutboxEntry = {
      ...stripUndefined(fields),
      userId: this.deps.userId(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
    };
    this.entries.push(entry);
    this.persist();
    return this.deliver(entry, 'direct');
  }

  /**
   * Sends every `pending` entry, oldest first, one at a time.
   *
   * One at a time because order matters — two queued messages must arrive
   * in the order they were typed — and because the server's per-user send
   * rate would refuse a burst anyway. Stops at the first connectivity
   * failure: the connection just went again, and the next reconnect calls
   * this again.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      await this.ready();
      const userId = this.deps.userId();
      for (;;) {
        if (!this.deps.isConnected()) return;
        const next = this.entries.find((entry) => entry.userId === userId && entry.status === 'pending');
        if (!next) return;
        try {
          await this.deliver(next, 'flush');
        } catch (error) {
          if (isConnectivityError(error)) return;
          // Refused: it is `failed` now and the loop moves on to the next.
        }
      }
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async deliver(entry: OutboxEntry, mode: 'direct' | 'flush'): Promise<SendMessageResult> {
    let rateLimitWaits = 0;
    for (;;) {
      entry.status = 'sending';
      entry.attempts += 1;
      this.persist();

      try {
        const result = await this.deps.transmit(entry);
        this.deps.onSent?.({ ...entry }, result);
        this.entries = this.entries.filter((candidate) => candidate !== entry);
        this.persist();
        return result;
      } catch (error) {
        const chatError =
          error instanceof SwalvoChatError ? error : new SwalvoChatError('INTERNAL_ERROR', String(error), error);
        entry.error = {
          code: chatError.code,
          message: chatError.message,
          retryAfterSeconds: (chatError as { retryAfterSeconds?: number }).retryAfterSeconds,
          reason: (chatError as { reason?: string }).reason,
        };

        // A flush draining a backlog after a long outage is exactly when
        // the per-user rate limit bites, and none of those messages did
        // anything wrong. Wait the window out (bounded) rather than fail
        // them all. A direct send reports the limit to its caller instead.
        if (mode === 'flush' && chatError.code === 'RATE_LIMITED' && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
          rateLimitWaits += 1;
          entry.status = 'pending';
          this.persist();
          const seconds = (chatError as { retryAfterSeconds?: number }).retryAfterSeconds ?? 1;
          await this.deps.sleep(Math.min(seconds * 1_000, MAX_RATE_LIMIT_WAIT_MS));
          if (!this.deps.isConnected()) throw markQueued(chatError, entry);
          continue;
        }

        if (isConnectivityError(chatError)) {
          entry.status = 'pending';
          this.persist();
          throw markQueued(chatError, entry);
        }

        entry.status = 'failed';
        this.persist();
        chatError.clientMessageId = entry.clientMessageId;
        throw chatError;
      }
    }
  }

  private find(clientMessageId: string): OutboxEntry | undefined {
    const userId = this.deps.userId();
    return this.entries.find((entry) => entry.clientMessageId === clientMessageId && entry.userId === userId);
  }

  /** Resolves once every save queued so far has reached storage. Mostly for tests. */
  settled(): Promise<void> {
    return this.saveChain;
  }

  private persist(): void {
    const snapshot = this.entries.map((entry) => ({ ...entry }));
    this.saveChain = this.saveChain.then(async () => {
      try {
        await this.deps.storage.save(snapshot);
      } catch (error) {
        this.deps.logger.warn(`could not persist the outbox: ${String(error)}`);
      }
    });
    this.deps.onChange(this.list());
  }
}

function markQueued(error: SwalvoChatError, entry: OutboxEntry): SwalvoChatError {
  error.queued = true;
  error.clientMessageId = entry.clientMessageId;
  return error;
}

function byCreatedAt(a: OutboxEntry, b: OutboxEntry): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<OutboxEntry>;
  return (
    typeof entry.clientMessageId === 'string' && typeof entry.room === 'string' && typeof entry.userId === 'string'
  );
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
