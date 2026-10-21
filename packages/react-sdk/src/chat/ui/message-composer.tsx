'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { SwalvoChatError, SendMessageResult } from '@swalvo/chat';
import { useChatClient, useTyping } from '../chat-hooks';
import { useConversation, useModeration } from '../conversation-hooks';
import { cx } from './cx';

export interface MentionCandidate {
  /** The userId put in `mentions`. */
  id: string;
  /** What is typed into the text after the `@`. */
  name: string;
}

export interface MessageComposerProps {
  room: string;
  /** Sends a thread reply instead of a top-level message. */
  replyTo?: string;
  /** People who can be @mentioned. Typing `@` opens a picker over these. */
  mentionCandidates?: MentionCandidate[];
  /** Show the attach button. Defaults to true. Uses `chat.attachments.upload()`. */
  allowAttachments?: boolean;
  placeholder?: string;
  onSent?: (message: SendMessageResult | undefined) => void;
  onError?: (error: SwalvoChatError) => void;
  className?: string;
}

/**
 * A message box: Enter sends, Shift+Enter is a newline.
 *
 * Signals typing, offers an `@mention` picker over `mentionCandidates`
 * (each pick adds that userId to the send's `mentions`), uploads an
 * attached file before sending it, and disables itself while this user is
 * muted or the room's slow mode has them waiting — with a countdown, since
 * the server says exactly how long (`SLOW_MODE`'s `retryAfterSeconds`).
 *
 * Sends go through the room's shared conversation store, so the message
 * appears in `<MessageList>` at once as "sending".
 */
export function MessageComposer({
  room,
  replyTo,
  mentionCandidates = [],
  allowAttachments = true,
  placeholder = 'Write a message…',
  onSent,
  onError,
  className,
}: MessageComposerProps) {
  const client = useChatClient();
  const conversation = useConversation(room);
  const typing = useTyping(room);
  const moderation = useModeration(room);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slowUntil, setSlowUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The countdown only ticks while there is one.
  useEffect(() => {
    if (slowUntil === null) return undefined;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= slowUntil) setSlowUntil(null);
    }, 250);
    return () => clearInterval(timer);
  }, [slowUntil]);

  const secondsLeft = slowUntil === null ? 0 : Math.max(0, Math.ceil((slowUntil - now) / 1_000));
  const disabled = moderation.muted || moderation.banned || secondsLeft > 0;

  const query = /(?:^|\s)@(\w*)$/.exec(text)?.[1];
  const suggestions = useMemo(() => {
    if (query === undefined) return [];
    const lower = query.toLowerCase();
    return mentionCandidates.filter((candidate) => candidate.name.toLowerCase().startsWith(lower)).slice(0, 8);
  }, [query, mentionCandidates]);

  const pick = (candidate: MentionCandidate) => {
    setText((current) => current.replace(/@(\w*)$/, `@${candidate.name} `));
    setPicked((current) => (current.some((c) => c.id === candidate.id) ? current : [...current, candidate]));
  };

  const submit = async () => {
    const body = text.trim();
    if ((!body && !file) || disabled || busy || !client) return;
    setBusy(true);
    setError(null);
    try {
      let attachmentId: string | undefined;
      if (file) {
        const ticket = await client.attachments.upload(file, { room });
        attachmentId = ticket.id;
      }
      // Only mentions still present in the text: deleting "@bob" un-mentions him.
      const mentions = picked.filter((candidate) => body.includes(`@${candidate.name}`)).map((c) => c.id);
      const result = await conversation.send({
        text: body || undefined,
        replyTo,
        attachmentId,
        mentions: mentions.length > 0 ? mentions : undefined,
      });
      setText('');
      setPicked([]);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      typing.stop();
      onSent?.(result);
    } catch (caught) {
      const chatError = caught as SwalvoChatError & { retryAfterSeconds?: number; reason?: string };
      if (chatError?.code === 'SLOW_MODE') {
        const wait = (chatError.retryAfterSeconds ?? 5) * 1_000;
        setNow(Date.now());
        setSlowUntil(Date.now() + wait);
      }
      setError(describe(chatError));
      onError?.(chatError);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (suggestions.length > 0) {
        pick(suggestions[0]);
        return;
      }
      void submit();
    }
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    if (event.target.value) typing.onInput();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const status = moderation.banned
    ? 'You were removed from this conversation.'
    : moderation.muted
      ? 'You are muted in this conversation.'
      : secondsLeft > 0
        ? `Slow mode: wait ${secondsLeft}s`
        : null;

  return (
    <form
      className={cx('swalvo-chat', 'swalvo-composer', className)}
      onSubmit={onSubmit}
      data-disabled={disabled || undefined}
    >
      {suggestions.length > 0 && (
        <ul className="swalvo-composer__mentions" role="listbox" aria-label="Mention someone">
          {suggestions.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                className="swalvo-composer__mention"
                onClick={() => pick(candidate)}
              >
                @{candidate.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {file && (
        <div className="swalvo-composer__attachment">
          <span>{file.name}</span>
          <button type="button" className="swalvo-button" data-variant="ghost" onClick={() => setFile(null)}>
            Remove
          </button>
        </div>
      )}
      <div className="swalvo-composer__row">
        {allowAttachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="swalvo-composer__file"
              hidden
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              className="swalvo-button"
              data-variant="ghost"
              aria-label="Attach a file"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
            >
              +
            </button>
          </>
        )}
        <textarea
          className="swalvo-composer__input"
          value={text}
          rows={1}
          placeholder={status ?? placeholder}
          disabled={disabled}
          aria-label="Message"
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={() => typing.stop()}
        />
        <button type="submit" className="swalvo-button" data-variant="primary" disabled={disabled || busy}>
          {secondsLeft > 0 ? `${secondsLeft}s` : 'Send'}
        </button>
      </div>
      {(status || error) && (
        <p className="swalvo-composer__status" role="status">
          {status ?? error}
        </p>
      )}
    </form>
  );
}

function describe(error: SwalvoChatError & { reason?: string }): string {
  switch (error?.code) {
    case 'MUTED':
      return 'You are muted in this conversation.';
    case 'BANNED':
      return 'You were removed from this conversation.';
    case 'BLOCKED':
      return 'You can’t message this person.';
    case 'SLOW_MODE':
      return 'Slow mode is on. Try again in a moment.';
    case 'MESSAGE_BLOCKED':
      return error.reason ? `Message not sent: ${error.reason}` : 'This message was blocked.';
    default:
      return error?.message ?? 'Message not sent.';
  }
}
