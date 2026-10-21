// Backend for the Swalvo Chat example.
//
// The whole point of this file is the boundary it draws: SWALVO_API_KEY
// lives here and only here. The browser authenticates against *this*
// server however your app already does it, and gets back a short-lived
// chat token scoped to one user: never the project key.
//
// Run with:
//   SWALVO_API_KEY=rvk_xxx.yyy node server.mjs
import express from 'express';
import { Swalvo, SwalvoError } from '@swalvo/server';

const swalvo = new Swalvo({
  apiKey: process.env.SWALVO_API_KEY,
  baseUrl: process.env.SWALVO_API_URL, // defaults to http://localhost:4100
});

const ROOM = process.env.SWALVO_CHAT_ROOM ?? 'example-chat';

const app = express();
app.use(express.json());

/**
 * Makes sure the conversation exists before anyone tries to join it.
 * Provisioning is a backend job: a browser holding a chat token can't
 * create conversations, by design.
 */
async function ensureConversation() {
  try {
    return await swalvo.chat.getConversation(ROOM);
  } catch (error) {
    if (error instanceof SwalvoError && error.statusCode === 404) {
      return swalvo.chat.createConversation({ name: ROOM });
    }
    throw error;
  }
}

app.post('/api/chat/token', async (req, res) => {
  const { userId } = req.body ?? {};
  if (!userId || !/^[a-zA-Z0-9_.-]{1,128}$/.test(userId)) {
    res.status(400).json({ error: 'userId is required (letters, numbers, -, _, . only)' });
    return;
  }

  // In a real app `userId` comes from your own authenticated session
  // (req.user.id), never from the request body: otherwise anyone can
  // ask for a token as anyone. Kept simple here so the example runs
  // without an auth system. Same caveat as examples/node-server.
  try {
    const conversation = await ensureConversation();

    // Membership is what authorizes the user inside the conversation;
    // the token alone isn't enough (see docs/chat/overview.md#authorization).
    await swalvo.chat.addMember(conversation.publicId, { userId, role: 'MEMBER' });

    const token = await swalvo.chat.createToken({
      userId,
      conversations: [conversation.publicId],
      expiresIn: 3600,
    });

    res.json({ ...token, roomId: conversation.publicId, roomName: conversation.name });
  } catch (error) {
    if (error instanceof SwalvoError) {
      console.error(`Swalvo chat token failed [${error.code}] (request ${error.requestId ?? 'n/a'})`);
      res.status(error.statusCode ?? 502).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

/**
 * A system message: the one message type a browser token cannot send.
 * Wired up here so the example can demonstrate it, and to show where
 * server-authored announcements belong.
 */
app.post('/api/chat/announce', async (req, res) => {
  const { text } = req.body ?? {};
  try {
    const conversation = await ensureConversation();
    const message = await swalvo.chat.sendMessage(conversation.publicId, {
      text: String(text ?? '').slice(0, 500),
      senderId: 'system',
      type: 'system',
    });
    res.json(message);
  } catch (error) {
    if (error instanceof SwalvoError) {
      res.status(error.statusCode ?? 502).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

const port = process.env.PORT ?? 8788;
app.listen(port, () => {
  console.log(`Swalvo chat example backend listening on http://localhost:${port}`);
  console.log(`Conversation: ${ROOM}`);
});
