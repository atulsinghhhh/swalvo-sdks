import type { SwalvoChatError } from '../errors';
import type { Logger } from '../logger';
import { parseSeq } from './seq';

/** The server's per-conversation event log page: `GET …/events?afterEventSeq=N`. */
export interface ChatEventRecord {
  eventSeq: string | number;
  type: string;
  /** The event's body, the same fields its live WebSocket frame carries. */
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface ChatEventPage {
  events: ChatEventRecord[];
  hasMore: boolean;
}

/** How many events to ask for per catch-up request. The server caps it at 500. */
export const EVENT_PAGE_SIZE = 500;

export interface EventSequencerDeps {
  fetchEvents: (room: string, afterEventSeq: string, limit: number) => Promise<ChatEventPage>;
  /**
   * Hands a frame to the client's ordinary frame handling. `origin` says
   * whether it came off the socket or out of the event log; the handling
   * is otherwise identical, which is the point.
   */
  apply: (frame: Record<string, unknown>, origin: 'live' | 'catchup') => void;
  /**
   * The resume point is older than the server's 7-day event log
   * (`410 EVENTS_EXPIRED`). Edits and reactions in between are gone for
   * good, so the client has to re-read history instead.
   */
  onExpired: (room: string) => Promise<void>;
  logger: Logger;
  isConnected: () => boolean;
  maxAttempts: number;
  retryDelayMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * How long a live gap may stay open before it is backfilled from the
   * log. See `ingest()` for why this is not zero.
   */
  gapFillDelayMs: number;
}

export interface EventCatchUpResult {
  room: string;
  /** Events applied from the log (duplicates of what already arrived are not counted). */
  applied: number;
  /** The resume point had aged out of the log and history was re-read instead. */
  expired: boolean;
  error?: SwalvoChatError;
}

interface RoomSequence {
  /** The highest eventSeq applied in this room. `null` until the first one arrives. */
  last: bigint | null;
  /** True while a catch-up runs: live sequenced frames are held instead of applied. */
  syncing: boolean;
  /** Frames that arrived ahead of a gap, or during a catch-up, keyed by eventSeq. */
  held: Map<bigint, Record<string, unknown>>;
  gapTimer?: ReturnType<typeof setTimeout>;
  running?: Promise<EventCatchUpResult>;
}

/**
 * Keeps every conversation's events in `eventSeq` order, and fills holes.
 *
 * Message replay (internal/recovery.ts) already recovers the *messages*
 * missed during an outage, but nothing else: an edit, a delete, a reaction
 * or a ban that happened while the socket was down was simply never seen,
 * and a client could show a deleted message forever. Phase 3 gives every
 * conversation-scoped event an `eventSeq` and keeps a 7-day log of them
 * (§1); this is the client half.
 *
 * ## The three things it does
 *
 * 1. **Orders.** A sequenced frame is applied only once every frame before
 *    it has been. One that arrives early is held.
 * 2. **De-duplicates.** A frame at or below the high-water mark has already
 *    been applied — typically the same event read both live and from the
 *    log across a reconnect — and is dropped.
 * 3. **Backfills.** A hole that does not close by itself is filled from
 *    `GET …/events?afterEventSeq=N`. So is everything after the resume
 *    point on every reconnect.
 *
 * ## Why a grace period before backfilling a live gap
 *
 * The server stamps `eventSeq` before it publishes, and two events in the
 * same conversation can be published from two API instances. Over Redis
 * pub/sub they can then reach a gateway in the opposite order to their
 * seqs, so an out-of-order pair is normal and not a loss. Waiting a few
 * hundred milliseconds lets the straggler arrive and turns "one REST call
 * per reorder" into "none".
 *
 * ## Holes that stay holes
 *
 * Some gaps are legitimate. Events from a user this user has blocked are
 * not delivered to them (§3.2), live or from the log, so their seqs never
 * show up. When the log says there is nothing more to read, any hole left
 * is one of those and the high-water mark moves past it.
 *
 * Frames without an `eventSeq` — typing, presence, anything from an older
 * server — never come through here.
 */
export class EventSequencer {
  private readonly rooms = new Map<string, RoomSequence>();

