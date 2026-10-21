'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type {
  ChatBlock,
  ChatClient,
  FlagReason,
  Inbox,
  InboxConversation,
  InboxLoadOptions,
  InboxSnapshot,
  ModerationActionOptions,
  MyModerationState,
  SwalvoChatError,
  SendMessageResult,
} from '@swalvo/chat';
import { useSwalvoChatStore } from './chat-context';
import { useChatClient } from './chat-hooks';
import {
  getConversationStore,
  retainConversationStore,
  type ConversationMessage,
  type ConversationSendInput,
  type ConversationSnapshot,
} from './conversation-store';

/**
 * Phase 3 hooks: inbox, per-room conversations, moderation.
 *
 * Same rule as chat-hooks.ts: every hook reads one slice through
 * `useSyncExternalStore`, so an unread badge does not re-render on every
 * keystroke in the composer. They all take the `ChatClient` from the
 * nearest `<SwalvoChat>` / `<ChatProvider>`; none opens a connection.
 */

const EMPTY_INBOX: InboxSnapshot = { conversations: [], totalUnread: 0, loading: false, hasMore: false, loaded: false };
const noopSubscribe = () => () => undefined;

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/** Who started following an inbox, so only the last hook to let go stops it, and only if a hook started it. */
const inboxRefs = new WeakMap<Inbox, { refs: number; startedByHooks: boolean }>();

function useRetainedInbox(client: ChatClient | undefined, options: InboxLoadOptions | undefined): InboxSnapshot {
  const inbox = client?.inbox;
  // Read once per client: changing options mid-life would mean reloading
  // and re-watching, which a re-render should never trigger by accident.
  const [initialOptions] = useState(options);

  useEffect(() => {
    if (!inbox || client?.isAudienceViewer) return undefined;
    let entry = inboxRefs.get(inbox);
    if (!entry) {
      entry = { refs: 0, startedByHooks: false };
      inboxRefs.set(inbox, entry);
    }
    entry.refs += 1;
    const snapshot = inbox.getSnapshot();
    if (entry.refs === 1 && !snapshot.loaded && !snapshot.loading) {
      entry.startedByHooks = true;
      void inbox.load(initialOptions);
    }
    const held = entry;
    return () => {
      held.refs -= 1;
      if (held.refs === 0 && held.startedByHooks) {
        held.startedByHooks = false;
        inbox.stop();
      }
    };
  }, [inbox, client, initialOptions]);

  return useSyncExternalStore(
    inbox?.subscribe ?? noopSubscribe,
    () => inbox?.getSnapshot() ?? EMPTY_INBOX,
    () => inbox?.getSnapshot() ?? EMPTY_INBOX,
  );
}

export interface UseInboxResult extends InboxSnapshot {
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
}

/**
 * This user's conversations, newest activity first, with unread counts that
 * update as messages and read marks arrive. Loads the first page on mount.
 * Empty for a live-stream audience viewer, who has no inbox (§6).
 */
export function useInbox(options?: InboxLoadOptions): UseInboxResult {
  const client = useChatClient();
  const snapshot = useRetainedInbox(client, options);
  const loadMore = useCallback(async () => {
    await client?.inbox.loadMore();
  }, [client]);
  const refresh = useCallback(async () => {
    await client?.inbox.refresh();
  }, [client]);
  return useMemo(() => ({ ...snapshot, loadMore, refresh }), [snapshot, loadMore, refresh]);
}

/**
 * The inbox badge: every unmuted conversation's unread count added up, or
 * one conversation's when `room` is given (its `conv_…` id).
 */
