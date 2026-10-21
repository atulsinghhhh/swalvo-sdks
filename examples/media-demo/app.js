// Swalvo media demo: built entirely on @swalvo/rtc's public API. No SDP, no
// ICE candidates, and no RTCPeerConnection appear anywhere in this file. Run `server.py` alongside this
// page: see the README.
import { createRTCClient, isRTCError } from '@swalvo/rtc';

const TOKEN_ENDPOINT = 'http://localhost:8788/api/rtc/token';
const DIAGNOSTICS_ENDPOINT = 'http://localhost:8788/api/diagnostics';
const STATS_POLL_MS = 2000;
const DIAGNOSTICS_POLL_MS = 5000;

const $ = (id) => document.getElementById(id);

const roomInput = $('roomInput');
const identityInput = $('identityInput');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const micBtn = $('micBtn');
const camBtn = $('camBtn');
const statusEl = $('status');
const roomLabelEl = $('roomLabel');
const userLabelEl = $('userLabel');
const localVideoEl = $('localVideo');
const localLabelEl = $('localLabel');
const participantsEl = $('participants');
const remoteGridEl = $('remoteGrid');
const logEl = $('log');
const connectionQualityEl = $('connectionQuality');
const statsBodyEl = $('statsBody');
const diagnosticsEl = $('diagnostics');

let client;
let room;
let micOn = false;
let camOn = false;
let statsTimer;

function log(message) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function describeError(error) {
  return isRTCError(error) ? `${error.code} — ${error.message}` : String(error);
}

function setStatus(state) {
  statusEl.textContent = state;
  statusEl.className = state;
}

function tileId(identity, kind) {
  return `tile-${identity}-${kind}`;
}

function attachRemoteTrack(track, participant) {
  const id = tileId(participant.identity, track.kind);
  let tile = document.getElementById(id);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = id;
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `${participant.identity} (${track.kind})`;
    tile.appendChild(label);
    remoteGridEl.appendChild(tile);
  }
  tile.prepend(track.attach());
}

function detachRemoteTrack(track, participant) {
  track.detach().forEach((el) => el.remove());
  const tile = document.getElementById(tileId(participant.identity, track.kind));
  if (tile && !tile.querySelector('video, audio')) tile.remove();
}

function renderParticipants() {
  participantsEl.innerHTML = '';
  if (!room) return;
  for (const participant of room.remoteParticipants) {
    const li = document.createElement('li');
    li.textContent = participant.identity;
    participantsEl.appendChild(li);
  }
}

// --- Live connection stats: room.getConnectionStats(), not a private API ---

function renderStatsRow(entry) {
  const row = document.createElement('tr');
  const cell = (text) => {
    const td = document.createElement('td');
    td.textContent = text ?? '—';
    return td;
  };
  row.appendChild(cell(entry.kind));
  row.appendChild(cell(entry.direction));
  row.appendChild(cell(entry.bitrateBps !== undefined ? `${Math.round(entry.bitrateBps / 1000)} kbps` : undefined));
  row.appendChild(cell(entry.packetLossPercent !== undefined ? `${entry.packetLossPercent.toFixed(1)}%` : undefined));
  row.appendChild(cell(entry.jitterMs !== undefined ? `${entry.jitterMs.toFixed(0)} ms` : undefined));
  row.appendChild(cell(entry.roundTripTimeMs !== undefined ? `${entry.roundTripTimeMs.toFixed(0)} ms` : undefined));
  row.appendChild(cell(entry.codec));
  return row;
}

async function pollStats() {
  if (!room) return;
  try {
    const stats = await room.getConnectionStats();
    connectionQualityEl.textContent = `${stats.connectionQuality} (${stats.connectionState})`;

    statsBodyEl.innerHTML = '';
    const tracks = [...stats.local, ...stats.remote];
    if (tracks.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 7;
      cell.textContent = 'No published or subscribed tracks yet.';
      row.appendChild(cell);
      statsBodyEl.appendChild(row);
      return;
    }
    for (const entry of tracks) statsBodyEl.appendChild(renderStatsRow(entry));
  } catch (error) {
    log(`could not read connection stats: ${describeError(error)}`);
  }
}

// --- Project diagnostics. GET /api/diagnostics, a pass-through of the
// Python SDK's swalvo.diagnostics.get() (swalvo/resources/diagnostics.py).
// Independent of whether this page is connected to anything: it reports
// the project's infrastructure health, not this browser tab's state.

function renderDependency(name, status) {
  const span = document.createElement('span');
  span.textContent = `${name}: ${status ?? 'unknown'} `;
  span.className = status === 'up' ? 'dep-up' : 'dep-down';
  return span;
}

async function pollDiagnostics() {
  try {
    const res = await fetch(DIAGNOSTICS_ENDPOINT);
    if (!res.ok) throw new Error(`server responded ${res.status}`);
    const diagnostics = await res.json();

    diagnosticsEl.innerHTML = '';
    const deps = diagnostics.dependencies ?? {};
    diagnosticsEl.appendChild(renderDependency('signaling', deps.signaling));
    diagnosticsEl.appendChild(renderDependency('sfu', deps.sfu));
    diagnosticsEl.appendChild(renderDependency('turn', deps.turn));
    const count = document.createElement('span');
    count.textContent = ` — ${diagnostics.connections?.active ?? '?'} active connection(s) in this project`;
    diagnosticsEl.appendChild(count);
  } catch (error) {
    diagnosticsEl.textContent = `Could not reach the demo backend at ${DIAGNOSTICS_ENDPOINT} — is server.py running? (${error.message})`;
  }
}