  constructor(private readonly deps: EventSequencerDeps) {}

  /** The highest eventSeq applied in a room, as the server's string form. */
  lastEventSeq(room: string): string | null {
    return this.rooms.get(room)?.last?.toString() ?? null;
  }

  /** Rooms with a resume point, i.e. ones a reconnect can catch up. */
  knownRooms(): string[] {
    return Array.from(this.rooms.entries())
      .filter(([, state]) => state.last !== null)
      .map(([room]) => room);
  }

  /**
   * Seeds a room's resume point without applying anything: the server's
   * current head, when a join response reports one. Only ever moves the
   * mark for a room that has none, so it can never skip an event this
   * client has not seen.
   */
  baseline(room: string, eventSeq: unknown): void {
    const seq = parseSeq(eventSeq);
    if (seq === null) return;
    const state = this.state(room);
    if (state.last === null) state.last = seq;
  }

  /**
   * Feeds one live frame through. Applies it, holds it, or drops it.
   *
   * A frame with no (or an unparseable) `eventSeq` is applied as-is: that
   * is every ephemeral frame, and every frame from a server older than
   * Phase 3.
   */
  ingest(room: string, frame: Record<string, unknown>): void {
    const seq = parseSeq(frame.eventSeq);
    if (seq === null) {
      this.deps.apply(frame, 'live');
      return;
    }

    const state = this.state(room);

    if (state.syncing) {
      state.held.set(seq, frame);
      return;
    }

    if (state.last === null) {
      // The first sequenced frame this client has seen here. There is no
      // "before" to have missed, so it becomes the starting point.
      state.last = seq;
      this.deps.apply(frame, 'live');
      return;
    }

    if (seq <= state.last) {
      this.deps.logger.debug(`dropped duplicate event ${seq} in ${room}`);
      return;
    }

    if (seq === state.last + 1n) {
      state.last = seq;
      this.deps.apply(frame, 'live');
      this.drainContiguous(state, 'live');
      if (state.held.size === 0) this.clearGapTimer(state);
      return;
    }

    // Ahead of a hole. Hold it, and give the hole a moment to close.
    state.held.set(seq, frame);
    this.armGapTimer(room, state);
  }

  /**
   * Marks rooms as syncing ahead of a reconnect's catch-up, so live frames
   * that arrive while the rooms are being re-joined are held rather than
   * applied ahead of the older events the catch-up is about to read.
   */
  beginSync(rooms: readonly string[]): void {
    for (const room of rooms) {
      const state = this.rooms.get(room);
      if (state && state.last !== null) state.syncing = true;
    }
  }

  /**
   * Reads everything after the room's resume point from the event log and
   * applies it in order, then releases whatever was held meanwhile.
   *
   * Concurrent calls for one room share a single run.
   */
  catchUp(room: string): Promise<EventCatchUpResult> {
    const state = this.state(room);
    if (state.running) return state.running;

    this.clearGapTimer(state);
    state.syncing = true;
    const running = this.run(room, state).finally(() => {
      state.syncing = false;
      state.running = undefined;
      this.release(room, state);
    });
    state.running = running;
    return running;
  }

  /** Drops a room's state when the caller leaves it on purpose. */
  forget(room: string): void {
    const state = this.rooms.get(room);
    if (state) this.clearGapTimer(state);
    this.rooms.delete(room);
  }

  /** Stops timers. Resume points survive, so a later connect still catches up. */
  pause(): void {
    for (const state of this.rooms.values()) {
      this.clearGapTimer(state);
    }
  }

