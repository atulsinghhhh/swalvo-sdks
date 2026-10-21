'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { useChatClient } from '../chat-hooks';
import { useConversation } from '../conversation-hooks';
import type { ConversationMessage } from '../conversation-store';
import { cx } from './cx';

export interface MessageRenderState {
  own: boolean;
  retry: () => void;
  cancel: () => void;
}

export interface MessageListProps {
  room: string;
  /**
   * How many messages to render at once, counted from the newest.
   * Scrolling to the top reveals another window's worth, then pages older
   * history from the server. Defaults to 50.
   */
  windowSize?: number;
  /** Extra rows kept rendered above the window, so a reveal does not flash. Defaults to 10. */
  overscan?: number;
  /** How close to the top, in px, counts as "at the top". Defaults to 80. */
  topThreshold?: number;
  renderMessage?: (message: ConversationMessage, state: MessageRenderState) => ReactNode;
  /** Called with a thread root's id when its "N replies" button is clicked. */
  onOpenThread?: (messageId: string) => void;
  /** Mark the newest message read whenever it changes. Defaults to true. */
  markReadOnView?: boolean;
  emptyState?: ReactNode;
  className?: string;
  messageClassName?: string;
}

/**
 * A room's messages, oldest at the top, with pending and failed sends shown
 * in place.
 *
 * ## Windowing, without a virtualization dependency
 *
 * Only the newest `windowSize` (+ `overscan`) messages are in the DOM.
 * Reaching the top reveals the next window from what is already loaded,
 * and once that runs out, fetches the next page of history. Scroll
 * position is held across a reveal so the content does not jump. It is not
 * a full virtual list — a very long session keeps every revealed row — but
 * it caps what a freshly opened, long conversation costs to render.
 */
export function MessageList({
  room,
  windowSize = 50,
  overscan = 10,
  topThreshold = 80,
  renderMessage,
  onOpenThread,
  markReadOnView = true,
  emptyState,
  className,
  messageClassName,
}: MessageListProps) {
  const client = useChatClient();
  const conversation = useConversation(room, { pageSize: windowSize });
  const { messages } = conversation;
  const [visible, setVisible] = useState(windowSize);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const stickToBottomRef = useRef(true);

  const start = Math.max(0, messages.length - visible - overscan);
  const rendered = messages.slice(start);
  const hiddenLocally = start > 0;

  // Keep the reader's place when rows are added above them.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const anchor = anchorRef.current;
    if (anchor) {
      element.scrollTop = element.scrollHeight - anchor.height + anchor.top;
      anchorRef.current = null;
    } else if (stickToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [rendered.length, messages.length]);

  const newestStored = [...messages].reverse().find((message) => !message.localStatus)?.id;
  useEffect(() => {
    if (markReadOnView && newestStored) void conversation.markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestStored, markReadOnView]);

  const revealOlder = () => {
    const element = scrollRef.current;
    if (element) anchorRef.current = { height: element.scrollHeight, top: element.scrollTop };
    if (hiddenLocally) {
      setVisible((count) => count + windowSize);
    } else if (conversation.hasMore && !conversation.loading) {
      setVisible((count) => count + windowSize);
      void conversation.loadOlder();
    }
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    if (element.scrollTop <= topThreshold && (hiddenLocally || conversation.hasMore)) revealOlder();
  };

  return (
    <div
      ref={scrollRef}
      className={cx('swalvo-chat', 'swalvo-message-list', className)}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      data-loading={conversation.loading || undefined}
    >
      {(hiddenLocally || conversation.hasMore) && (
        <button type="button" className="swalvo-button swalvo-message-list__older" onClick={revealOlder}>
          {conversation.loading ? 'Loading…' : 'Load older messages'}
        </button>
      )}
      {!conversation.loading && messages.length === 0 && emptyState}
      {rendered.map((message) => {
        const own = message.senderId === client?.userId;
        const key = message.clientMessageId ?? message.id;
        const state: MessageRenderState = {
          own,
          retry: () => void conversation.retry(message.clientMessageId ?? message.id).catch(() => undefined),
          cancel: () => void conversation.cancel(message.clientMessageId ?? message.id),
        };
        return (
          <div key={key} className="swalvo-message-list__row">
            {renderMessage ? (
              renderMessage(message, state)
            ) : (
              <DefaultMessage
                message={message}
                state={state}
                className={messageClassName}
                onOpenThread={onOpenThread}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function DefaultMessage({
  message,
  state,
  className,
  onOpenThread,
}: {
  message: ConversationMessage;
  state: MessageRenderState;
  className?: string;
  onOpenThread?: (messageId: string) => void;
}) {
  const status = message.localStatus ?? 'sent';
  return (
    <article
      className={cx('swalvo-message', className)}
      data-own={state.own || undefined}
      data-status={status}
      data-deleted={message.deleted || undefined}
      data-pinned={message.pinned || undefined}
    >
      <header className="swalvo-message__meta">
        <span className="swalvo-message__sender">{message.senderId}</span>
        <time className="swalvo-message__time" dateTime={message.createdAt}>
          {formatTime(message.createdAt)}
        </time>
        {message.edited && !message.deleted && <span className="swalvo-message__edited">edited</span>}
      </header>

      <div className="swalvo-message__body">
        {message.deleted ? <em className="swalvo-message__deleted">Message deleted</em> : message.text}
      </div>

      {message.attachment && !message.deleted && (
        <div className="swalvo-message__attachment">{message.attachment.filename}</div>
      )}

      {message.linkPreview && !message.deleted && (
        <a className="swalvo-link-preview" href={message.linkPreview.url} target="_blank" rel="noopener noreferrer">
          {message.linkPreview.imageUrl && (
            <img className="swalvo-link-preview__image" src={message.linkPreview.imageUrl} alt="" loading="lazy" />
          )}
          <span className="swalvo-link-preview__site">
            {message.linkPreview.siteName ?? hostOf(message.linkPreview.url)}
          </span>
          {message.linkPreview.title && <span className="swalvo-link-preview__title">{message.linkPreview.title}</span>}
          {message.linkPreview.description && (
            <span className="swalvo-link-preview__description">{message.linkPreview.description}</span>
          )}
        </a>
      )}

      {message.reactions.length > 0 && (
        <ul className="swalvo-message__reactions" role="list">
          {message.reactions.map((reaction) => (
            <li key={reaction.emoji} className="swalvo-reaction">
              {reaction.emoji} {reaction.count}
            </li>
          ))}
        </ul>
      )}

      {(message.replyCount ?? 0) > 0 && (
        <button type="button" className="swalvo-message__replies" onClick={() => onOpenThread?.(message.id)}>
          {message.replyCount === 1 ? '1 reply' : `${message.replyCount} replies`}
        </button>
      )}

      {message.localStatus && (
        <footer className="swalvo-message__status" role="status">
          {message.localStatus === 'failed' ? (
            <>
              <span className="swalvo-message__error">{message.localError?.message ?? 'Not sent'}</span>
              <button type="button" className="swalvo-button" onClick={state.retry}>
                Retry
              </button>
              <button type="button" className="swalvo-button" data-variant="ghost" onClick={state.cancel}>
                Delete
              </button>
            </>
          ) : message.localStatus === 'pending' ? (
            <>
              <span>Waiting for connection…</span>
              <button type="button" className="swalvo-button" data-variant="ghost" onClick={state.cancel}>
                Cancel
              </button>
            </>
          ) : (
            <span>Sending…</span>
          )}
        </footer>
      )}
    </article>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
