import { useState, type FormEvent } from 'react';
import {
  ParticipantView,
  SwalvoChat,
  SwalvoRoom,
  useCamera,
  useChatConnectionState,
  useConnectionState,
  useMessages,
  useMicrophone,
  useParticipants,
  usePresence,
  useTyping,
} from '@swalvo/react';
import './index.css';

/**
 * A video call with a chat panel.
 *
 * The thing to notice is the nesting: `<SwalvoRoom>` owns the media
 * session and `<SwalvoChat>` owns the messaging session, each with its own
 * token, its own connection, and its own lifecycle. Media flows over
 * WebRTC through Swalvo's SFU; messages flow over a WebSocket through Postgres
 * and Redis. Neither knows the other exists (Phase 12 spec §45).
 *
 * That separation is load-bearing, not cosmetic: the chat panel keeps
 * working when the video connection drops, and the call survives a chat
 * gateway restart.
 */
interface Session {
  identity: string;
  rtc: { token: string; endpoint: string; roomName: string; iceServers?: RTCIceServer[]; telemetryUrl?: string };
  chat: { token: string; apiUrl: string; chatUrl: string; roomId: string };
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);

  if (!session) {
    return <JoinForm onJoined={setSession} />;
  }

  return (
    <SwalvoRoom
      token={session.rtc.token}
      endpoint={session.rtc.endpoint}
      room={session.rtc.roomName}
      iceServers={session.rtc.iceServers}
      telemetryUrl={session.rtc.telemetryUrl}
      fallback={<main className="centered">Connecting to the call…</main>}
      onError={(error) => {
        // eslint-disable-next-line no-console
        console.error(`[swalvo-rtc] ${error.code}: ${error.message}`);
      }}
    >
      <SwalvoChat
        token={session.chat.token}
        apiUrl={session.chat.apiUrl}
        chatUrl={session.chat.chatUrl}
        room={session.chat.roomId}
        onError={(error) => {
          // Chat failing must never tear down the call: log it and let
          // the video half carry on.
          // eslint-disable-next-line no-console
          console.error(`[swalvo-chat] ${error.code}: ${error.message}`);
        }}
      >
        <CallScreen session={session} onLeave={() => setSession(null)} />
      </SwalvoChat>
    </SwalvoRoom>
  );
}

function JoinForm({ onJoined }: { onJoined: (session: Session) => void }) {
  const [room, setRoom] = useState('standup');
  const [identity, setIdentity] = useState('alice');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: room.trim(), identity: identity.trim() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not start the session');
      onJoined(body as Session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="centered">
      <form className="card" onSubmit={handleSubmit}>
        <h1>Swalvo — video + chat</h1>
        <p className="muted">
          One backend call returns two independent tokens: one for the media session, one for messaging.
        </p>
        <label htmlFor="room">Room</label>
        <input id="room" value={room} onChange={(event) => setRoom(event.target.value)} />
        <label htmlFor="identity">Your identity</label>
        <input id="identity" value={identity} onChange={(event) => setIdentity(event.target.value)} />
        <button type="submit" disabled={busy || !room.trim() || !identity.trim()}>
          {busy ? 'Joining…' : 'Join'}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </main>
  );
}

function CallScreen({ session, onLeave }: { session: Session; onLeave: () => void }) {
  return (
    <div className="call-layout">
      <header>
        <strong>{session.rtc.roomName}</strong>
        <ConnectionBadges />
        <button type="button" className="link" onClick={onLeave}>
          Leave
        </button>
      </header>

      <section className="video-pane">
        <VideoGrid />
        <MediaControls />
      </section>

      <aside className="chat-pane">
        <ChatPanel identity={session.identity} />
      </aside>
    </div>
  );
}

/**
 * The two connection states, side by side. Showing them separately is the
 * honest thing to do: they genuinely are two connections, and a user
 * whose video is reconnecting while chat stays up should be able to see
 * that.
 */
function ConnectionBadges() {
  const rtcState = useConnectionState();
  const chatState = useChatConnectionState();

  return (
    <div className="badges">
      <span className={`state state-${rtcState}`}>video: {rtcState}</span>
      <span className={`state state-${chatState}`}>chat: {chatState}</span>
    </div>
  );
}

function VideoGrid() {
  const participants = useParticipants();

  return (
    <div className="grid">
      {participants.map((participant) => (
        <div key={participant.identity} className="tile">
          <ParticipantView participant={participant} />
          <span className="tile-label">{participant.identity}</span>
        </div>
      ))}
    </div>
  );
}

function MediaControls() {
  const camera = useCamera();
  const microphone = useMicrophone();

  return (
    <div className="controls">
      <button type="button" onClick={() => void (camera.enabled ? camera.disable() : camera.enable())}>
        {camera.enabled ? 'Stop camera' : 'Start camera'}
      </button>
      <button type="button" onClick={() => void (microphone.enabled ? microphone.disable() : microphone.enable())}>
        {microphone.enabled ? 'Mute' : 'Unmute'}
      </button>
    </div>
  );
}

function ChatPanel({ identity }: { identity: string }) {
  const { messages, send, loadMore, hasMore, loading } = useMessages();
  const { typingUsers, onInput, stop } = useTyping();
  const presence = usePresence();
  const chatState = useChatConnectionState();
  const [draft, setDraft] = useState('');

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    stop();
    await send(text);
  }

  return (
    <>
      <div className="chat-header">
        <strong>Chat</strong>
        <span className="muted">{Object.keys(presence).length} present</span>
      </div>

      <ol className="chat-messages">
        {hasMore ? (
          <li className="load-more">
            <button type="button" onClick={() => void loadMore()} disabled={loading}>
              {loading ? 'Loading…' : 'Earlier messages'}
            </button>
          </li>
        ) : null}
        {messages.map((message) => (
          <li key={message.id} className={message.senderId === identity ? 'mine' : ''}>
            {message.deleted ? (
              <em className="muted">deleted</em>
            ) : (
              <>
                <strong>{message.senderId}:</strong> {message.text}
                {message.edited ? <span className="muted"> (edited)</span> : null}
              </>
            )}
          </li>
        ))}
      </ol>

      <div className="typing">{typingUsers.length > 0 ? `${typingUsers.join(', ')} typing…` : ' '}</div>

      <form onSubmit={handleSend}>
        <input
          value={draft}
          placeholder="message…"
          onChange={(event) => {
            setDraft(event.target.value);
            onInput();
          }}
          onBlur={stop}
        />
        <button type="submit" disabled={!draft.trim() || chatState !== 'connected'}>
          Send
        </button>
      </form>
    </>
  );
}
