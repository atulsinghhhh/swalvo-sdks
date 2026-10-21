import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  SwalvoChat,
  useChatConnectionState,
  useChatError,
  useMessages,
  usePresence,
  useReactions,
  useReadReceipts,
  useTyping,
  type ChatMessage,
} from '@swalvo/react';
import { useChatClient } from '@swalvo/react';
import './index.css';

/**
 * A real Swalvo Chat client. Every message on screen came from Postgres
 * via the WebSocket: there is no mock array anywhere in this file
 * (Phase 12 spec §44).
 *
 * Note what isn't here: no `new WebSocket(...)`, no reconnect logic, no
 * ping/pong, no message ordering. That's all inside @swalvo/chat.
 */
interface Session {
  token: string;
  apiUrl: string;
  chatUrl: string;
  roomId: string;
  userId: string;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);

  if (!session) {
    return <SignIn onSignedIn={setSession} />;
  }

  return (
    <SwalvoChat
      token={session.token}
      apiUrl={session.apiUrl}
      chatUrl={session.chatUrl}
      room={session.roomId}
      logLevel="info"
      // Called when the token is close to expiring. The SDK reconnects
      // with whatever this returns, so a long-lived tab keeps working
      // without the user noticing anything.
      onTokenExpiring={async () => {
        const refreshed = await mintToken(session.userId);
        return refreshed.token;
      }}
      fallback={<main className="centered">Connecting to Swalvo Chat…</main>}
      onError={(error) => {
        // eslint-disable-next-line no-console
        console.error(`[swalvo-chat] ${error.code}: ${error.message}`);
      }}
    >
      <ChatScreen session={session} onSignOut={() => setSession(null)} />
    </SwalvoChat>
  );
}

async function mintToken(userId: string): Promise<Session> {
  const response = await fetch('/api/chat/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'Could not sign in');
  }
  const body = (await response.json()) as Session & { userId: string };
  return body;
}