  private async run(room: string, state: RoomSequence): Promise<EventCatchUpResult> {
    if (state.last === null) {
      // Nothing was ever applied here, so there is nothing to have missed.
      return { room, applied: 0, expired: false };
    }

    let applied = 0;
    let attempt = 0;

    for (;;) {
      if (!this.deps.isConnected()) {
        this.deps.logger.debug(`event catch-up for ${room} interrupted; will resume on the next reconnect`);
        return { room, applied, expired: false };
      }

      const after: bigint = state.last ?? 0n;
      let page: ChatEventPage;
      try {
        page = await this.deps.fetchEvents(room, after.toString(), EVENT_PAGE_SIZE);
        attempt = 0;
      } catch (error) {
        const chatError = error as SwalvoChatError;
        if (chatError?.code === 'EVENTS_EXPIRED') {
          this.deps.logger.warn(`event log for ${room} no longer reaches ${after}; re-reading history`);
          // The resume point is useless now. Whatever is held becomes the
          // new starting point when it is released.
          state.last = null;
          try {
            await this.deps.onExpired(room);
          } catch (resyncError) {
            return { room, applied, expired: true, error: resyncError as SwalvoChatError };
          }
          return { room, applied, expired: true };
        }

        attempt += 1;
        if (attempt >= this.deps.maxAttempts) {
          this.deps.logger.warn(
            `could not catch up events in ${room} after ${attempt} attempts: ${chatError?.message ?? String(error)}`,
          );
          return { room, applied, expired: false, error: chatError };
        }
        await this.deps.sleep(this.deps.retryDelayMs(attempt));
        continue;
      }

      const records = (page.events ?? [])
        .map((record) => ({ record, seq: parseSeq(record.eventSeq) }))
        .filter((entry): entry is { record: ChatEventRecord; seq: bigint } => entry.seq !== null)
        .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

      let advanced = false;
      for (const { record, seq } of records) {
        if (state.last !== null && seq <= state.last) continue;
        state.last = seq;
        advanced = true;
        // Anything held at or below this seq is the same event, already
        // applied now from the log.
        state.held.delete(seq);
        this.deps.apply(toFrame(record), 'catchup');
        applied += 1;
      }

      if (!page.hasMore || !advanced) {
        return { room, applied, expired: false };
      }
    }
  }

  /**
   * Applies what was held during a catch-up, in seq order.
   *
   * After a catch-up the log has been read to its end, so a hole still in
   * front of a held frame is one the server is never going to fill — a
   * blocked user's event, most likely — and is stepped over. Holding the
   * frame until it did would hold the conversation forever.
   */
  private release(room: string, state: RoomSequence): void {
    if (state.held.size === 0) return;
    const held = Array.from(state.held.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    state.held.clear();
    for (const [seq, frame] of held) {
      if (state.last !== null && seq <= state.last) continue;
      if (state.last !== null && seq !== state.last + 1n) {
        this.deps.logger.debug(`event log has no ${state.last + 1n}..${seq - 1n} in ${room}; continuing past it`);
      }
      state.last = seq;
      this.deps.apply(frame, 'live');
    }
  }

  private drainContiguous(state: RoomSequence, origin: 'live' | 'catchup'): void {
    while (state.last !== null) {
      const next = state.last + 1n;
      const frame = state.held.get(next);
      if (!frame) return;
      state.held.delete(next);
      state.last = next;
      this.deps.apply(frame, origin);
    }
  }

  private armGapTimer(room: string, state: RoomSequence): void {
    if (state.gapTimer !== undefined) return;
    state.gapTimer = setTimeout(() => {
      state.gapTimer = undefined;
      if (state.held.size === 0) return;
      this.deps.logger.debug(`event gap in ${room} did not close by itself; backfilling from the log`);
      void this.catchUp(room);
    }, this.deps.gapFillDelayMs);
  }

  private clearGapTimer(state: RoomSequence): void {
    if (state.gapTimer !== undefined) {
      clearTimeout(state.gapTimer);
      state.gapTimer = undefined;
    }
  }

  private state(room: string): RoomSequence {
    let state = this.rooms.get(room);
    if (!state) {
      state = { last: null, syncing: false, held: new Map() };
      this.rooms.set(room, state);
    }
    return state;
  }
}

/**
 * An event-log record as the frame it was when it went out live.
 *
 * The log stores the frame's body as `payload`, so this is a merge and
 * not a translation — one handler then serves both paths.
 */
function toFrame(record: ChatEventRecord): Record<string, unknown> {
  return { ...(record.payload ?? {}), type: record.type, eventSeq: String(record.eventSeq) };
}