export function useUnreadCount(room?: string): number {
  const client = useChatClient();
  const snapshot = useRetainedInbox(client, undefined);
  if (room === undefined) return snapshot.totalUnread;
  return snapshot.conversations.find((row: InboxConversation) => row.id === room)?.unreadCount ?? 0;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface UseConversationResult {
  /** Oldest first. Unsent messages carry `localStatus`. */
  messages: ConversationMessage[];
  loading: boolean;
  hasMore: boolean;
  error?: SwalvoChatError;
  pinned: string[];
  loadOlder(): Promise<void>;
  /** Resolves `undefined` when the send was queued for reconnect rather than stored now. */
  send(input: ConversationSendInput): Promise<SendMessageResult | undefined>;
  retry(clientMessageId: string): Promise<SendMessageResult | undefined>;
  cancel(clientMessageId: string): Promise<boolean>;
  markRead(): Promise<void>;
}

const EMPTY_CONVERSATION: ConversationSnapshot = {
  messages: [],
  loading: false,
  hasMore: false,
  typing: [],
  presence: {},
  presenceCount: null,
  pinned: [],
};

/**
 * Subscribes to a room's shared store, retaining it for as long as the
 * component is mounted. `undefined` room or client reads an empty snapshot.
 */
function useConversationSlice<T>(
  room: string | undefined,
  select: (snapshot: ConversationSnapshot) => T,
  options: { pageSize?: number } = {},
): T {
  const client = useChatClient();
  const store = useMemo(
    () => (client && room ? getConversationStore(client, room, options) : undefined),
    // Page size is read once per store, like the inbox options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, room],
  );

  useEffect(() => {
    if (!client || !room) return undefined;
    return retainConversationStore(client, room, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, room]);

  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => select(store?.getSnapshot() ?? EMPTY_CONVERSATION),
    () => select(store?.getSnapshot() ?? EMPTY_CONVERSATION),
  );
}

const selectAll = (snapshot: ConversationSnapshot) => snapshot;

/**
 * One room's messages, with optimistic sends from the outbox, history
 * paging, and retry/cancel for sends that did not go through. Joins the
 * room on the provider's client if it is not joined already.
 *
 * Several components using the same room share one store, so the list and
 * the composer see the same optimistic message.
 */
export function useConversation(room: string, options: { pageSize?: number } = {}): UseConversationResult {
  const client = useChatClient();
  const snapshot = useConversationSlice(room, selectAll, options);
  const store = client ? getConversationStore(client, room, options) : undefined;

  return useMemo(
    () => ({
      messages: snapshot.messages,
      loading: snapshot.loading,
      hasMore: snapshot.hasMore,
      error: snapshot.error,
      pinned: snapshot.pinned,
      loadOlder: () => store?.loadOlder() ?? Promise.resolve(),
      send: (input: ConversationSendInput) => store?.send(input) ?? Promise.resolve(undefined),
      retry: (id: string) => store?.retry(id) ?? Promise.resolve(undefined),
      cancel: (id: string) => store?.cancel(id) ?? Promise.resolve(false),
      markRead: () => store?.markRead() ?? Promise.resolve(),
    }),
    [snapshot, store],
  );
}

/** @internal Typing users for one room, for `useTyping(room)`. */
export function useRoomTyping(room: string | undefined): string[] {
  return useConversationSlice(room, (snapshot) => snapshot.typing);
}

/**
 * How many people are online. In a large room (§6) this is the server's
 * `presence.count`; otherwise the members currently `online`. Without
 * `room`, the provider's room.
 */
export function usePresenceCount(room?: string): number {
  const providerStore = useSwalvoChatStore();
  const provider = useSyncExternalStore(
    room === undefined ? providerStore.subscribe : noopSubscribe,
    () => providerStore.getSnapshot(),
    () => providerStore.getSnapshot(),
  );
  const roomCount = useConversationSlice(room, (snapshot) => snapshot.presenceCount);
  const roomPresence = useConversationSlice(room, (snapshot) => snapshot.presence);

  if (room === undefined) {
    return provider.presenceCount ?? countOnline(provider.presence);
  }
  return roomCount ?? countOnline(roomPresence);
}

function countOnline(presence: Record<string, string>): number {
  return Object.values(presence).filter((status) => status === 'online').length;
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

export interface UseModerationResult extends MyModerationState {
  block(userId: string): Promise<void>;
  unblock(userId: string): Promise<void>;
  listBlocks(): Promise<ChatBlock[]>;
  flagMessage(messageId: string, reason: FlagReason, note?: string): Promise<void>;
  /** Moderator actions in this room. The server refuses them for anybody below MODERATOR. */
  ban(userId: string, options?: ModerationActionOptions): Promise<void>;
  unban(userId: string): Promise<void>;
  mute(userId: string, options?: ModerationActionOptions): Promise<void>;
  unmute(userId: string): Promise<void>;
}

const CLEAR_STATE: MyModerationState = { muted: false, mutedUntil: null, banned: false, bannedUntil: null };

/**
 * This user's moderation standing in a room (muted? banned? until when?)
 * plus the moderation calls, bound to that room. Re-renders on every
 * `member.*` event and on `removedFromRoom`.
 */
export function useModeration(room?: string): UseModerationResult {
  const client = useChatClient();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!client) return undefined;
    const bump = () => setVersion((value) => value + 1);
    const subscriptions = [
      client.on('memberBanned', bump),
      client.on('memberUnbanned', bump),
      client.on('memberMuted', bump),
      client.on('memberUnmuted', bump),
      client.on('removedFromRoom', bump),
      // A refused send is how a client learns it was muted before it
      // connected (there is no "am I muted" query), and the outbox reports
      // that refusal.
      client.on('outboxChanged', bump),
    ];
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [client]);

  // A timed mute lifts by the clock, not by an event. Re-render when it does.
  const state = useMemo(() => {
    if (!client) return CLEAR_STATE;
    try {
      return client.moderation.getMyState(room);
    } catch {
      return CLEAR_STATE;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, room, version]);

  useEffect(() => {
    const until = [state.mutedUntil, state.bannedUntil].filter((value): value is string => value !== null);
    if (until.length === 0) return undefined;
    const soonest = Math.min(...until.map((value) => Date.parse(value)));
    const delay = Math.max(soonest - Date.now(), 0) + 50;
    const timer = setTimeout(() => setVersion((value) => value + 1), Math.min(delay, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [state]);

  return useMemo(() => {
    const moderation = client?.moderation;
    const withRoom = room === undefined ? {} : { room };
    return {
      ...state,
      block: async (userId: string) => moderation?.block(userId),
      unblock: async (userId: string) => moderation?.unblock(userId),
      listBlocks: async () => (await moderation?.listBlocks()) ?? [],
      flagMessage: async (messageId: string, reason: FlagReason, note?: string) => {
        await moderation?.flagMessage(messageId, reason, note);
      },
      ban: async (userId: string, options: ModerationActionOptions = {}) =>
        moderation?.ban(userId, { ...options, ...withRoom }),
      unban: async (userId: string) => moderation?.unban(userId, withRoom),
      mute: async (userId: string, options: ModerationActionOptions = {}) =>
        moderation?.mute(userId, { ...options, ...withRoom }),
      unmute: async (userId: string) => moderation?.unmute(userId, withRoom),
    };
  }, [client, room, state]);
}
