import type { SwalvoHttpClient } from '../http-client';
import type {
  ChatConversation,
  ChatMember,
  ChatMessage,
  ChatMessagePage,
  CreateChatTokenParams,
  CreateConversationParams,
  IssuedChatToken,
  ListChatMessagesParams,
  SendChatMessageParams,
} from '../types';

/**
 * Swalvo Chat, server-side (Phase 12).
 *
 * `tokens.create()` is the method that matters; the whole security model
 * rests on it. Your backend authenticates the user *its* way, then asks
 * Swalvo for a short-lived token scoped to that one user, and only that
 * token ever reaches the browser. The project API key never does.
 *
 * Everything else here exists for what a backend genuinely needs to do:
 * provision conversations, manage membership, post system messages, read
 * history for export or moderation.
 */
export class ChatResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  /**
   * Mints a browser-safe chat token.
   *
   * `scopes` can only ever *narrow* what the user's role already allows.
   * Listing `chat:moderate` here doesn't grant it. Which is what makes it
   * safe to pass straight through from a caller without re-checking.
   */
  createToken(params: CreateChatTokenParams): Promise<IssuedChatToken> {
    return this.http.request<IssuedChatToken>('/v1/chat/tokens', {
      method: 'POST',
      body: {
        userId: params.userId,
        conversations: params.conversations,
        scopes: params.scopes,
        ttlSeconds: params.expiresIn,
      },
    });
  }

  /**
   * Creates a conversation. Pass `roomId` to attach it to an RTC room and give that call a chat panel.
   *
   * A conversation created with no `members` is unreadable and unwritable by every chat token — including
   * one minted for whoever "created" it, since your project API key isn't itself a chat user. Pass the
   * userIds who should have access in `members`, or call `addMember()` for each of them before minting
   * their token; otherwise their first request comes back `RAVEN_CONVERSATION_NOT_FOUND`, indistinguishable
   * from a typo'd id.
   */
  createConversation(params: CreateConversationParams): Promise<ChatConversation> {
    return this.http.request<ChatConversation>('/v1/chat/conversations', {
      method: 'POST',
      body: params,
    });
  }

  /**
   * Without `userId`, returns every conversation in the project — you're
   * expected to want that for admin/moderation tooling. Pass `userId` to
   * get only the conversations that user actively belongs to instead of
   * fanning out to `listMembers()` on each one yourself.
   */
  listConversations(params?: { userId?: string; includeArchived?: boolean }): Promise<ChatConversation[]> {
    return this.http.request<ChatConversation[]>('/v1/chat/conversations', {
      query: { userId: params?.userId, includeArchived: params?.includeArchived },
    });
  }

  /** `room` takes a `conv_...` id, the conversation name, or an attached RTC room id. */
  getConversation(room: string): Promise<ChatConversation> {
    return this.http.request<ChatConversation>(`/v1/chat/conversations/${encodeURIComponent(room)}`);
  }

  addMember(room: string, params: { userId: string; role?: 'MEMBER' | 'MODERATOR' | 'ADMIN' }): Promise<ChatMember> {
    return this.http.request<ChatMember>(`/v1/chat/conversations/${encodeURIComponent(room)}/members`, {
      method: 'POST',
      body: params,
    });
  }

  removeMember(room: string, userId: string): Promise<void> {
    return this.http.request<void>(
      `/v1/chat/conversations/${encodeURIComponent(room)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
  }

  listMembers(room: string): Promise<ChatMember[]> {
    return this.http.request<ChatMember[]>(`/v1/chat/conversations/${encodeURIComponent(room)}/members`);
  }

  /**
   * Posts a message as any user in the project, which is precisely why it's
   * server-only. `type: 'system'` exists here and nowhere else: a browser
   * must never be able to fabricate a system announcement.
   */
  sendMessage(room: string, params: SendChatMessageParams): Promise<ChatMessage> {
    return this.http.request<ChatMessage>(`/v1/chat/conversations/${encodeURIComponent(room)}/messages`, {
      method: 'POST',
      body: params,
    });
  }

  /** Cursor-paginated history. Use `before` to page back. Never an offset. */
  listMessages(room: string, params: ListChatMessagesParams = {}): Promise<ChatMessagePage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.before) query.set('before', params.before);
    if (params.after) query.set('after', params.after);
    if (params.senderId) query.set('senderId', params.senderId);
    if (params.includeDeleted) query.set('includeDeleted', 'true');

    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.http.request<ChatMessagePage>(`/v1/chat/conversations/${encodeURIComponent(room)}/messages${suffix}`);
  }

  /** Soft-deletes a message. A moderation action: the row survives, with a `deletedAt`. */
  deleteMessage(messageId: string): Promise<ChatMessage> {
    return this.http.request<ChatMessage>(`/v1/chat/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
  }
}
