import { useState } from 'react';
import { PreJoin, SwalvoRoom, VideoConference, type LocalUserChoices } from '@swalvo/react';
import '@swalvo/react/video/styles.css';
import './index.css';

// This is the ONE thing a developer needs to think about client-side:
// forward the full JSON body from your backend's `POST /rtc-tokens` call
// (see examples/node-server, examples/python-server) straight into
// <SwalvoRoom>: never mint a token here, and no media-plane types appear
// anywhere in this file (Phase 11 spec §27).
interface ParsedToken {
  token: string;
  endpoint: string;
  roomName: string;
  iceServers?: RTCIceServer[];
  telemetryUrl?: string;
}

export function App() {
  const [grant, setGrant] = useState<ParsedToken | null>(null);
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);

  if (!grant) return <JoinForm onParsed={setGrant} />;

  // The lobby: camera preview, mic meter, device pickers. The identity in
  // the call comes from the token, so the name field is hidden here.
  if (!choices) {
    return (
      <main className="lobby">
        <PreJoin showUsername={false} onSubmit={setChoices} persistUserChoices />
      </main>
    );
  }

  const leave = () => {
    setChoices(null);
    setGrant(null);
  };

  return (
    <div className="call">
      <SwalvoRoom
        token={grant.token}
        endpoint={grant.endpoint}
        room={grant.roomName}
        iceServers={grant.iceServers}
        telemetryUrl={grant.telemetryUrl}
        fallback={<p className="connecting">Connecting…</p>}
        onError={(error) => {
          alert(`Join failed: ${error.code} — ${error.message}`);
          leave();
        }}
      >
        {/* The whole call UI: grid/focus layouts, controls, audio, toasts. */}
        <VideoConference userChoices={choices} onLeave={leave} />
      </SwalvoRoom>
    </div>
  );
}

function JoinForm({ onParsed }: { onParsed: (token: ParsedToken) => void }) {
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);

  function handleJoin() {
    try {
      const json = JSON.parse(raw) as Partial<ParsedToken>;
      if (!json.token || !json.endpoint || !json.roomName) {
        throw new Error('Expected a JSON body with token, endpoint, and roomName fields');
      }
      setError(null);
      onParsed(json as ParsedToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="lobby">
      <h1>Swalvo video-call example (@swalvo/react)</h1>
      <p>
        Paste the full JSON body returned by <code>POST /v1/rooms/:roomId/rtc-tokens</code> (mint one via Swagger at{' '}
        <code>/docs</code>, or use two different <code>participantIdentity</code> values in the same room to test a call
        between two tabs).
      </p>
      <textarea rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="Token JSON" />
      {error && <p className="error">{error}</p>}
      <button onClick={handleJoin}>Continue</button>
    </main>
  );
}
