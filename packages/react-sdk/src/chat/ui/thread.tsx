'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { compareSeq, type ChatMessage, type SwalvoChatError } from '@swalvo/chat';
import { useChatClient } from '../chat-hooks';
import { MessageComposer, type MentionCandidate } from './message-composer';
import { cx } from './cx';

export interface ThreadProps {
  room: string;
  /** The thread's root message id. */
  messageId: string;
  /** Replies per page, at most 100. Defaults to 50. */
  pageSize?: number;
  mentionCandidates?: MentionCandidate[];
  renderMessage?: (message: ChatMessage) => ReactNode;
  onClose?: () => void;
  className?: string;
}

/**
 * A thread: the root message, its replies oldest first, and a reply box.
 *
 * Replies page through `chat.messages.threadPage()` (§5) and new ones
 * arrive live — any `message` whose `threadRootId` or `replyTo` is this
 * root. Replies are sent with `replyTo`, so they join this thread.
 */
export function Thread({
  room,
  messageId,
  pageSize = 50,
  mentionCandidates,
  renderMessage,
  onClose,
  className,
}: ThreadProps) {
  const client = useChatClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SwalvoChatError>();

  const merge = useCallback((incoming: ChatMessage[]) => {
    setMessages((current) => {
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of incoming) byId.set(message.id, { ...byId.get(message.id), ...message });
      return Array.from(byId.values()).sort(
        (a, b) => (a.seq && b.seq ? compareSeq(a.seq, b.seq) : 0) || a.createdAt.localeCompare(b.createdAt),
      );
    });
  }, []);

  const loadPage = useCallback(
    async (from: string | null) => {
      if (!client) return;
      setLoading(true);
      try {
        const page = await client.messages.threadPage(messageId, { limit: pageSize, cursor: from });
        merge(page.data);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch (caught) {
        setError(caught as SwalvoChatError);
      } finally {
        setLoading(false);
      }
    },
    [client, messageId, pageSize, merge],
  );

  useEffect(() => {
    setMessages([]);
    setCursor(null);
    void loadPage(null);
  }, [loadPage]);

  useEffect(() => {
    if (!client) return undefined;
    const inThread = (message: ChatMessage) =>
      message.id === messageId || message.threadRootId === messageId || message.replyTo === messageId;
    const subscriptions = [
      client.on('message', (message) => inThread(message) && merge([message])),
      client.on('messageUpdated', (message) => inThread(message) && merge([message])),
    ];
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [client, messageId, merge]);

  return (
    <section
      className={cx('swalvo-chat', 'swalvo-thread', className)}
      aria-label="Thread"
      data-loading={loading || undefined}
    >
      <header className="swalvo-thread__header">
        <span>Thread</span>
        {onClose && (
          <button
            type="button"
            className="swalvo-button"
            data-variant="ghost"
            onClick={onClose}
            aria-label="Close thread"
          >
            ×
          </button>
        )}
      </header>
      <div className="swalvo-thread__messages" role="log">
        {messages.map((message) => (
          <div key={message.id} className="swalvo-thread__row" data-root={message.id === messageId || undefined}>
            {renderMessage ? (
              renderMessage(message)
            ) : (
              <article className="swalvo-message" data-own={message.senderId === client?.userId || undefined}>
                <header className="swalvo-message__meta">
                  <span className="swalvo-message__sender">{message.senderId}</span>
                </header>
                <div className="swalvo-message__body">
                  {message.deleted ? <em className="swalvo-message__deleted">Message deleted</em> : message.text}
                </div>
              </article>
            )}
          </div>
        ))}
        {hasMore && (
          <button type="button" className="swalvo-button" disabled={loading} onClick={() => void loadPage(cursor)}>
            {loading ? 'Loading…' : 'Load more replies'}
          </button>
        )}
        {error && <p className="swalvo-thread__error">{error.message}</p>}
      </div>
      <MessageComposer room={room} replyTo={messageId} mentionCandidates={mentionCandidates} placeholder="Reply…" />
    </section>
  );
}
