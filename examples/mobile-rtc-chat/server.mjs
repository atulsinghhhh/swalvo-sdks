// Backend for the React Native "video call with a chat panel" example.
//
// Identical in shape to examples/rtc-chat's backend, because the security
// model doesn't change on mobile: the API key lives here, the device gets
// two short-lived tokens.
//
// One endpoint returns two independent credentials: an RTC token for the
// media session and a chat token for the messaging session. They're
// minted separately, signed with different keys, and either one can fail
// without taking the other down, which is exactly the separation
// Phase 12 is built around.
//
// Run with:
//   SWALVO_API_KEY=rvk_xxx.yyy node server.mjs
import express from 'express';
import { Swalvo, SwalvoError } from '@swalvo/server';

const swalvo = new Swalvo({
  apiKey: process.env.SWALVO_API_KEY,
  baseUrl: process.env.SWALVO_API_URL,
});

const app = express();
app.use(express.json());

/**
 * Finds or creates the RTC room *and* the conversation attached to it.
 * The attachment is what lets a developer hand `chat.connect()` the same
 * room they handed `client.join()`: one identity, two planes.
 */
async function ensureRoomAndConversation(roomName) {
  const rooms = await swalvo.rooms.list();
  const room =
    rooms.find((candidate) => candidate.name === roomName) ?? (await swalvo.rooms.create({ name: roomName }));

  let conversation;
  try {
    // Resolving by the RTC room's id returns the conversation bound to it.
    conversation = await swalvo.chat.getConversation(room.id);
  } catch (error) {
    if (error instanceof SwalvoError && error.statusCode === 404) {
      conversation = await swalvo.chat.createConversation({
        name: `${roomName}-chat`,
        roomId: room.id,
      });
    } else {
      throw error;
    }
  }

  return { room, conversation };
}

app.post('/api/session', async (req, res) => {
  const { room: roomName, identity } = req.body ?? {};
  if (!roomName || !identity) {
    res.status(400).json({ error: 'room and identity are required' });
    return;
  }

  // As in the other examples: `identity` must come from your own
  // authenticated session in a real app, not from the request body.
  try {
    const { room, conversation } = await ensureRoomAndConversation(roomName);
    await swalvo.chat.addMember(conversation.publicId, { userId: identity, role: 'MEMBER' });

    // Minted independently. Neither token can be used against the other
    // plane: an RTC token is rejected by the chat gateway and vice versa.
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
    if (error instanceof SwalvoError) {
      console.error(`Swalvo session failed [${error.code}] (request ${error.requestId ?? 'n/a'})`);
      res.status(error.statusCode ?? 502).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

const port = process.env.PORT ?? 8790;
app.listen(port, () => {
  console.log(`Swalvo mobile example backend listening on http://localhost:${port}`);
  console.log("Devices on the same Wi-Fi should point BACKEND_URL at this machine's LAN IP, not localhost.");
});
