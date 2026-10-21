import { SwalvoChatError } from '../errors';
import type { Logger } from '../logger';
import type { ChatMessage, MessagePage } from '../types';

/** How many messages to pull per catch-up request. */
const RECOVERY_PAGE_SIZE = 100;
/**
 * How many message ids to remember per room for de-duplication.
 *
 * Only has to cover the overlap between what arrived live and what a
 * catch-up re-reads, which is bounded by one outage, not by history. A
 * couple of pages' worth is generous; the cap is what stops a long-lived
 * client growing a set forever.
 */
const SEEN_IDS_PER_ROOM = 1_000;

export interface RecoveryDeps {
  /** The same authorized history call a developer would make. Recovery gets no special path. */
  listMessages: (options: { room: string; after: string; limit: number }) => Promise<MessagePage>;
  /** Delivers a recovered message to the application, exactly like a live one. */
  deliver: (message: ChatMessage) => void;
  logger: Logger;
  /** Aborts an in-flight catch-up when the socket drops again. */
  isConnected: () => boolean;
  maxAttempts: number;
  retryDelayMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
}

export interface RoomRecoveryResult {
  room: string;
  recovered: number;
  /**
   * True when the resume point was rejected and catch-up restarted from the
   * newest page instead, so messages before it were skipped.
   */
  gap: boolean;
  error?: SwalvoChatError;
}

/**
 * Remembers where each room got to, and replays what was missed.
 *
 * ## Why a cursor per room and not one per connection
 *
 * A connection is subscribed to several conversations at once and they
 * advance at completely different rates. One shared resume point would be
 * pinned to whichever room was quietest, so every reconnect would re-read
 * the busy rooms from far too early — correct, thanks to de-duplication,
 * but wasteful in exactly the case that matters. Rooms are independent
 * here, and one room failing to recover does not stop the others.
 *
 * ## Why the server's cursor rather than a local timestamp
 *
 * `createdAt` alone is not unique — two messages can land in the same
 * millisecond, and resuming from a bare timestamp either skips one or
 * repeats it depending on which comparison you pick. The cursor the server
 * puts on every message is the `(createdAt, publicId)` pair the history
 * endpoint already paginates on, so resuming is the same indexed seek as
 * an ordinary page and cannot land between two messages.
 *
 * It is also a *value*, not a reference to a row, so it survives the
 * message it names being deleted or aged out by retention. That is what
 * makes it safe to hold across a long offline period.
 *
 * ## What this is not
 *
 * Client recovery state, and nothing more. The server keeps no per-client
 * position, learns nothing when a client catches up, and behaves
 * identically whether or not anybody ever reconnects. Postgres stays the
 * only record of what was said.
 */
export class RecoveryTracker {
  /**
   * room -> the newest message delivered there: its opaque resume point,
   * plus the two public fields used to tell which of two messages is newer.
   */
  private readonly cursors = new Map<string, { cursor: string; createdAt: string; id: string }>();
  /** room -> recently delivered ids, newest last. Bounded; see SEEN_IDS_PER_ROOM. */
  private readonly seen = new Map<string, Set<string>>();

  constructor(private readonly deps: RecoveryDeps) {}

  /**
   * Records a delivered message and reports whether it is new.
   *
   * Every delivery path goes through here — live fan-out, catch-up, and
   * history a client loaded itself — so "have I already shown this?" has
   * one answer rather than three.
   */
  accept(message: ChatMessage): boolean {
    const room = message.roomId;
    let ids = this.seen.get(room);
    if (!ids) {
      ids = new Set();
      this.seen.set(room, ids);
    }

    if (ids.has(message.id)) {
      return false;
    }

    ids.add(message.id);
    if (ids.size > SEEN_IDS_PER_ROOM) {
      // Sets iterate in insertion order, so this drops the oldest.
      const oldest = ids.values().next();
      if (!oldest.done) ids.delete(oldest.value);
    }

    this.advance(room, message);
    return true;
  }

  /**
   * Moves a room's resume point forward, never backwards.
   *
   * History is delivered newest-first, and an application loading an older
   * page must not rewind the live position — otherwise the next reconnect
   * re-reads everything since that page.
   *
   * "Newer" is decided on the message's own `createdAt` and `id`, not on
   * the cursor string. The cursor is base64url, and that alphabet is not in
   * ASCII order, so comparing encoded cursors does not order the messages
   * they point at. `createdAt` then `id` is the same pair the server's
   * keyset compares, in the same order, using only documented public
   * fields — so the client never has to know what a cursor contains.
   */
  private advance(room: string, message: ChatMessage): void {
    if (!message.cursor) {
      // A server older than this SDK. Recovery for that room degrades to
      // "nothing to resume from" rather than to a wrong resume point.
      return;
    }
    const current = this.cursors.get(room);
    const next = { cursor: message.cursor, createdAt: message.createdAt, id: message.id };
    if (current === undefined || isNewer(next, current)) {
      this.cursors.set(room, next);
    }
  }

