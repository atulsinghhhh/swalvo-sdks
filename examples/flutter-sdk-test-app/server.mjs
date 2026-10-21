// Dev-helper backend for the Flutter SDK integration test app.
//
// Same security model as every other Swalvo example
// (examples/flutter-rtc-chat/server.mjs): the API key lives here, never on
// a device. The one difference from that example is that this backend's
// config is *settable at runtime* via POST /api/configure, so the test
// app's Config screen can hand it a key typed in by the developer instead
// of requiring an env var and a restart. Either way the key only ever
// lives in this process's memory — it is never written to disk, never
// logged, and never echoed back in a response.
//
// Run with:
//   node server.mjs
//   # then, from the Flutter app's Config screen, POST your API key to
//   # /api/configure — or export SWALVO_API_KEY/SWALVO_API_URL first to
//   # skip that step.
import express from 'express';
import { Swalvo, SwalvoError } from '@swalvo/server';

let config = {
  apiKey: process.env.SWALVO_API_KEY || null,
  baseUrl: process.env.SWALVO_API_URL || null,
};
let swalvo = config.apiKey ? new Swalvo({ apiKey: config.apiKey, baseUrl: config.baseUrl }) : null;

function requireConfigured(res) {
  if (!swalvo) {
    res.status(400).json({ error: 'Not configured: POST /api/configure first (or set SWALVO_API_KEY).' });
    return false;
  }
  return true;
}

/**
 * Finds or creates the RTC room *and* the conversation attached to it.
 * Identical to examples/flutter-rtc-chat/server.mjs's helper — the RTC +
 * chat pairing doesn't change just because this is a test harness.
 *
 * `getOrCreate: true` on both calls is load-bearing, not cosmetic: two
 * callers hitting this at the same time for the same room name (the
 * ordinary "everyone joins by room name" case — exactly what happens when
 * two clients connect within the same event loop tick, which two browser
 * tabs/contexts against a Flutter Web build do easily) used to race a
 * list-then-create that had no atomicity between the two steps. Both
 * could see the room as absent and both call `rooms.create()`; the loser
 * got a raw `BackendException(409)` surfaced straight to the user instead
 * of just getting the winner's room back. `getOrCreate` makes the
 * find-or-create atomic server-side, so there is no window to lose a race
 * in — reproduced and confirmed via two concurrent Playwright browser
 * contexts hitting this exact path before this fix.
 */
async function ensureRoomAndConversation(roomName) {
  const room = await swalvo.rooms.create({ name: roomName, getOrCreate: true });
  const conversation = await swalvo.chat.createConversation({
    name: `${roomName}-chat`,
    roomId: room.id,
    getOrCreate: true,
  });
  return { room, conversation };
}

function sendSwalvoError(res, error) {
  if (error instanceof SwalvoError) {
    console.error(`Swalvo request failed [${error.code}] (request ${error.requestId ?? 'n/a'})`);
    res.status(error.statusCode ?? 502).json({ error: error.message, code: error.code });
    return;
  }
  throw error;
}

const app = express();
app.use(express.json());

// Flutter Web runs this app from a browser origin (e.g. http://localhost:PORT
// from `flutter run -d chrome`, or a static file server during `flutter build
// web` testing) that's never the same origin as this dev-helper. A browser
// enforces CORS even for localhost-to-localhost calls, so without this every
// request from the Web build fails before it reaches any route below —
// Android/iOS/desktop builds are unaffected (no browser, no CORS). Wide open
// is fine here specifically: this is a never-shipped local dev tool with no
// cookies or ambient credentials — the only thing it holds is the API key
// POSTed to it directly, same trust boundary either way.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// Configuration -------------------------------------------------------------

app.post('/api/configure', (req, res) => {
  const { apiKey, baseUrl } = req.body ?? {};
  if (!apiKey || typeof apiKey !== 'string') {
    res.status(400).json({ error: 'apiKey is required' });
    return;
  }
  config = { apiKey, baseUrl: baseUrl || null };
  swalvo = new Swalvo({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  // Never echo the key back, and never log it.
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ configured: Boolean(swalvo), baseUrl: config.baseUrl });
});

