import { decodeChatToken, validateConfig, type ChatClientConfig, type ResolvedChatClientConfig } from './config';
import {
  SwalvoChatConnectionError,
  SwalvoChatError,
  SwalvoChatPermissionError,
  SwalvoMessageError,
  SwalvoRoomError,
  toSwalvoChatError,
} from './errors';
import { TypedEventEmitter, type Unsubscribe } from './events';
import { createLogger, type Logger } from './logger';
import { RestClient } from './internal/rest-client';
import { SocketTransport, type WebSocketFactory } from './internal/socket-transport';
import { RecoveryTracker, type RoomRecoveryResult } from './internal/recovery';
import { EventSequencer, type ChatEventPage, type EventCatchUpResult } from './internal/event-sequencer';
import { normalizeMessage } from './internal/seq';
import { AttachmentsApi } from './attachments-api';
import { MessagesApi } from './messages-api';
import { ModerationApi, listOf } from './moderation-api';
import { Inbox, normalizeRow } from './inbox';
import { MemoryOutboxStorage, Outbox, type OutboxEntry } from './outbox';
import type {
  ChatConnectionState,
  ChatDevice,
  ChatMessage,
  InboxPage,
  MemberModerationEvent,
  MessageDeletedEvent,
  MessagePage,
  MessagePinEvent,
  MessageUpdatedInfo,
  NotificationLevel,
  NotificationPreferences,
  PresenceCountEvent,
  PresenceEntry,
  PresenceEvent,
  PresencePage,
  PresenceStatus,
  QueryConversationsOptions,
  ReactionEvent,
  ReadReceiptEvent,
  ReadState,
  RegisterDeviceOptions,
  RoomRemovedEvent,
  SendMessageOptions,
  SendMessageResult,
  TypingEvent,
} from './types';
import { CHAT_SDK_VERSION } from './version';

export interface ChatEventMap {
  /** A message arrived, your own included, echoed back with its canonical id. */
  message: (message: ChatMessage) => void;
  /** An edit, or (`info.reason === 'link_preview'`) the server's unfurl of the message's first link landing. */
  messageUpdated: (message: ChatMessage, info: MessageUpdatedInfo) => void;
  messageDeleted: (event: MessageDeletedEvent) => void;
  messagePinned: (event: MessagePinEvent) => void;
  messageUnpinned: (event: MessagePinEvent) => void;
  reactionAdded: (event: ReactionEvent) => void;
  reactionRemoved: (event: ReactionEvent) => void;
  typing: (event: TypingEvent) => void;
  presence: (event: PresenceEvent) => void;
  /**
   * Rooms above the server's large-room threshold (200 online by default)
   * stop sending one `presence` frame per arrival and send this instead, at
   * most every five seconds (§6).
   */
  presenceCount: (event: PresenceCountEvent) => void;
  read: (event: ReadReceiptEvent) => void;
  /** A moderator banned someone from a room. If it was this user, `removedFromRoom` follows. */
  memberBanned: (event: MemberModerationEvent) => void;
  memberUnbanned: (event: MemberModerationEvent) => void;
  /** A moderator muted someone: they can read, not post. */
  memberMuted: (event: MemberModerationEvent) => void;
  memberUnmuted: (event: MemberModerationEvent) => void;
  /**
   * This user lost access to a room they had not asked to leave: banned
   * (`reason: 'BANNED'`) or removed as a member. The SDK stops re-joining
   * it on reconnect.
   */
  removedFromRoom: (event: RoomRemovedEvent) => void;
  /** The outbox changed: a send was queued, went out, failed, or was confirmed. This user's entries, oldest first. */
  outboxChanged: (entries: OutboxEntry[]) => void;
  /**
   * A queued send was confirmed stored, with the stored message. Fires just
   * before the entry leaves the outbox (and before the fan-out echo), so an
   * optimistic row can be swapped for the real one without flicker.
   */
  outboxSent: (event: { clientMessageId: string; room: string; message: SendMessageResult }) => void;
  /**
   * The SDK could not catch up a room's edits, deletes and reactions —
   * this client was away longer than the server's 7-day event log — so it
   * re-read the newest page of history instead. A view that keeps its own
   * copy of the conversation should replace it with `page`: anything it
   * holds may be stale in ways nothing can describe any more.
   */
  resync: (event: { roomId: string; page: MessagePage }) => void;
  connectionStateChanged: (state: ChatConnectionState) => void;
  connected: () => void;
  disconnected: () => void;
  reconnecting: (attempt: number) => void;
  reconnected: () => void;
  /**
   * Catch-up after a reconnect has finished.
   *
   * Anything it recovered has already been delivered through `message`, so
   * an app that just renders messages needs nothing here. It is worth
   * listening to for two things: `gap` says some messages could not be
   * recovered and the view should be reloaded, and `errors` says a room's
   * catch-up did not complete and will be retried on the next reconnect.
   */
  recovered: (summary: RecoverySummary) => void;
  error: (error: SwalvoChatError) => void;
}

export interface RecoverySummary {
  /** How many missed messages were delivered, across every room. */
  recovered: number;
  /**
   * How many missed edits, deletes, reactions and moderation events were
   * applied from the event log, across every room. They have already been
   * delivered through their usual events.
   */
  events: number;
  /** Rooms whose event log had expired, so history was re-read and a `resync` emitted. */
  resynced: string[];
  perRoom: RoomRecoveryResult[];
  /** True when at least one room had to restart from the newest page, skipping older messages. */
  gap: boolean;
  /** Rooms whose catch-up did not complete. They are retried on the next reconnect. */
  errors: RoomRecoveryResult[];
}

