// Swalvo video-call example: built entirely on @swalvo/rtc's public API.
// No SDP, no ICE candidates, and no RTCPeerConnection appear anywhere in
// this file.
import { createRTCClient, isRTCError } from '@swalvo/rtc';

const $ = (id) => document.getElementById(id);

const tokenInput = $('tokenInput');
const joinButton = $('joinButton');
const leaveButton = $('leaveButton');
const micButton = $('micButton');
const cameraButton = $('cameraButton');
const statusEl = $('status');
const localVideoContainer = $('localVideo');
const remoteVideosContainer = $('remoteVideos');
const logEl = $('log');

let client;
let room;
let micEnabled = false;
let cameraEnabled = false;

function log(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function describeError(error) {
  return isRTCError(error) ? `${error.code} — ${error.message}` : String(error);
}

joinButton.addEventListener('click', async () => {
  let parsed;
  try {
    parsed = JSON.parse(tokenInput.value);
  } catch {
    log('paste the full JSON body returned by POST /v1/rooms/:roomId/rtc-tokens first');
    return;
  }

  // This is the entire authentication flow the developer needs to think
  // about: forward token/endpoint/iceServers/telemetryUrl from your
  // backend's RTC token response: never mint that token in the browser
  // (docs/sdk.md#authentication). telemetryUrl enables best-effort
  // connection telemetry (docs/telemetry.md); omit it, or pass
  // `telemetry: false`, to disable telemetry entirely.
  client = createRTCClient({
    token: parsed.token,
    endpoint: parsed.endpoint,
    iceServers: parsed.iceServers,
    telemetryUrl: parsed.telemetryUrl,
    logLevel: 'warn',
  });

  try {
    setStatus('connecting');
    room = await client.join(parsed.roomName);
  } catch (error) {
    setStatus('failed');
    log(`join failed: ${describeError(error)}`);
    return;
  }

  joinButton.disabled = true;
  leaveButton.disabled = false;
  micButton.disabled = false;
  cameraButton.disabled = false;
  setStatus(room.connectionState);
  log(`joined room "${room.roomId}" as "${room.localParticipant.identity}" (${room.connectionId})`);

  room.on('connectionStateChanged', (state) => setStatus(state));
  room.on('reconnecting', () => log('reconnecting...'));
  room.on('reconnected', () => log('reconnected'));
  room.on('disconnected', () => log('disconnected'));
  room.on('error', (error) => log(`error: ${error.code} — ${error.message}`));

  room.on('participantJoined', (participant) => log(`participant joined: ${participant.identity}`));
  room.on('participantLeft', (participant) => {
    log(`participant left: ${participant.identity}`);
    document.getElementById(`participant-${participant.identity}`)?.remove();
  });

  room.on('trackSubscribed', (track, participant) => {
    log(`subscribed to ${track.kind} from ${participant.identity}`);
    const container = remoteParticipantContainer(participant.identity);
    container.appendChild(track.attach());
  });

  // Participants already in the room (and their already-subscribed tracks)
  // are available synchronously on room.remoteParticipants right away;
  // participantJoined/trackSubscribed only fire for arrivals *after* this
  // point, the same convention most real-time SDKs follow. Render anyone
  // already present before relying on the events above for new arrivals.
  for (const participant of room.remoteParticipants) {
    log(`already in room: ${participant.identity}`);
    const container = remoteParticipantContainer(participant.identity);
    for (const track of participant.tracks) {
      log(`already subscribed to ${track.kind} from ${participant.identity}`);
      container.appendChild(track.attach());
    }
  }

  room.on('trackUnsubscribed', (track, participant) => {
    log(`unsubscribed from ${track.kind} of ${participant.identity}`);
    track.detach().forEach((el) => el.remove());
  });
});

function remoteParticipantContainer(identity) {
  let container = document.getElementById(`participant-${identity}`);
  if (!container) {
    container = document.createElement('div');
    container.id = `participant-${identity}`;
    container.className = 'participant';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = identity;
    container.appendChild(label);
    remoteVideosContainer.appendChild(container);
  }
  return container;
}

micButton.addEventListener('click', async () => {
  if (!room) return;
  micEnabled = !micEnabled;
  micButton.textContent = `Mic: ${micEnabled ? 'on' : 'off'}`;
  try {
    if (micEnabled) {
      await room.enableMicrophone();
      log('microphone enabled');
    } else {
      await room.disableMicrophone();
      log('microphone disabled');
    }
  } catch (error) {
    micEnabled = !micEnabled;
    micButton.textContent = `Mic: ${micEnabled ? 'on' : 'off'}`;
    log(`microphone error: ${describeError(error)}`);
  }
});

cameraButton.addEventListener('click', async () => {
  if (!room) return;
  cameraEnabled = !cameraEnabled;
  cameraButton.textContent = `Camera: ${cameraEnabled ? 'on' : 'off'}`;
  try {
    if (cameraEnabled) {
      const track = await room.enableCamera();
      log('camera enabled');
      if (track) {
        localVideoContainer.innerHTML = '';
        localVideoContainer.appendChild(track.attach());
      }
    } else {
      await room.disableCamera();
      localVideoContainer.innerHTML = '(camera off)';
      log('camera disabled');
    }
  } catch (error) {
    cameraEnabled = !cameraEnabled;
    cameraButton.textContent = `Camera: ${cameraEnabled ? 'on' : 'off'}`;
    log(`camera error: ${describeError(error)}`);
  }
});

leaveButton.addEventListener('click', async () => {
  await client?.leave();
  room = undefined;
  micEnabled = false;
  cameraEnabled = false;
  joinButton.disabled = false;
  leaveButton.disabled = true;
  micButton.disabled = true;
  cameraButton.disabled = true;
  micButton.textContent = 'Mic: off';
  cameraButton.textContent = 'Camera: off';
  localVideoContainer.innerHTML = '(not joined)';
  remoteVideosContainer.innerHTML = '';
  setStatus('left');
  log('left the room');
});