function SignIn({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [userId, setUserId] = useState('alice');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await mintToken(userId.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="centered">
      <form className="card" onSubmit={handleSubmit}>
        <h1>Swalvo Chat</h1>
        <p className="muted">
          Pick a name and open this page in a second tab as someone else to see two clients talk to each other.
        </p>
        <label htmlFor="user">Your user id</label>
        <input id="user" value={userId} onChange={(event) => setUserId(event.target.value)} autoFocus />
        <button type="submit" disabled={busy || !userId.trim()}>
          {busy ? 'Signing in…' : 'Join the conversation'}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </main>
  );
}

function ChatScreen({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const { messages, send, loadMore, loading, hasMore } = useMessages();
  const connectionState = useChatConnectionState();
  const presence = usePresence();
  const error = useChatError();

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const { typingUsers, onInput, stop } = useTyping();

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;

    setDraft('');
    setReplyTo(null);
    stop();
    // sendMessage resolves once Swalvo has durably stored the message.
    // The message itself arrives through the normal event stream, so the
    // sender renders exactly what everyone else does.
    await send(text, { replyTo: replyTo?.id });
  }

  return (
    <div className="layout">
      <header>
        <div>
          <strong>{session.roomId}</strong>
          <span className={`state state-${connectionState}`}>{connectionState}</span>
        </div>
        <div className="presence">
          {Object.entries(presence).map(([userId, status]) => (
            <span key={userId} className={`chip chip-${status}`}>
              {userId}
            </span>
          ))}
          <button type="button" className="link" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {error ? (
        <p className="error banner">
          {error.code}: {error.message}
        </p>
      ) : null}

      <MessageList
        messages={messages}
        currentUserId={session.userId}
        loading={loading}
        hasMore={hasMore}
        onLoadMore={() => void loadMore()}
        onReply={setReplyTo}
      />

      <footer>
        <TypingLine users={typingUsers} />
        {replyTo ? (
          <div className="reply-banner">
            Replying to <strong>{replyTo.senderId}</strong>: {truncate(replyTo.text ?? '', 60)}
            <button type="button" className="link" onClick={() => setReplyTo(null)}>
              cancel
            </button>
          </div>
        ) : null}
        <form onSubmit={handleSend}>
          <input
            value={draft}
            placeholder="Message…"
            onChange={(event) => {
              setDraft(event.target.value);
              // Throttled inside the hook: safe to call per keystroke.
              onInput();
            }}
            onBlur={stop}
          />
          <button type="submit" disabled={!draft.trim() || connectionState !== 'connected'}>
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}

function MessageList({
  messages,
  currentUserId,
  loading,
  hasMore,
  onLoadMore,
  onReply,
}: {
  messages: ChatMessage[];
  currentUserId: string;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onReply: (message: ChatMessage) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const { markAsRead, readersOf } = useReadReceipts();

  // Mark the newest message read whenever it changes. A real app would
  // gate this on the tab being visible; the point here is that read state
  // is explicit and client-driven, never inferred from delivery.
  const newest = messages[messages.length - 1];
  useEffect(() => {
    if (newest && newest.senderId !== currentUserId) {
      void markAsRead(newest.id);
    }
  }, [newest?.id, currentUserId, markAsRead, newest]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <ol className="messages">
      {hasMore ? (
        <li className="load-more">
          <button type="button" onClick={onLoadMore} disabled={loading}>
            {loading ? 'Loading…' : 'Load earlier messages'}
          </button>
        </li>
      ) : null}

      {messages.map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          isMine={message.senderId === currentUserId}
          readers={readersOf(message.id, messages)}
          onReply={onReply}
        />
      ))}
      <div ref={bottomRef} />
    </ol>
  );
}

const QUICK_REACTIONS = ['👍', '🎉', '❤️'];

function MessageRow({
  message,
  isMine,
  readers,
  onReply,
}: {
  message: ChatMessage;
  isMine: boolean;
  readers: string[];
  onReply: (message: ChatMessage) => void;
}) {
  const client = useChatClient();
  const { add, remove } = useReactions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text ?? '');

  if (message.deleted) {
    return (
      <li className="message deleted">
        <span className="muted">This message was deleted</span>
      </li>
    );
  }

  if (message.type === 'system') {
    return (
      <li className="message system">
        <span>{message.text}</span>
      </li>
    );
  }

  async function handleSaveEdit(event: FormEvent) {
    event.preventDefault();
    await client?.messages.update(message.id, { text: draft.trim() });
    setEditing(false);
  }

  return (
    <li className={`message ${isMine ? 'mine' : ''}`}>
      <div className="meta">
        <strong>{message.senderId}</strong>
        <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
        {message.edited ? <span className="muted">(edited)</span> : null}
      </div>

      {message.replyTo ? <div className="reply-ref">↩ replying to {message.replyTo}</div> : null}

      {editing ? (
        <form onSubmit={handleSaveEdit} className="edit-form">
          <input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus />
          <button type="submit">Save</button>
          <button type="button" className="link" onClick={() => setEditing(false)}>
            cancel
          </button>
        </form>
      ) : (
        <p>{message.text}</p>
      )}

      {message.reactions.length > 0 ? (
        <div className="reactions">
          {message.reactions.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              className="reaction"
              title={reaction.userIds.join(', ')}
              onClick={() =>
                reaction.userIds.includes(client?.userId ?? '')
                  ? void remove(message.id, reaction.emoji)
                  : void add(message.id, reaction.emoji)
              }
            >
              {reaction.emoji} {reaction.count}
            </button>
          ))}
        </div>
      ) : null}

      <div className="actions">
        {QUICK_REACTIONS.map((emoji) => (
          <button key={emoji} type="button" className="link" onClick={() => void add(message.id, emoji)}>
            {emoji}
          </button>
        ))}
        <button type="button" className="link" onClick={() => onReply(message)}>
          reply
        </button>
        {isMine ? (
          <>
            <button type="button" className="link" onClick={() => setEditing(true)}>
              edit
            </button>
            <button type="button" className="link" onClick={() => void client?.messages.delete(message.id)}>
              delete
            </button>
          </>
        ) : null}
      </div>

      {readers.length > 0 ? <div className="read-by">Read by {readers.join(', ')}</div> : null}
    </li>
  );
}

function TypingLine({ users }: { users: string[] }) {
  if (users.length === 0) {
    // Reserve the space so the composer doesn't jump when someone starts
    // typing: a small thing that makes the UI feel much less twitchy.
    return <div className="typing placeholder" />;
  }
  const label = users.length === 1 ? `${users[0]} is typing…` : `${users.join(', ')} are typing…`;
  return <div className="typing">{label}</div>;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