export interface ConnectOptions {
  /** Conversation to join: a `conv_...` id, its name, or an attached RTC room id. */
  room?: string;
  /** Join several at once. Merged with `room`. */
  rooms?: string[];
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The Swalvo Chat client.
 *
 * Nobody using this constructs a `WebSocket`, reconnects by hand, sees a
 * frame type, or ever finds out which gateway instance is holding their
 * socket (spec §2, §12). What you see here is the whole API: connect,
 * send, listen, plus the `messages` namespace for history and per-message
 * operations.
 */
export class ChatClient extends TypedEventEmitter<ChatEventMap> {
  /** History, editing, reactions, threads. Grouped to keep the top level small. */
  readonly messages: MessagesApi;
  /** Signed uploads and downloads. Bytes never go near the WebSocket. */
  readonly attachments: AttachmentsApi;
  /** Blocks, flags, and (for moderators) bans and mutes. */
  readonly moderation: ModerationApi;
  /** This user's conversations, with unread counts that keep themselves current. Call `inbox.load()` to start. */
  readonly inbox: Inbox;
  /**
   * Sends not yet confirmed stored: `list()`, `retry()`, `cancel()`.
   * `undefined` when the client was created with `outbox: false`.
   */
  readonly outbox?: Outbox;

  private readonly config: ResolvedChatClientConfig;
  private readonly logger: Logger;
  private readonly rest: RestClient;
  private transport?: SocketTransport;
  private readonly socketFactory?: WebSocketFactory;

  private state: ChatConnectionState = 'idle';
  private connectionId?: string;
  private currentUserId: string;
  private tokenExpiresAt: number;
  private tokenRefreshTimer?: ReturnType<typeof setTimeout>;

  /** Rooms the caller asked to be in. Re-joined automatically after a reconnect. */
  private readonly desiredRooms = new Set<string>();
  /** The presence the caller last asked for, re-asserted after a reconnect. See `setPresence`. */
  private desiredPresence?: PresenceStatus;
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  /** Resolves on the first `connected` frame, so `await connect()` genuinely means connected. */
  private connectPromise?: { resolve: () => void; reject: (error: unknown) => void };
  private hasConnectedBefore = false;
  /** Local stop-typing timers, so a dropped `typing.stop` can't leave someone stuck typing. */
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-room resume points and de-duplication. See internal/recovery.ts. */
  private readonly recovery: RecoveryTracker;
  /**
   * Live messages that arrived while a catch-up was still running, held
   * back so they cannot overtake the older messages being replayed.
   */
  private readonly pendingLive = new Map<string, ChatMessage[]>();
  private recovering = false;
  /** Per-room eventSeq ordering, de-duplication and gap filling. See internal/event-sequencer.ts. */
  private readonly sequencer: EventSequencer;
  /**
   * What the caller called a room -> the conversation's public id, learned
   * from join responses. A room can be joined by name or by an attached RTC
   * room id, but every frame and every resume point is keyed on the
   * `conv_…` id, and the two have to be matched up to recover it.
   */
  private readonly roomAliases = new Map<string, string>();
  /** Set from an audience token's `aud_room` claim (§6). */
  private audienceRoom?: string;

