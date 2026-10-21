// Swalvo Live Streaming demo: built entirely on @swalvo/live's
// LiveStream API (swalvo.live.join()). No SDP and no
// RTCPeerConnection anywhere in this file: `stream.room` and
// `stream.chat` are real @swalvo/rtc/@swalvo/chat objects, used exactly as
// their own docs describe.
import { LiveStream } from '@swalvo/live';

const BACKEND = 'http://localhost:8790';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const role = params.get('role') === 'viewer' ? 'viewer' : 'host';

$('roleLabel').textContent = role.toUpperCase();
$(role === 'host' ? 'hostControls' : 'viewerControls').style.display = 'block';
if (role === 'viewer' && params.get('stream')) {
  $('streamIdInput').value = params.get('stream');
}

const statusEl = $('status');
const logEl = $('log');
const chatLogEl = $('chatLog');
const remoteVideoEl = $('remoteVideo');
const videoLabelEl = $('videoLabel');
const reactionsEl = $('reactions');

let stream; // the LiveStream instance
let currentStreamId;
let identity;

function log(message) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function chatLog(message) {
  const line = document.createElement('div');
  line.textContent = message;
  chatLogEl.appendChild(line);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function wireCommon(s) {
  s.room.on('connectionStateChanged', (state) => {
    log(`RTC connection state: ${state}`);
    setStatus(state);
  });
  s.room.on('error', (error) => log(`RTC error: ${error.code} — ${error.message}`));

  s.room.on('trackSubscribed', (track, participant) => {
    log(`subscribed to ${track.kind} from ${participant.identity}`);
    if (track.kind === 'camera') {
      videoLabelEl.textContent = participant.identity;
      track.attach(remoteVideoEl);
    }
  });

  if (s.chat) {
    s.chat.on('message', (message) => chatLog(`${message.senderId}: ${message.text}`));
    s.chat.on('reactionAdded', (event) => {
      reactionsEl.textContent += event.emoji;
      log(`reaction from ${event.userId}: ${event.emoji}`);
    });
    s.chat.on('error', (error) => log(`chat error: ${error.code} — ${error.message}`));
  }
}

// --- Host ---

$('goLiveBtn').onclick = async () => {
  identity = $('hostIdentityInput').value.trim();
  const title = $('titleInput').value.trim();
  if (!identity || !title) return alert('Title and identity are required.');

  setStatus('creating…');
  const created = await fetch(`${BACKEND}/api/streams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, hostIdentity: identity }),
  }).then((r) => r.json());

  currentStreamId = created.stream.id;
  $('streamIdOut').textContent = currentStreamId;
  log(`stream created: ${currentStreamId}`);

  const { credentials } = created;
  stream = await LiveStream.join({
    streamId: currentStreamId,
    role: credentials.role,
    rtc: credentials.rtc,
    chat: credentials.chat,
    chatRootMessageId: created.stream.chatRootMessageId,
  });
  wireCommon(stream);
  log(`joined as ${stream.role} (isHost=${stream.isHost})`);

  await stream.room.enableCamera();
  await stream.room.enableMicrophone();
  log('camera + microphone enabled — publishing');

  // Self-preview: the host's own local video track, not a remote one.
  const localTrack = stream.room.localParticipant.tracks.find((t) => t.kind === 'camera');
  if (localTrack) {
    videoLabelEl.textContent = `${identity} (you)`;
    localTrack.attach(remoteVideoEl);
  }

  await fetch(`${BACKEND}/api/streams/${currentStreamId}/start`, { method: 'POST' });
  log('stream is now LIVE');

  $('goLiveBtn').disabled = true;
  $('endBtn').disabled = false;
};

$('endBtn').onclick = async () => {
  await fetch(`${BACKEND}/api/streams/${currentStreamId}/end`, { method: 'POST' });
  log('stream ended (status ENDED)');
  await stream.leave();
  setStatus('ended');
  $('endBtn').disabled = true;
};

// --- Viewer ---

$('joinBtn').onclick = async () => {
  currentStreamId = $('streamIdInput').value.trim();
  identity = $('viewerIdentityInput').value.trim();
  if (!currentStreamId || !identity) return alert('Stream ID and identity are required.');

  setStatus('joining…');
  const streamInfo = await fetch(`${BACKEND}/api/streams/${currentStreamId}`).then((r) => r.json());
  const credentials = await fetch(`${BACKEND}/api/streams/${currentStreamId}/viewer-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity }),
  }).then((r) => r.json());

  stream = await LiveStream.join({
    streamId: currentStreamId,
    role: credentials.role,
    rtc: credentials.rtc,
    chat: credentials.chat,
    chatRootMessageId: streamInfo.chatRootMessageId,
  });
  wireCommon(stream);
  log(`joined as ${stream.role} (isHost=${stream.isHost})`);

  // Already-published tracks (the host was live before this tab joined)
  // arrive synchronously on room.remoteParticipants: trackSubscribed
  // only fires for arrivals *after* this point.
  for (const participant of stream.room.remoteParticipants) {
    for (const track of participant.tracks) {
      log(`already subscribed to ${track.kind} from ${participant.identity}`);
      if (track.kind === 'camera') {
        videoLabelEl.textContent = participant.identity;
        track.attach(remoteVideoEl);
      }
    }
  }

  $('joinBtn').disabled = true;
};

// --- Chat (both roles) ---

$('sendChatBtn').onclick = async () => {
  const text = $('chatInput').value.trim();
  if (!text || !stream?.chat) return;
  await stream.chat.sendMessage({ text });
  $('chatInput').value = '';
};

$('reactBtn').onclick = async () => {
  if (!stream) return;
  try {
    await stream.react('❤️');
  } catch (error) {
    log(`react() failed: ${error.message}`);
  }
};
