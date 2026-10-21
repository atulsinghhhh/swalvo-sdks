'use client';

import type { ReactNode } from 'react';
import type { InboxConversation, InboxLoadOptions } from '@swalvo/chat';
import { useInbox } from '../conversation-hooks';
import { cx } from './cx';

export interface ChannelListProps {
  /** The conversation currently open, highlighted with `data-selected`. */
  selectedId?: string;
  onSelect?: (conversation: InboxConversation) => void;
  /** Replace the default row entirely. `selected` is precomputed for you. */
  renderItem?: (conversation: InboxConversation, state: { selected: boolean; select: () => void }) => ReactNode;
  /** Shown when the inbox has loaded and is empty. */
  emptyState?: ReactNode;
  /** Passed to `chat.inbox.load()` on first mount. */
  inboxOptions?: InboxLoadOptions;
  className?: string;
  itemClassName?: string;
}

/**
 * This user's conversations, newest activity first, with unread badges.
 *
 * Unstyled: every element carries a stable `swalvo-*` class and state as
 * `data-*` attributes (`data-selected`, `data-unread`, `data-muted`), so
 * it can be styled from scratch or with `@swalvo/react/chat/styles.css`.
 */
export function ChannelList({
  selectedId,
  onSelect,
  renderItem,
  emptyState,
  inboxOptions,
  className,
  itemClassName,
}: ChannelListProps) {
  const inbox = useInbox(inboxOptions);

  return (
    <div className={cx('swalvo-chat', 'swalvo-channel-list', className)} data-loading={inbox.loading || undefined}>
      <ul className="swalvo-channel-list__items" role="list">
        {inbox.conversations.map((conversation) => {
          const selected = conversation.id === selectedId;
          const select = () => onSelect?.(conversation);
          if (renderItem) {
            return <li key={conversation.id}>{renderItem(conversation, { selected, select })}</li>;
          }
          return (
            <li key={conversation.id}>
              <button
                type="button"
                className={cx('swalvo-channel', itemClassName)}
                data-selected={selected || undefined}
                data-unread={conversation.unreadCount > 0 || undefined}
                data-muted={conversation.muted || undefined}
                aria-current={selected ? 'true' : undefined}
                onClick={select}
              >
                <span className="swalvo-channel__name">{conversation.name ?? conversation.id}</span>
                {conversation.lastMessage && (
                  <span className="swalvo-channel__preview">{conversation.lastMessage.content ?? 'Attachment'}</span>
                )}
                {conversation.unreadCount > 0 && (
                  <span
                    className="swalvo-badge"
                    data-mentions={conversation.unreadMentions > 0 || undefined}
                    aria-label={`${conversation.unreadCount} unread`}
                  >
                    {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {!inbox.loading && inbox.conversations.length === 0 && emptyState}
      {inbox.hasMore && (
        <button type="button" className="swalvo-button swalvo-channel-list__more" onClick={() => void inbox.loadMore()}>
          Load more
        </button>
      )}
    </div>
  );
}