  /** @internal Use `createChatClient(config)`. The second parameter exists purely so tests can inject a fake socket. */
  constructor(config: ResolvedChatClientConfig, socketFactory?: WebSocketFactory) {
    super();
    this.config = config;
    this.logger = createLogger(config.logLevel);
    this.rest = new RestClient(config.apiUrl, config.token);
    this.socketFactory = socketFactory;
    this.messages = new MessagesApi(
      this.rest,
      () => this.defaultRoom(),
      (options) => this.sendMessage(options),
      (page) => this.recovery.observeHistory(page.data),
    );
    this.attachments = new AttachmentsApi(this.rest, () => this.defaultRoom());
    this.moderation = new ModerationApi(
      this.rest,
      () => this.defaultRoom(),
      (type, payload) => this.request(type, payload),
    );

    const payload = decodeChatToken(config.token);
    this.currentUserId = payload.sub;
    this.tokenExpiresAt = payload.exp * 1000;
    this.audienceRoom = payload.aud_room || undefined;

    this.inbox = new Inbox({
      query: (options) => this.queryMyConversations(options),
      userId: () => this.currentUserId,
      joinRoom: (room) => this.joinRoom(room),
      listen: (handlers) => {
        const subscriptions = [
          this.on('message', handlers.message),
          this.on('read', handlers.read),
          this.on('removedFromRoom', (event) => handlers.removed(event.roomId)),
          this.on('reconnected', handlers.reconnected),
        ];
        return () => subscriptions.forEach((unsubscribe) => unsubscribe());
      },
      logger: this.logger,
    });

    if (config.outbox !== false) {
      this.outbox = new Outbox({
        storage: config.outbox.storage ?? new MemoryOutboxStorage(),
        userId: () => this.currentUserId,
        transmit: (entry) => this.transmit(entry),
        isConnected: () => this.state === 'connected',
        onChange: (entries) => this.emit('outboxChanged', entries),
        onSent: (entry, message) =>
          this.emit('outboxSent', { clientMessageId: entry.clientMessageId, room: entry.room, message }),
        logger: this.logger,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
    }

    this.sequencer = new EventSequencer({
      fetchEvents: (room, afterEventSeq, limit) => this.fetchEvents(room, afterEventSeq, limit),
      apply: (frame) => this.dispatchConversationEvent(frame),
      onExpired: (room) => this.resyncRoom(room),
      logger: this.logger,
      isConnected: () => this.state === 'connected',
      maxAttempts: 3,
      retryDelayMs: (attempt) => Math.min(500 * 2 ** (attempt - 1), 5_000),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      gapFillDelayMs: config.gapFillDelayMs,
    });

    this.recovery = new RecoveryTracker({
      // Deliberately the same public, authorized history call an
      // application would make. Recovery has no privileged path into the
      // store, so a room the token cannot read cannot be recovered either.
      listMessages: (options) => this.messages.listRaw(options),
      deliver: (message) => this.emit('message', message),
      logger: this.logger,
      isConnected: () => this.state === 'connected',
      maxAttempts: 3,
      retryDelayMs: (attempt) => Math.min(500 * 2 ** (attempt - 1), 5_000),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  }

  /** Who this client speaks as, read from the token. You can't set it from here. */
  get userId(): string {
    return this.currentUserId;
  }

  get connectionState(): ChatConnectionState {
    return this.state;
  }

  /** Stable for the life of one socket, changes on reconnect. Worth quoting in a bug report. */
  get id(): string | undefined {
    return this.connectionId;
  }

  /** Rooms this client is currently joined to. */
  get rooms(): string[] {
    return Array.from(this.desiredRooms);
  }

  /**
   * True for a live-stream audience token (§6): this user is a viewer of
   * one `broadcast_audience` conversation, not a member of it. Viewers can
   * read and post; member-only features — the inbox, read receipts, push —
   * do not apply and their calls are refused locally.
   */
  get isAudienceViewer(): boolean {
    return this.audienceRoom !== undefined;
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /**
   * Opens the connection and joins the rooms you asked for. Resolves once
   * the server has authenticated the socket, not merely when TCP came up,
   * so a resolved `connect()` really does mean you can send.
   */
  async connect(options: ConnectOptions = {}): Promise<void> {
    for (const room of [...(options.room ? [options.room] : []), ...(options.rooms ?? [])]) {
      this.desiredRooms.add(room);
    }
    // An audience token names its one conversation, so there is nothing
    // to ask the viewer's app for.
    if (this.audienceRoom && this.desiredRooms.size === 0) {
      this.desiredRooms.add(this.audienceRoom);
    }

    if (this.state === 'connected') {
      // Already up. Just make sure the newly-requested rooms get joined.
      await this.syncRooms();
      return;
    }

    this.setState('connecting');
    this.transport = new SocketTransport(
      {
        url: this.config.chatUrl,
        token: this.config.token,
        sdkVersion: CHAT_SDK_VERSION,
        autoReconnect: this.config.autoReconnect,
        maxReconnectAttempts: this.config.maxReconnectAttempts,
        initialReconnectDelayMs: this.config.initialReconnectDelayMs,
        maxReconnectDelayMs: this.config.maxReconnectDelayMs,
        logger: this.logger,
        socketFactory: this.socketFactory,
      },
      {
        onOpen: () => this.logger.debug('socket open, waiting for server hello'),
        onFrame: (frame) => this.handleFrame(frame),
        onClose: (info) => this.handleClose(info),
        onReconnecting: (attempt) => {
          this.setState('reconnecting');
          this.emit('reconnecting', attempt);
        },
        onError: (error) => this.fail(error),
      },
    );

    const connected = new Promise<void>((resolve, reject) => {
      this.connectPromise = { resolve, reject };
    });

    this.transport.connect();
    await connected;
    await this.syncRooms();
    // Whatever a previous session (or the time before this connect) left
    // queued goes out now, oldest first.
    void this.outbox?.flush();
  }

  /** Closes the connection. No reconnect; call `connect()` again to come back. */
  async disconnect(): Promise<void> {
    this.clearTokenRefreshTimer();
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();

    // Reject anything still waiting, rather than leave callers hanging on
    // a promise that can never resolve now.
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new SwalvoChatConnectionError('Connection closed before the server replied', 'CONNECTION_CLOSED'));
    }
    this.pending.clear();

    // A connect() still in flight needs the same treatment: SocketTransport
    // detaches the socket's own onclose handler before closing it (so the
    // close doesn't re-trigger reconnect logic), which means handleClose —
    // the only other place connectPromise gets settled — never runs for an
    // explicit disconnect. Without this, calling disconnect() while connect()
    // awaits the server hello hangs that connect() forever.
    this.connectPromise?.reject(
      new SwalvoChatConnectionError('Connection closed before the server replied', 'CONNECTION_CLOSED'),
    );
    this.connectPromise = undefined;

    this.transport?.disconnect();
    this.transport = undefined;
    this.connectionId = undefined;
    // Buffered live messages belong to a catch-up that will never finish
    // now. The resume points stay: an explicit disconnect followed by
    // connect() should still recover what was missed in between.
    this.pendingLive.clear();
    this.recovering = false;
    this.sequencer.pause();
    this.setState('disconnected');
  }

  /**
   * Force a reconnect right now. Rarely needed, since the SDK reconnects
   * on its own, but handy when the app knows the network changed (an
   * `online` event, say) and doesn't fancy waiting out the backoff.
   *
   * Literally a `disconnect()` followed by a `connect()`, rather than its
   * own teardown. It used to have one, and that copy had drifted: it
   * dropped the transport but left `state` on `'connected'`, so the
   * `connect()` on the next line took its already-up early return, found
   * nothing to reconnect, and returned happily. The client was then
   * permanently deaf — state `'connected'`, no socket, no error, no
   * messages ever again — and the only way to notice was that nothing
   * arrived. It also leaked the token-refresh and typing timers and left
   * in-flight requests hanging until their own timeouts.
   *
   * Deferring to `disconnect()` means there is one teardown to be correct
   * about instead of two to keep in step. Resume points survive it, so the
   * new connection still catches up on whatever was missed.
   */
  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  async joinRoom(room: string): Promise<void> {
    this.desiredRooms.add(room);
    if (this.state === 'connected') {
      this.onJoined(room, await this.request('room.join', { room }));
    }
  }

  async leaveRoom(room: string): Promise<void> {
    this.desiredRooms.delete(room);
    // Deliberately leaving on purpose is not an outage: drop the resume
    // point so re-joining later starts fresh rather than replaying
    // everything said while the caller was deliberately not listening.
    const resolved = this.resolveRoom(room);
    this.recovery.forget(resolved);
    this.sequencer.forget(resolved);
    this.pendingLive.delete(resolved);
    this.roomAliases.delete(room);
    if (this.state === 'connected') {
      await this.request('room.leave', { room });
    }
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /**
   * Sends a message and resolves with the stored one: canonical server id,
   * canonical timestamp. It only resolves after Swalvo has durably stored
   * it, so a resolved promise really does mean saved (spec §15).
   *
   * If you don't supply a `clientMessageId` we attach one, and that's what
   * makes retrying after a reconnect safe (spec §16).
   */
  async sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
    const room = options.room ?? this.defaultRoom();
    if (options.mentions && options.mentions.length > MAX_MENTIONS) {
      throw new SwalvoMessageError(`A message can mention at most ${MAX_MENTIONS} users`, 'INVALID_MESSAGE');
    }

    const entry = {
      clientMessageId: options.clientMessageId ?? generateClientMessageId(),
      room,
      text: options.text,
      type: options.type,
      replyTo: options.replyTo,
      attachmentId: options.attachmentId,
      metadata: options.metadata,
      mentions: options.mentions,
    };

    if (!this.outbox) {
      return this.transmit(entry);
    }

    // Through the outbox, so a send the connection drops is re-sent on
    // reconnect instead of lost. The promise still settles on *this*
    // attempt: a connectivity failure rejects with `error.queued === true`
    // and the message goes out later on its own (see Outbox).
    try {
      return await this.outbox.enqueueAndSend(entry);
    } catch (error) {
      if (error instanceof SwalvoChatError) this.moderation.observeRefusal(this.resolveRoom(room), error.code);
      throw error;
    }
  }

  /**
   * One attempt at putting a message on the wire. The socket when it is up;
   * HTTP when it is not — the message still gets stored and fanned out to
   * everyone else, and losing a connection should not quietly lose whatever
   * the user just typed.
   */
  private async transmit(
    entry: Omit<OutboxEntry, 'userId' | 'createdAt' | 'status' | 'attempts'>,
  ): Promise<SendMessageResult> {
    if (this.state !== 'connected') {
      const stored = await this.rest.request<SendMessageResult>(
        `/v1/chat/conversations/${encodeURIComponent(entry.room)}/messages`,
        {
          method: 'POST',
          body: {
            text: entry.text,
            type: entry.type,
            replyTo: entry.replyTo,
            clientMessageId: entry.clientMessageId,
            attachmentId: entry.attachmentId,
            metadata: entry.metadata,
            mentions: entry.mentions,
          },
        },
      );
      return normalizeMessage(stored);
    }

    const ack = await this.request<{ message: SendMessageResult; deduplicated: boolean }>('message.send', {
      room: entry.room,
      text: entry.text,
      messageType: entry.type,
      replyTo: entry.replyTo,
      clientMessageId: entry.clientMessageId,
      attachmentId: entry.attachmentId,
      metadata: entry.metadata,
      mentions: entry.mentions,
      clientSentAt: Date.now(),
    });

    return { ...normalizeMessage(ack.message), deduplicated: ack.deduplicated };
  }

  // -------------------------------------------------------------------------
  // Typing / presence / read
  // -------------------------------------------------------------------------

  /**
   * Signals that this user is typing. Call it on every keystroke; it's
   * fine. The server only broadcasts on the transition *into* typing, and
   * this arms a local timer to stop it automatically, so someone who
   * wanders off mid-sentence doesn't sit there "typing…" forever
   * (spec §21).
   */
  async startTyping(room?: string): Promise<void> {
    const target = room ?? this.defaultRoom();
    this.send('typing.start', { room: target });

    const existing = this.typingTimers.get(target);
    if (existing) clearTimeout(existing);
    this.typingTimers.set(
      target,
      setTimeout(() => void this.stopTyping(target).catch(() => undefined), 5_000),
    );
  }

  async stopTyping(room?: string): Promise<void> {
    const target = room ?? this.defaultRoom();
    const timer = this.typingTimers.get(target);
    if (timer) {
      clearTimeout(timer);
      this.typingTimers.delete(target);
    }
    this.send('typing.stop', { room: target });
  }

  /** Marks this message, and everything before it, as read. */
  async markAsRead(messageId: string): Promise<ReadState> {
    this.assertMember('Read receipts');
    const state =
      this.state === 'connected'
        ? await this.request<ReadState>('read.mark', { messageId })
        : await this.rest.request<ReadState>(`/v1/chat/messages/${encodeURIComponent(messageId)}/read`, {
            method: 'POST',
          });
    if (state && typeof state.roomId === 'string') this.inbox.applyReadState(state);
    return state;
  }

  /**
   * Sets presence across every room this connection is holding.
   *
   * Remembered and re-asserted on every reconnect. Presence is socket
   * state, so the new socket a reconnect opens knows nothing of what was
   * set on the old one — without this, a client that survived a blip
   * stayed silently invisible to everybody else for the rest of the
   * session.
   */
  async setPresence(status: PresenceStatus): Promise<void> {
    this.desiredPresence = status;
    this.send('presence.set', { status });
  }

  /**
   * Who is present in a room right now. In a large room (§6) this is the
   * first page of the roster only; use `listPresence()` to walk the rest.
   */
  async getPresence(room?: string): Promise<Array<{ userId: string; status: PresenceStatus }>> {
    return (await this.listPresence({ room })).data;
  }

  /** One page of a room's presence roster, at most 200 per page. */
  async listPresence(options: { room?: string; cursor?: string | null; limit?: number } = {}): Promise<PresencePage> {
    const target = options.room ?? this.defaultRoom();
    const response = await this.rest.request<unknown>(`/v1/chat/conversations/${encodeURIComponent(target)}/presence`, {
      query: { cursor: options.cursor ?? undefined, limit: options.limit },
    });
    const data = listOf(response, ['data', 'presence']).map((entry): PresenceEntry => ({
      userId: String(entry.userId),
      status: entry.status as PresenceStatus,
    }));
    const nextCursor =
      response && typeof response === 'object' && !Array.isArray(response)
        ? ((response as { nextCursor?: string | null }).nextCursor ?? null)
        : null;
    return { data, nextCursor };
  }

  // -------------------------------------------------------------------------
  // Inbox (§2)
  // -------------------------------------------------------------------------

  /**
   * One page of this user's conversations, newest activity first, each with
   * its unread count and last message. For a list that keeps itself up to
   * date, use `chat.inbox` instead — it is built on this.
   */
  async queryMyConversations(options: QueryConversationsOptions = {}): Promise<InboxPage> {
    this.assertMember('The inbox');
    const page = await this.rest.request<InboxPage>('/v1/chat/me/conversations', {
      query: { limit: options.limit, cursor: options.cursor ?? undefined },
    });
    return {
      conversations: (page?.conversations ?? []).map(normalizeRow),
      nextCursor: page?.nextCursor ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Push (§4)
  // -------------------------------------------------------------------------

  /**
   * Registers this device for push. Safe to call on every app start: it is
   * an upsert keyed on the token, and re-binds a token that last belonged
   * to another user on this device (a shared tablet, a sign-out/sign-in) to
   * this one.
   */
  async registerDevice(options: RegisterDeviceOptions): Promise<ChatDevice> {
    this.assertMember('Push notifications');
    return this.rest.request<ChatDevice>('/v1/chat/me/devices', {
      method: 'POST',
      body: {
        provider: options.provider,
        token: options.token,
        platform: options.platform,
        appBundleId: options.appBundleId,
      },
    });
  }

  /** Stops pushes to this device token. Call it on sign-out. */
  async unregisterDevice(token: string): Promise<void> {
    await this.rest.request(`/v1/chat/me/devices/${encodeURIComponent(token)}`, { method: 'DELETE' });
  }

  async listDevices(): Promise<ChatDevice[]> {
    const response = await this.rest.request<unknown>('/v1/chat/me/devices');
    return listOf(response, ['devices', 'data']) as unknown as ChatDevice[];
  }

  /**
   * Which messages in a room push this user: `all` (the default),
   * `mentions` (only messages that mention them), or `none`.
   */
  async setNotificationLevel(room: string, level: NotificationLevel): Promise<NotificationPreferences> {
    return this.updateMemberPreferences(room, { notifications: level });
  }

  /**
   * Mutes a conversation for this user: no pushes, and its unread count
   * stops contributing to the inbox badge. Not a moderator mute — this user
   * can still post.
   */
  async muteConversation(room: string, muted = true): Promise<NotificationPreferences> {
    return this.updateMemberPreferences(room, { muted });
  }

  private async updateMemberPreferences(
    room: string,
    changes: { notifications?: NotificationLevel; muted?: boolean },
  ): Promise<NotificationPreferences> {
    this.assertMember('Notification preferences');
    const response = await this.rest.request<(Partial<NotificationPreferences> & { muted?: boolean }) | undefined>(
      `/v1/chat/me/conversations/${encodeURIComponent(room)}`,
      { method: 'PATCH', body: changes },
    );
    const muted = response?.muted ?? changes.muted ?? false;
    const preferences: NotificationPreferences = {
      roomId: response?.roomId ?? (response as { id?: string } | undefined)?.id ?? this.resolveRoom(room),
      notifications: response?.notifications ?? changes.notifications ?? (muted ? 'none' : 'all'),
      muted,
    };
    this.inbox.applyPreferences(preferences);
    return preferences;
  }

  /** This user's read position and unread count for a room. */
  async getReadState(room?: string): Promise<ReadState> {
    const target = room ?? this.defaultRoom();
    return this.rest.request(`/v1/chat/conversations/${encodeURIComponent(target)}/read-state`);
  }

  /** Everyone's read position. This is what a "seen by" row is built from. */
  async getReadReceipts(room?: string): Promise<ReadState[]> {
    const target = room ?? this.defaultRoom();
    return this.rest.request(`/v1/chat/conversations/${encodeURIComponent(target)}/read-receipts`);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private defaultRoom(): string {
    const first = this.desiredRooms.values().next();
    if (first.done) {
      throw new SwalvoRoomError(
        'No room selected; pass { room } to connect(), or a `room` option on this call',
        'NOT_IN_ROOM',
      );
    }
    return first.value;
  }

  /** The conversation's public id for whatever the caller called it, once a join has told us. */
  private resolveRoom(room: string): string {
    return this.roomAliases.get(room) ?? room;
  }

  /** Remembers what a join told us: the room's public id, and (when the server says) its event head. */
  private onJoined(alias: string, response: unknown): void {
    if (!response || typeof response !== 'object') return;
    const joined = response as { room?: unknown; eventSeq?: unknown; lastEventSeq?: unknown };
    if (typeof joined.room === 'string' && joined.room.length > 0) {
      this.roomAliases.set(alias, joined.room);
      this.sequencer.baseline(joined.room, joined.lastEventSeq ?? joined.eventSeq);
    }
  }

  /** Member-only features have nothing to talk to for an audience viewer (§6). Fail fast and say why. */
  private assertMember(feature: string): void {
    if (this.audienceRoom) {
      throw new SwalvoChatPermissionError(
        `${feature} are for conversation members; this is a live-stream audience token`,
        'NOT_A_MEMBER',
      );
    }
  }

  private fetchEvents(room: string, afterEventSeq: string, limit: number): Promise<ChatEventPage> {
    return this.rest.request<ChatEventPage>(`/v1/chat/conversations/${encodeURIComponent(room)}/events`, {
      query: { afterEventSeq, limit },
    });
  }

  /**
   * The event log no longer reaches this room's resume point. Re-read the
   * newest page of history and hand it to the app as the new truth.
   */
  private async resyncRoom(room: string): Promise<void> {
    const page = await this.messages.listRaw({ room, limit: RESYNC_PAGE_SIZE });
    this.recovery.observeHistory(page.data);
    this.emit('resync', { roomId: room, page });
  }

  private setState(state: ChatConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('connectionStateChanged', state);
  }

  private send(type: string, payload: Record<string, unknown>): void {
    if (!this.transport?.isOpen) {
      // Typing and presence are ephemeral by nature. Queue them up to
      // replay after a reconnect and you deliver stale signals, so they get
      // dropped on purpose instead of buffered.
      this.logger.debug(`dropped ${type}; not connected`);
      return;
    }
    this.transport.send({ type, ...payload });
  }

  /** Sends a frame and waits for its correlated ack, with a timeout. */
  private request<T = unknown>(type: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.transport?.isOpen) {
      return Promise.reject(new SwalvoChatConnectionError('Not connected; call connect() first', 'CONNECTION_CLOSED'));
    }

    const id = `r${++this.requestCounter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SwalvoChatConnectionError('The server did not respond in time', 'TIMEOUT'));
      }, this.config.requestTimeoutMs);

      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      try {
        this.transport!.send({ type, id, ...payload });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const type = String(frame.type);

    switch (type) {
      case 'connected':
        this.onServerHello(frame);
        return;

      case 'ack': {
        const request = this.takePending(frame.id);
        request?.resolve(frame.data);
        return;
      }

      case 'error': {
        const error = toSwalvoChatError(frame.code as string, String(frame.message ?? 'Chat request failed'), {
          retryAfterSeconds: frame.retryAfterSeconds as number | undefined,
          reason: frame.reason as string | undefined,
          scope: frame.scope as string | undefined,
        });
        const request = this.takePending(frame.id);
        if (request) {
          // This correlates to a call the developer made, so reject their
          // promise instead of firing a global error they can't trace back.
          request.reject(error);
          return;
        }
        // The gateway's "you were removed from this conversation": an
        // uncorrelated NOT_A_MEMBER naming the room. Stop rejoining it.
        if (error.code === 'NOT_A_MEMBER' && typeof frame.room === 'string') {
          this.onRemovedFromRoom(frame.room, 'REMOVED');
        }
        this.emit('error', error);
        return;
      }

      case 'room.joined':
      case 'room.left': {
        const request = this.takePending(frame.id);
        if (request) {
          request.resolve(frame);
          return;
        }
        // A `room.left` nobody asked for: the server took this user out —
        // banned (§3.2), most likely.
        if (type === 'room.left' && typeof frame.room === 'string') {
          this.onRemovedFromRoom(frame.room, String(frame.reason ?? 'REMOVED'));
        }
        return;
      }

      case 'presence.count':
        this.emit('presenceCount', {
          roomId: String(frame.room ?? frame.roomId),
          online: Number(frame.online ?? 0),
        });
        return;

      case 'message':
      case 'message.updated':
      case 'message.deleted':
      case 'message.pinned':
      case 'message.unpinned':
      case 'reaction.added':
      case 'reaction.removed':
      case 'member.banned':
      case 'member.unbanned':
      case 'member.muted':
      case 'member.unmuted':
        // Conversation events carry an eventSeq (§1). The sequencer applies
        // them in order, drops ones already applied, and backfills holes;
        // a frame without one goes straight through.
        this.sequencer.ingest(roomOf(frame), frame);
        return;

      case 'typing.started':
      case 'typing.stopped':
        this.emit('typing', {
          userId: String(frame.userId),
          roomId: String(frame.roomId),
          isTyping: type === 'typing.started',
        });
        return;

      case 'presence':
        this.emit('presence', {
          userId: String(frame.userId),
          roomId: String(frame.roomId),
          status: frame.status as PresenceStatus,
          at: String(frame.at),
        });
        return;

      case 'read':
        this.emit('read', {
          userId: String(frame.userId),
          roomId: String(frame.roomId),
          messageId: (frame.messageId as string | null) ?? null,
          at: String(frame.at),
        });
        return;

      case 'pong':
        return;

      default:
        // Forward compatibility. A newer server may send frames this
        // version has never heard of, and ignoring them beats throwing on
        // an upgrade nobody asked for.
        this.logger.debug(`ignoring unknown frame "${type}"`);
    }
  }

  /**
   * Applies one conversation event, live or replayed from the event log.
   * The sequencer has already decided it is new and in order.
   */
  private dispatchConversationEvent(frame: Record<string, unknown>): void {
    const type = String(frame.type);
    switch (type) {
      case 'message':
        if (frame.message && typeof frame.message === 'object') {
          this.onLiveMessage(normalizeMessage(frame.message as ChatMessage));
        }
        return;

      case 'message.updated':
        if (frame.message && typeof frame.message === 'object') {
          this.emit('messageUpdated', normalizeMessage(frame.message as ChatMessage), {
            reason: typeof frame.reason === 'string' ? frame.reason : undefined,
          });
        }
        return;

      case 'message.deleted':
        this.emit('messageDeleted', {
          messageId: String(frame.messageId),
          roomId: String(frame.roomId ?? frame.room),
          deletedAt: String(frame.deletedAt),
          deletedBy: (frame.deletedBy as string | null) ?? null,
        });
        return;

      case 'message.pinned':
      case 'message.unpinned': {
        const message =
          frame.message && typeof frame.message === 'object' ? normalizeMessage(frame.message as ChatMessage) : null;
        const event: MessagePinEvent = {
          roomId: roomOf(frame),
          messageId: String(frame.messageId ?? message?.id ?? ''),
          message,
          by: (frame.by as string | undefined) ?? (frame.pinnedBy as string | undefined) ?? null,
          at: (frame.at as string | undefined) ?? (frame.pinnedAt as string | undefined) ?? null,
        };
        this.emit(type === 'message.pinned' ? 'messagePinned' : 'messageUnpinned', event);
        return;
      }

      case 'reaction.added':
      case 'reaction.removed': {
        const event: ReactionEvent = {
          messageId: String(frame.messageId),
          roomId: String(frame.roomId ?? frame.room),
          userId: String(frame.userId),
          emoji: String(frame.emoji),
          at: String(frame.at),
        };
        this.emit(type === 'reaction.added' ? 'reactionAdded' : 'reactionRemoved', event);
        return;
      }

      case 'member.banned':
      case 'member.unbanned':
      case 'member.muted':
      case 'member.unmuted': {
        const event: MemberModerationEvent = {
          roomId: roomOf(frame),
          userId: String(frame.userId),
          by: (frame.by as string | undefined) ?? null,
          expiresAt: (frame.expiresAt as string | undefined) ?? null,
        };
        const kind = type.slice('member.'.length) as 'banned' | 'unbanned' | 'muted' | 'unmuted';
        if (event.userId === this.currentUserId) this.moderation.observe(kind, event);
        const name = (
          {
            banned: 'memberBanned',
            unbanned: 'memberUnbanned',
            muted: 'memberMuted',
            unmuted: 'memberUnmuted',
          } as const
        )[kind];
        this.emit(name, event);
        return;
      }

      default:
        this.logger.debug(`ignoring unknown conversation event "${type}"`);
    }
  }

  /**
   * The server removed this user from a room. Forget it entirely: re-joining
   * it on the next reconnect would only be refused, and every refusal is an
   * `error` the app has to explain.
   */
  private onRemovedFromRoom(room: string, reason: string): void {
    for (const alias of Array.from(this.desiredRooms)) {
      if (alias === room || this.roomAliases.get(alias) === room) {
        this.desiredRooms.delete(alias);
        this.roomAliases.delete(alias);
      }
    }
    this.recovery.forget(room);
    this.sequencer.forget(room);
    this.pendingLive.delete(room);
    if (reason === 'BANNED') {
      this.moderation.observe('banned', { roomId: room, userId: this.currentUserId, by: null, expiresAt: null });
    }
    this.emit('removedFromRoom', { roomId: room, reason });
  }

  private onServerHello(frame: Record<string, unknown>): void {
    this.connectionId = frame.connectionId as string;
    const wasReconnecting = this.hasConnectedBefore;
    this.hasConnectedBefore = true;

    this.setState('connected');
    this.scheduleTokenRefresh(frame.expiresAt as string | undefined);

    this.connectPromise?.resolve();
    this.connectPromise = undefined;

    if (wasReconnecting) {
      // Hold every sequenced frame for rooms with a resume point until the
      // catch-up has read what came before them. Decided *before* the
      // rejoins, because the first live frames arrive the moment a join is
      // processed.
      const sequencedRooms = this.sequencedRoomsToSync();
      this.sequencer.beginSync(sequencedRooms);

      // Re-join whatever rooms the caller asked for — the new socket knows
      // nothing about the old one's subscriptions — and then replay
      // whatever arrived while this client was away: messages first, then
      // the edits, deletes, reactions and moderation events around them.
      void this.syncRooms()
        .then(() => {
          this.emit('reconnected');
          return this.recoverMissedMessages(sequencedRooms);
        })
        .catch((error) => {
          // Never leave frames held behind a catch-up that is not coming.
          for (const room of sequencedRooms) void this.sequencer.catchUp(room);
          this.logger.warn(`reconnect handling failed: ${String(error)}`);
        })
        .finally(() => void this.outbox?.flush());
    } else {
      this.emit('connected');
    }
  }

  private handleClose(info: { code: number; reason: string; willReconnect: boolean; terminal: boolean }): void {
    this.connectionId = undefined;

    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new SwalvoChatConnectionError('Connection closed before the server replied', 'CONNECTION_CLOSED'));
    }
    this.pending.clear();

    if (info.willReconnect) {
      this.setState('reconnecting');
      return;
    }

    // `failed` is reserved for "retrying can't fix this": a rejected token,
    // or a reconnect ladder that ran out of rungs. An ordinary close is
    // `disconnected`, and to a developer those are different things.
    this.setState(info.terminal ? 'failed' : 'disconnected');
    this.emit('disconnected');
    // A connect() still in flight mustn't hang forever on a socket that's
    // never coming up.
    this.connectPromise?.reject(
      new SwalvoChatConnectionError(`Chat connection closed (${info.code})`, 'CONNECTION_CLOSED'),
    );
    this.connectPromise = undefined;
  }

  private fail(error: SwalvoChatError): void {
    this.setState('failed');
    this.connectPromise?.reject(error);
    this.connectPromise = undefined;
    this.emit('error', error);
  }

  /**
   * Every live message goes through here rather than straight to the
   * application, for two reasons.
   *
   * **De-duplication.** A message can legitimately arrive twice: once over
   * the socket just before it dropped, and again in the catch-up that
   * re-reads that window from history. The application must see it once.
   *
   * **Ordering.** While a catch-up is replaying older messages, a live one
   * arriving would otherwise be delivered ahead of them, and a sender's
   * messages would reach the application out of order — which is the one
   * ordering guarantee Swalvo actually makes. So live messages are held
   * until the replay finishes, then flushed in arrival order.
   */
  private onLiveMessage(message: ChatMessage): void {
    if (this.recovering) {
      const queued = this.pendingLive.get(message.roomId);
      if (queued) {
        queued.push(message);
      } else {
        this.pendingLive.set(message.roomId, [message]);
      }
      return;
    }

    if (this.recovery.accept(message)) {
      this.emit('message', message);
    }
  }

  /**
   * Replays what each room missed while this client was disconnected.
   *
   * Rooms are recovered concurrently and independently: they have separate
   * resume points, and one room failing — or being unreadable by this
   * token — must not hold up the others.
   *
   * Runs after `syncRooms()`, so the socket is already subscribed before
   * the catch-up starts. Anything that arrives during the catch-up is
   * buffered rather than dropped, which is what closes the window between
   * "history read" and "live again".
   */
  private async recoverMissedMessages(sequencedRooms: string[] = []): Promise<void> {
    const rooms = Array.from(new Set(Array.from(this.desiredRooms).map((room) => this.resolveRoom(room)))).filter(
      (room) => this.recovery.has(room),
    );

    let perRoom: RoomRecoveryResult[] = [];
    if (rooms.length === 0) {
      // Nothing was ever delivered in these rooms, so there is no resume
      // point and no message to catch up on. Still flush, in case a live
      // message arrived while we were deciding, and still report — an app
      // waiting on `recovered` to re-enable its UI must not hang just
      // because there happened to be nothing to recover.
      this.flushPendingLive();
    } else {
      this.recovering = true;
      try {
        perRoom = await Promise.all(rooms.map((room) => this.recovery.recoverRoom(room)));
      } finally {
        // Always release the buffer, even if a catch-up threw. Holding live
        // messages back forever would be a far worse failure than delivering
        // them slightly out of order.
        this.recovering = false;
        this.flushPendingLive();
      }
    }

    // Then everything else that happened while away: edits, deletes,
    // reactions, pins, bans. After the messages, so an edit always finds the
    // message it edits already delivered.
    const eventResults: EventCatchUpResult[] = await Promise.all(
      sequencedRooms.map((room) => this.sequencer.catchUp(room)),
    );
    const eventErrors = eventResults.filter((result) => result.error !== undefined);
    for (const result of eventErrors) {
      const existing = perRoom.find((entry) => entry.room === result.room);
      if (existing) {
        existing.error = existing.error ?? result.error;
      } else {
        perRoom.push({ room: result.room, recovered: 0, gap: false, error: result.error });
      }
    }

    const summary: RecoverySummary = {
      recovered: perRoom.reduce((total, result) => total + result.recovered, 0),
      events: eventResults.reduce((total, result) => total + result.applied, 0),
      resynced: eventResults.filter((result) => result.expired).map((result) => result.room),
      perRoom,
      gap: perRoom.some((result) => result.gap) || eventResults.some((result) => result.expired),
      errors: perRoom.filter((result) => result.error !== undefined),
    };

    if (summary.recovered > 0 || summary.events > 0 || summary.gap || summary.errors.length > 0) {
      this.logger.info(
        `recovered ${summary.recovered} missed message(s) and ${summary.events} event(s)` +
          (summary.gap ? ' (with a gap)' : '') +
          (summary.errors.length > 0 ? `; ${summary.errors.length} room(s) incomplete` : ''),
      );
    }
    this.emit('recovered', summary);
  }

  /** Rooms the caller still wants and the sequencer can resume. */
  private sequencedRoomsToSync(): string[] {
    const wanted = new Set(Array.from(this.desiredRooms).map((room) => this.resolveRoom(room)));
    return this.sequencer.knownRooms().filter((room) => wanted.has(room));
  }

  /** Delivers messages that arrived mid-catch-up, in the order they came in. */
  private flushPendingLive(): void {
    if (this.pendingLive.size === 0) return;
    const buffered = Array.from(this.pendingLive.values()).flat();
    this.pendingLive.clear();
    for (const message of buffered) {
      // De-duplicated against the catch-up, which may already have
      // delivered the very same message from history.
      if (this.recovery.accept(message)) {
        this.emit('message', message);
      }
    }
  }

  private async syncRooms(): Promise<void> {
    // Presence belongs to the socket, and this may be a new one. Re-sent
    // before the rooms rather than after, so the server has this
    // connection's status in hand for the joins it is about to process
    // instead of briefly listing the user as absent from a room they are
    // demonstrably in. A no-op until something has actually called
    // setPresence: re-asserting a status nobody chose would be inventing one.
    if (this.desiredPresence) {
      this.send('presence.set', { status: this.desiredPresence });
    }

    for (const room of Array.from(this.desiredRooms)) {
      try {
        this.onJoined(room, await this.request('room.join', { room }));
      } catch (error) {
        // One unauthorized room mustn't stop the rest from joining.
        this.emit('error', error instanceof SwalvoChatError ? error : toSwalvoChatError(undefined, String(error)));
      }
    }
  }

  /**
   * Refreshes the token shortly before it expires, assuming the app gave us
   * a way to fetch a new one. Without `onTokenExpiring` the socket just
   * closes at expiry. Correct, but abrupt, which is why this exists.
   */
  private scheduleTokenRefresh(expiresAt?: string): void {
    this.clearTokenRefreshTimer();
    if (!this.config.onTokenExpiring) return;

    const expiry = expiresAt ? Date.parse(expiresAt) : this.tokenExpiresAt;
    // A minute of headroom, never less than five seconds out, so a
    // short-lived token can't schedule its refresh in the past.
    const refreshAt = Math.max(expiry - 60_000, Date.now() + 5_000);

    this.tokenRefreshTimer = setTimeout(() => {
      void (async () => {
        try {
          const token = await this.config.onTokenExpiring!();
          const payload = decodeChatToken(token);
          this.currentUserId = payload.sub;
          this.tokenExpiresAt = payload.exp * 1000;
          this.rest.setToken(token);
          this.transport?.setToken(token);
          await this.reconnect();
        } catch (error) {
          this.emit(
            'error',
            error instanceof SwalvoChatError
              ? error
              : toSwalvoChatError('TOKEN_EXPIRED', 'Could not refresh the chat token'),
          );
        }
      })();
    }, refreshAt - Date.now());
  }

  private clearTokenRefreshTimer(): void {
    if (this.tokenRefreshTimer !== undefined) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }
  }

  private takePending(id: unknown): PendingRequest | undefined {
    if (typeof id !== 'string') return undefined;
    const request = this.pending.get(id);
    if (!request) return undefined;
    clearTimeout(request.timer);
    this.pending.delete(id);
    return request;
  }
}

/**
 * Creates a chat client from a token your backend minted. The token already
 * carries the endpoint, the user identity and the permissions, which is why
 * it's usually the only argument you need.
 */
export function createChatClient(config: ChatClientConfig): ChatClient {
  return new ChatClient(validateConfig(config));
}

/** §5: the server refuses more, so refuse locally rather than queue a send that can never succeed. */
const MAX_MENTIONS = 50;
/** How much history to re-read when a room's event log has expired. */
const RESYNC_PAGE_SIZE = 50;

/** The conversation a frame belongs to: its public id, wherever this frame type keeps it. */
function roomOf(frame: Record<string, unknown>): string {
  const message = frame.message as { roomId?: unknown } | undefined;
  return String(frame.roomId ?? frame.room ?? message?.roomId ?? '');
}

/** Distinct enough to work as an idempotency key, cheap enough for the hot path. */
function generateClientMessageId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `cm_${random}`;
}

export type { Unsubscribe, SwalvoMessageError };