  /**
   * Notes how far a history page a developer fetched themselves reached,
   * without claiming those messages were delivered.
   *
   * Only the resume point moves; the de-duplication set is left alone. An
   * application that pages through history has decided for itself what to
   * render, and marking those ids as "already delivered" would suppress the
   * live copy of a message it may never have shown. What this does buy is a
   * resume point for a quiet room — one where the socket drops before any
   * live message has arrived, so there would otherwise be nothing to
   * recover from.
   */
  observeHistory(messages: readonly ChatMessage[]): void {
    for (const message of messages) {
      this.advance(message.roomId, message);
    }
  }

  /** Whether this room has a resume point yet. */
  has(room: string): boolean {
    return this.cursors.has(room);
  }

  cursorFor(room: string): string | undefined {
    return this.cursors.get(room)?.cursor;
  }

  /** Drops a room's state when the caller leaves it for good. */
  forget(room: string): void {
    this.cursors.delete(room);
    this.seen.delete(room);
  }

  clear(): void {
    this.cursors.clear();
    this.seen.clear();
  }

  /**
   * Replays everything a room missed, oldest first.
   *
   * Pages forward from the stored resume point until the server says there
   * is no more, so an outage longer than one page is not silently
   * truncated. Each message advances the cursor as it is delivered, so a
   * socket that drops again mid-catch-up resumes from what actually
   * reached the application rather than from where the attempt began.
   */
  async recoverRoom(room: string): Promise<RoomRecoveryResult> {
    const start = this.cursors.get(room)?.cursor;
    if (!start) {
      // Nothing was ever delivered here, so there is no "missed" to
      // define. The application's own first history load covers it.
      return { room, recovered: 0, gap: false };
    }

    let recovered = 0;
    let gap = false;
    let cursor = start;
    let attempt = 0;

    for (;;) {
      if (!this.deps.isConnected()) {
        // The socket dropped again. Stop rather than race the reconnect
        // that is about to start its own catch-up from the cursor this
        // one has already advanced.
        this.deps.logger.debug(`recovery for ${room} interrupted; will resume on the next reconnect`);
        return { room, recovered, gap };
      }

      let page: MessagePage;
      try {
        page = await this.deps.listMessages({ room, after: cursor, limit: RECOVERY_PAGE_SIZE });
        attempt = 0;
      } catch (error) {
        const chatError = error as SwalvoChatError;

        if (chatError?.code === 'INVALID_CURSOR') {
          // The resume point is unusable — a corrupted value, or one from
          // an incompatible encoding. Falling back to "replay everything"
          // could be an unbounded read, so recover from the newest page
          // instead and say plainly that there is a hole. Silently
          // reporting success here would be the worst of the options.
          this.deps.logger.warn(`resume point for ${room} was rejected; recovering from the newest page`);
          gap = true;
          this.cursors.delete(room);
          return { room, recovered, gap, error: chatError };
        }

        attempt += 1;
        if (attempt >= this.deps.maxAttempts) {
          // Give up on this pass, but keep the cursor: the next reconnect
          // retries from the same point. Never report a clean recovery
          // when messages may still be missing.
          this.deps.logger.warn(
            `could not recover ${room} after ${attempt} attempts: ${chatError?.message ?? String(error)}`,
          );
          return { room, recovered, gap, error: chatError };
        }
        await this.deps.sleep(this.deps.retryDelayMs(attempt));
        continue;
      }

      if (page.data.length === 0) {
        return { room, recovered, gap };
      }

      // History comes back newest-first. Deliver oldest-first so a
      // sender's messages reach the application in the order they were
      // sent, which is the ordering Swalvo actually promises.
      for (const message of [...page.data].reverse()) {
        if (this.accept(message)) {
          this.deps.deliver(message);
          recovered += 1;
        }
      }

      // `previousCursor` is the newest message in this page: the anchor for
      // walking further forward. (`nextCursor` walks backwards, into older
      // history, which is not what a catch-up wants.)
      const next = page.previousCursor;
      if (!page.hasMore || !next || next === cursor) {
        return { room, recovered, gap };
      }
      cursor = next;
    }
  }
}

/**
 * Whether `a` is strictly newer than `b`, by the same rule the server
 * paginates on: `createdAt`, then `id` to break a tie.
 *
 * The tiebreak is not decoration. Two messages routinely land in the same
 * millisecond, and a resume point chosen on the timestamp alone either
 * skips one of them or repeats it forever depending on which comparison is
 * used. `createdAt` is an ISO-8601 UTC string of fixed width, so string
 * order is time order; `id` is the same `publicId` column the server's
 * keyset tiebreaks on, compared the same way.
 */
function isNewer(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}
