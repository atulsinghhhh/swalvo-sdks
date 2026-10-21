import type { RestClient } from './internal/rest-client';
import type { ChatBlock, FlagReason, MemberModerationEvent, ModerationActionOptions } from './types';

/** This user's own standing in one conversation, as far as this client has been told. */
export interface MyModerationState {
  muted: boolean;
  /** When a timed mute lifts. `null` for a permanent mute, or when not muted. */
  mutedUntil: string | null;
  banned: boolean;
  bannedUntil: string | null;
}

const CLEAR: MyModerationState = { muted: false, mutedUntil: null, banned: false, bannedUntil: null };

/**
 * `chat.moderation.*` (§3).
 *
 * Three different audiences share this namespace, and the server checks
 * each call against the caller's role, never against what this client
 * claims:
 *
 * - **everyone**: block/unblock another user, and flag a message for review;
 * - **MODERATOR / ADMIN members**: ban, unban, mute and unmute within their
 *   own conversation, over the socket;
 * - **your backend**, with an API key, for app-wide bans and the review
 *   queue. Those are not here: an API key never belongs in a client.
 */
export class ModerationApi {
  /** room -> this user's state there. Fed by member.* events and by MUTED/BANNED refusals. */
  private readonly mine = new Map<string, MyModerationState>();

  constructor(
    private readonly rest: RestClient,
    private readonly defaultRoom: () => string,
    private readonly request: (type: string, payload: Record<string, unknown>) => Promise<unknown>,
  ) {}

  // -------------------------------------------------------------------------
  // Blocks (any user, about themselves)
  // -------------------------------------------------------------------------

  /**
   * Stops this user receiving anything from `userId`: their messages,
   * reactions and typing are not delivered here, their presence is hidden,
   * and a DIRECT conversation between the two refuses sends with `BLOCKED`.
   * The other user is not told.
   */
  async block(userId: string): Promise<void> {
    await this.rest.request(`/v1/chat/me/blocks/${encodeURIComponent(userId)}`, { method: 'POST' });
  }

  async unblock(userId: string): Promise<void> {
    await this.rest.request(`/v1/chat/me/blocks/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  /** Everyone this user has blocked. */
  async listBlocks(): Promise<ChatBlock[]> {
    const response = await this.rest.request<unknown>('/v1/chat/me/blocks');
    return listOf(response, ['blocks', 'data']).map(toBlock);
  }

  // -------------------------------------------------------------------------
  // Flags (any member)
  // -------------------------------------------------------------------------

  /**
   * Reports a message to the project's review queue. The message stays
   * visible; a human (or your backend) decides what happens next, and the
   * project receives a `message.flagged` webhook.
   */
  async flagMessage(messageId: string, reason: FlagReason, note?: string): Promise<{ id: string; status: string }> {
    return this.rest.request(`/v1/chat/messages/${encodeURIComponent(messageId)}/flags`, {
      method: 'POST',
      body: { reason, note },
    });
  }

  // -------------------------------------------------------------------------
  // Moderator actions (MODERATOR / ADMIN of the conversation)
  // -------------------------------------------------------------------------

  /**
   * Bans `userId` from a conversation. They are disconnected from it at
   * once, and cannot rejoin, read or send until the ban lifts. Omit
   * `durationSeconds` for a permanent ban.
   */
  ban(userId: string, options: ModerationActionOptions & { room?: string } = {}): Promise<void> {
    return this.act('moderation.ban', userId, options);
  }

  unban(userId: string, options: { room?: string } = {}): Promise<void> {
    return this.act('moderation.unban', userId, options);
  }

  /** Lets `userId` keep reading but not send, react or edit. */
  mute(userId: string, options: ModerationActionOptions & { room?: string } = {}): Promise<void> {
    return this.act('moderation.mute', userId, options);
  }

  unmute(userId: string, options: { room?: string } = {}): Promise<void> {
    return this.act('moderation.unmute', userId, options);
  }

  // -------------------------------------------------------------------------
  // This user's own state
  // -------------------------------------------------------------------------

  /**
   * Whether this user is muted or banned in a room, from what this client
   * has seen: a `member.muted` / `member.banned` about them, or a send the
   * server refused with `MUTED` / `BANNED`.
   *
   * There is no client-side "am I muted" query in the protocol, so a
   * client that connects while already muted only finds out on its first
   * refused send. Timed states clear themselves once `…Until` has passed.
   */
  getMyState(room?: string): MyModerationState {
    const target = room ?? this.defaultRoom();
    const state = this.mine.get(target);
    if (!state) return { ...CLEAR };
    const now = new Date().toISOString();
    return {
      muted: state.muted && (state.mutedUntil === null || state.mutedUntil > now),
      mutedUntil: state.muted && (state.mutedUntil === null || state.mutedUntil > now) ? state.mutedUntil : null,
      banned: state.banned && (state.bannedUntil === null || state.bannedUntil > now),
      bannedUntil: state.banned && (state.bannedUntil === null || state.bannedUntil > now) ? state.bannedUntil : null,
    };
  }

  /** @internal Folds a member.* event about this user into `getMyState()`. */
  observe(kind: 'banned' | 'unbanned' | 'muted' | 'unmuted', event: MemberModerationEvent): void {
    const state = { ...(this.mine.get(event.roomId) ?? CLEAR) };
    switch (kind) {
      case 'banned':
        state.banned = true;
        state.bannedUntil = event.expiresAt;
        break;
      case 'unbanned':
        state.banned = false;
        state.bannedUntil = null;
        break;
      case 'muted':
        state.muted = true;
        state.mutedUntil = event.expiresAt;
        break;
      case 'unmuted':
        state.muted = false;
        state.mutedUntil = null;
        break;
    }
    this.mine.set(event.roomId, state);
  }

  /** @internal A send refused with MUTED or BANNED tells us about our state even with no event. */
  observeRefusal(room: string, code: string): void {
    if (code === 'MUTED') {
      const state = this.mine.get(room);
      // Keep a known expiry; an unknown one is treated as open-ended.
      if (!state?.muted) this.observe('muted', { roomId: room, userId: '', by: null, expiresAt: null });
    } else if (code === 'BANNED') {
      const state = this.mine.get(room);
      if (!state?.banned) this.observe('banned', { roomId: room, userId: '', by: null, expiresAt: null });
    }
  }

  private async act(type: string, userId: string, options: ModerationActionOptions & { room?: string }): Promise<void> {
    const room = options.room ?? this.defaultRoom();
    await this.request(type, {
      room,
      userId,
      durationSeconds: options.durationSeconds,
      reason: options.reason,
    });
  }
}

/** Reads a list out of a response that may be a bare array or wrapped under one of `keys`. */
export function listOf(response: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(response)) return response as Record<string, unknown>[];
  if (response && typeof response === 'object') {
    for (const key of keys) {
      const value = (response as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
    }
  }
  return [];
}

function toBlock(raw: Record<string, unknown>): ChatBlock {
  return {
    userId: String(raw.userId ?? raw.blockedId ?? ''),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
  };
}