pollDiagnostics();
setInterval(pollDiagnostics, DIAGNOSTICS_POLL_MS);

// --- Join / leave ---

joinBtn.onclick = async () => {
  const roomName = roomInput.value.trim();
  const identity = identityInput.value.trim();
  if (!roomName || !identity) {
    alert('Room name and identity are both required.');
    return;
  }

  let issued;
  try {
    setStatus('connecting');
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: roomName, identity }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `token request failed with status ${res.status}`);
    }
    issued = await res.json();
  } catch (error) {
    setStatus('failed');
    log(`could not get a token from ${TOKEN_ENDPOINT}: ${error.message}. Is server.py running? See the README.`);
    return;
  }

  // This is the entire authentication flow the developer needs to think
  // about: forward token/endpoint/iceServers/telemetryUrl from your
  // backend's RTC token response: never mint that token in the browser.
  client = createRTCClient({
    token: issued.token,
    endpoint: issued.endpoint,
    iceServers: issued.iceServers,
    telemetryUrl: issued.telemetryUrl,
    logLevel: 'warn',
  });

  try {
    room = await client.join(issued.roomName);
  } catch (error) {
    setStatus('failed');
    log(`join failed: ${describeError(error)}`);
    return;
  }

  log(`connected to room "${room.roomId}" as "${room.localParticipant.identity}"`);
  roomLabelEl.textContent = issued.roomName;
  userLabelEl.textContent = room.localParticipant.identity;
  localLabelEl.textContent = room.localParticipant.identity;
  setStatus(room.connectionState);

  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  micBtn.disabled = false;
  camBtn.disabled = false;

  room.on('connectionStateChanged', (state) => {
    log(`connection state: ${state}`);
    setStatus(state);
  });
  room.on('reconnecting', () => log('reconnecting…'));
  room.on('reconnected', () => log('reconnected'));
  room.on('error', (error) => log(`error: ${error.code} — ${error.message}`));
  room.on('disconnected', () => {
    log('disconnected');
    setStatus('disconnected');
    resetUi();
  });

  room.on('participantJoined', (participant) => {
    log(`participant joined: ${participant.identity}`);
    renderParticipants();
  });
  room.on('participantLeft', (participant) => {
    log(`participant left: ${participant.identity}`);
    renderParticipants();
  });

  room.on('trackSubscribed', (track, participant) => {
    log(`subscribed to ${track.kind} from ${participant.identity}`);
    attachRemoteTrack(track, participant);
  });
  room.on('trackUnsubscribed', (track, participant) => {
    log(`unsubscribed from ${track.kind} of ${participant.identity}`);
    detachRemoteTrack(track, participant);
  });
  room.on('trackMuted', (kind, participant) => log(`${participant.identity} muted ${kind}`));
  room.on('trackUnmuted', (kind, participant) => log(`${participant.identity} unmuted ${kind}`));

  // Anyone already in the room (and their already-subscribed tracks) is
  // available synchronously right away: participantJoined/trackSubscribed
  // only fire for arrivals after this point.
  renderParticipants();
  for (const participant of room.remoteParticipants) {
    for (const track of participant.tracks) attachRemoteTrack(track, participant);
  }

  statsTimer = setInterval(pollStats, STATS_POLL_MS);
  pollStats();
};

leaveBtn.onclick = async () => {
  await client?.leave();
};

micBtn.onclick = async () => {
  if (!room) return;
  const next = !micOn;
  try {
    if (next) await room.enableMicrophone();
    else await room.disableMicrophone();
    micOn = next;
    micBtn.textContent = `Mic: ${micOn ? 'on' : 'off'}`;
    log(`microphone ${micOn ? 'enabled' : 'disabled'}`);
  } catch (error) {
    log(`microphone error: ${describeError(error)}`);
    alert(`Could not toggle microphone: ${describeError(error)}`);
  }
};

camBtn.onclick = async () => {
  if (!room) return;
  const next = !camOn;
  try {
    if (next) {
      const track = await room.enableCamera();
      if (track) track.attach(localVideoEl);
    } else {
      await room.disableCamera();
      localVideoEl.srcObject = null;
    }
    camOn = next;
    camBtn.textContent = `Camera: ${camOn ? 'on' : 'off'}`;
    log(`camera ${camOn ? 'enabled' : 'disabled'}`);
  } catch (error) {
    log(`camera error: ${describeError(error)}`);
    alert(`Could not toggle camera: ${describeError(error)}`);
  }
};

function resetUi() {
  joinBtn.disabled = false;
  leaveBtn.disabled = true;
  micBtn.disabled = true;
  camBtn.disabled = true;
  micBtn.textContent = 'Mic: off';
  camBtn.textContent = 'Camera: off';
  micOn = false;
  camOn = false;
  localVideoEl.srcObject = null;
  roomLabelEl.textContent = '—';
  userLabelEl.textContent = '—';
  localLabelEl.textContent = '(not joined)';
  participantsEl.innerHTML = '';
  remoteGridEl.innerHTML = '';
  connectionQualityEl.textContent = '—';
  statsBodyEl.innerHTML = '<tr><td colspan="7">Not connected.</td></tr>';
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = undefined;
  }
  room = undefined;
  client = undefined;
}