// RTC + chat session, same shape as the flutter-rtc-chat example ------------

app.post('/api/session', async (req, res) => {
  if (!requireConfigured(res)) return;

  const { room: roomName, identity } = req.body ?? {};
  if (!roomName || !identity) {
    res.status(400).json({ error: 'room and identity are required' });
    return;
  }

  try {
    const { room, conversation } = await ensureRoomAndConversation(roomName);
    await swalvo.chat.addMember(conversation.publicId, { userId: identity, role: 'MEMBER' });

    const [rtc, chat] = await Promise.all([
      swalvo.tokens.create({
        room: room.id,
        identity,
        permissions: {
          join: true,
          subscribe: true,
          publish: true,
          publishAudio: true,
          publishVideo: true,
        },
        expiresIn: 3600,
      }),
      swalvo.chat.createToken({
        userId: identity,
        conversations: [conversation.publicId],
        expiresIn: 3600,
      }),
    ]);

    res.json({
      identity,
      rtc,
      chat: { ...chat, roomId: conversation.publicId },
    });
  } catch (error) {
    sendSwalvoError(res, error);
  }
});

// Live streaming --------------------------------------------------------

app.post('/api/live/host', async (req, res) => {
  if (!requireConfigured(res)) return;

  const { streamId: existingStreamId, title, identity } = req.body ?? {};
  if (!identity) {
    res.status(400).json({ error: 'identity is required' });
    return;
  }

  try {
    let streamId = existingStreamId;
    if (!streamId) {
      if (!title) {
        res.status(400).json({ error: 'title is required when creating a new stream' });
        return;
      }
      const stream = await swalvo.liveStreams.create({ title, hostIdentity: identity });
      streamId = stream.id;
    }

    const credential = await swalvo.liveStreams.addHost(streamId, { identity });
    res.json({ ...credential, streamId: credential.streamId ?? streamId });
  } catch (error) {
    sendSwalvoError(res, error);
  }
});

app.post('/api/live/viewer', async (req, res) => {
  if (!requireConfigured(res)) return;

  const { streamId, identity, acceptPlayback } = req.body ?? {};
  if (!streamId || !identity) {
    res.status(400).json({ error: 'streamId and identity are required' });
    return;
  }

  try {
    const credential = await swalvo.liveStreams.createViewerToken(streamId, identity, {
      acceptPlayback: Boolean(acceptPlayback),
    });
    res.json({ ...credential, streamId: credential.streamId ?? streamId });
  } catch (error) {
    sendSwalvoError(res, error);
  }
});

app.get('/api/live/:streamId/status', async (req, res) => {
  if (!requireConfigured(res)) return;

  try {
    const stream = await swalvo.liveStreams.get(req.params.streamId);
    res.json({
      streamId: req.params.streamId,
      status: stream.status,
      viewerCount: stream.viewerCount,
      peakViewerCount: stream.peakViewerCount,
    });
  } catch (error) {
    sendSwalvoError(res, error);
  }
});

app.post('/api/live/:streamId/start', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    await swalvo.liveStreams.start(req.params.streamId);
    res.json({ ok: true });
  } catch (error) {
    sendSwalvoError(res, error);
  }
});

app.post('/api/live/:streamId/end', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    await swalvo.liveStreams.end(req.params.streamId);
    res.json({ ok: true });
  } catch (error) {
    sendSwalvoError(res, error);
  }
});

const port = process.env.PORT ?? 8792;
app.listen(port, () => {
  console.log(`Swalvo SDK test-app backend listening on http://localhost:${port}`);
  console.log(
    config.apiKey
      ? 'Configured from SWALVO_API_KEY.'
      : 'Not configured yet — POST /api/configure or set SWALVO_API_KEY and restart.',
  );
  console.log("Devices on the same Wi-Fi should point the app's backend URL at this machine's LAN IP, not localhost.");
});
