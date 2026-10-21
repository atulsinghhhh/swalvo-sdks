/**
 * `LiveStream.join()` calls the real `createRTCClient` and
 * `createChatClient` factories from `@swalvo/rtc` and `@swalvo/chat`,
 * and those packages have their own suites covering what a real
 * join/connect does over the network.
 *
 * What's under test here is only LiveStream's composition logic: which
 * credentials go where, what `isHost` reports, and whether `react()` and
 * `leave()` call through to the right underlying method. Both packages are
 * mocked, so nothing here sits waiting on a real WebRTC connection.
 */
import { createChatClient } from '@swalvo/chat';
import { createRTCClient } from '@swalvo/rtc';
import { LiveStream, joinLiveStream } from '../src/live/live-stream';
import type { LiveStreamCredentials } from '../src/live/types';

jest.mock('@swalvo/rtc', () => ({
  createRTCClient: jest.fn(),
}));
jest.mock('@swalvo/chat', () => ({
  createChatClient: jest.fn(),
}));

const mockCreateRTCClient = createRTCClient as jest.Mock;
const mockCreateChatClient = createChatClient as jest.Mock;

/** The bit of a real emitter the wrapper relies on: on() returns an unsubscribe, emit() fires. */
function emitter() {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    on: jest.fn((event: string, handler: (...a: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)!.delete(handler);
    }),
    fire: (event: string, ...args: unknown[]) => handlers.get(event)?.forEach((h) => h(...args)),
  };
}

function fakeRoom() {
  return { roomId: 'stream_abc', leave: jest.fn(), ...emitter() };
}

function fakeRtcClient(room: ReturnType<typeof fakeRoom>) {
  return { join: jest.fn().mockResolvedValue(room), leave: jest.fn().mockResolvedValue(undefined) };
}

function fakeChatClient() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue({}),
    messages: { addReaction: jest.fn().mockResolvedValue({ reactions: [] }) },
    ...emitter(),
  };
}

const RTC_ONLY_CREDENTIALS: LiveStreamCredentials = {
  streamId: 'stream_abc',
  role: 'VIEWER',
  rtc: { token: 'rtc-jwt', endpoint: 'ws://sfu.example' },
};

describe('LiveStream.join()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('joins whatever room the rtc token names, forwarding endpoint/iceServers/telemetryUrl as-is', async () => {
    const room = fakeRoom();
    const rtc = fakeRtcClient(room);
    mockCreateRTCClient.mockReturnValue(rtc);

    const credentials: LiveStreamCredentials = {
      streamId: 'stream_abc',
      role: 'HOST',
      rtc: {
        token: 'rtc-jwt',
        endpoint: 'ws://sfu.example',
        iceServers: [{ urls: 'stun:x' }],
        telemetryUrl: 'https://x',
      },
    };

    await LiveStream.join(credentials);

    expect(mockCreateRTCClient).toHaveBeenCalledWith({
      token: 'rtc-jwt',
      endpoint: 'ws://sfu.example',
      iceServers: [{ urls: 'stun:x' }],
      telemetryUrl: 'https://x',
      // Hosts publish H.264 so HLS/RTMP output can copy it (live-streaming-v2.md §3.3).
      preferredVideoCodec: 'h264',
    });
    // No roomId argument: the token itself names the room, not this field.
    expect(rtc.join).toHaveBeenCalledWith();
  });

  it('never passes rtcRoom to rtc.join() — a cascaded viewer reaches its edge purely through the token', async () => {
    const rtc = fakeRtcClient(fakeRoom());
    mockCreateRTCClient.mockReturnValue(rtc);
    // rtcRoom never actually names the edge (see live-streams.service.ts),
    // but even if something upstream put one here, it must never reach
    // rtc.join() — only the signed token decides which room is joined.
    await LiveStream.join({ ...RTC_ONLY_CREDENTIALS, rtcRoom: 'stream_abc__e2' });
    expect(rtc.join).toHaveBeenCalledWith();
  });

  it('leaves the codec to the browser for a viewer, who never publishes', async () => {
    mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));
    await LiveStream.join(RTC_ONLY_CREDENTIALS);
    expect(mockCreateRTCClient.mock.calls[0][0]).not.toHaveProperty('preferredVideoCodec');
  });

  it('exposes the real Room and RTCClient, not wrappers', async () => {
    const room = fakeRoom();
    const rtc = fakeRtcClient(room);
    mockCreateRTCClient.mockReturnValue(rtc);

    const stream = await LiveStream.join(RTC_ONLY_CREDENTIALS);

    expect(stream.room).toBe(room);
    expect(stream.rtc).toBe(rtc);
  });

  it('never constructs a chat client when the credentials have no chat field', async () => {
    mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));

    const stream = await LiveStream.join(RTC_ONLY_CREDENTIALS);

    expect(mockCreateChatClient).not.toHaveBeenCalled();
    expect(stream.chat).toBeUndefined();
  });

  it('connects chat to the conversation named in credentials.chat.conversations', async () => {
    mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));
    const chat = fakeChatClient();
    mockCreateChatClient.mockReturnValue(chat);

    const credentials: LiveStreamCredentials = {
      ...RTC_ONLY_CREDENTIALS,
      chat: { token: 'chat-jwt', apiUrl: 'https://api.example', conversations: ['conv_xyz'] },
    };

    const stream = await LiveStream.join(credentials);

    expect(mockCreateChatClient).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'chat-jwt', apiUrl: 'https://api.example' }),
    );
    expect(chat.connect).toHaveBeenCalledWith({ room: 'conv_xyz' });
    expect(stream.chat).toBe(chat);
  });

  it('leaves the already-joined RTC room when chat fails to connect, instead of leaking it', async () => {
    const rtc = fakeRtcClient(fakeRoom());
    mockCreateRTCClient.mockReturnValue(rtc);
    const chat = fakeChatClient();
    chat.connect.mockRejectedValue(new Error('chat backend unreachable'));
    mockCreateChatClient.mockReturnValue(chat);

    const credentials: LiveStreamCredentials = {
      ...RTC_ONLY_CREDENTIALS,
      chat: { token: 'chat-jwt', conversations: ['conv_xyz'] },
    };

    await expect(LiveStream.join(credentials)).rejects.toThrow('chat backend unreachable');

    expect(rtc.leave).toHaveBeenCalled();
  });

  describe('isHost', () => {
    it.each([
      ['HOST', true],
      ['CO_HOST', true],
      ['VIEWER', false],
    ] as const)('role %s → isHost is %s', async (role, expected) => {
      mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));

      const stream = await LiveStream.join({ ...RTC_ONLY_CREDENTIALS, role });

      expect(stream.isHost).toBe(expected);
    });
  });

  describe('react()', () => {
    it("adds a reaction to the stream's chatRootMessageId", async () => {
      mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));
      const chat = fakeChatClient();
      mockCreateChatClient.mockReturnValue(chat);

      const stream = await LiveStream.join({
        ...RTC_ONLY_CREDENTIALS,
        chat: { token: 'chat-jwt', conversations: ['conv_xyz'] },
        chatRootMessageId: 'msg_root',
      });

      await stream.react('❤️');

      expect(chat.messages.addReaction).toHaveBeenCalledWith('msg_root', '❤️');
    });

    it('throws, rather than silently no-op-ing, when this instance has no chat credentials', async () => {
      mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));

      const stream = await LiveStream.join(RTC_ONLY_CREDENTIALS);

      await expect(stream.react('❤️')).rejects.toThrow(/no chat credentials/);
    });

    it('throws when the stream has chat but no chatRootMessageId', async () => {
      mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));
      mockCreateChatClient.mockReturnValue(fakeChatClient());

      const stream = await LiveStream.join({
        ...RTC_ONLY_CREDENTIALS,
        chat: { token: 'chat-jwt', conversations: ['conv_xyz'] },
        // chatRootMessageId omitted
      });

      await expect(stream.react('❤️')).rejects.toThrow(/chatRootMessageId/);
    });
  });

  describe('leave()', () => {
    it('leaves the RTC client and disconnects chat', async () => {
      const rtc = fakeRtcClient(fakeRoom());
      mockCreateRTCClient.mockReturnValue(rtc);
      const chat = fakeChatClient();
      mockCreateChatClient.mockReturnValue(chat);

      const stream = await LiveStream.join({
        ...RTC_ONLY_CREDENTIALS,
        chat: { token: 'chat-jwt', conversations: ['conv_xyz'] },
      });
      await stream.leave();

      expect(rtc.leave).toHaveBeenCalled();
      expect(chat.disconnect).toHaveBeenCalled();
    });

    it('leaves cleanly with no chat to disconnect', async () => {
      const rtc = fakeRtcClient(fakeRoom());
      mockCreateRTCClient.mockReturnValue(rtc);

      const stream = await LiveStream.join(RTC_ONLY_CREDENTIALS);

      await expect(stream.leave()).resolves.toBeUndefined();
      expect(rtc.leave).toHaveBeenCalled();
    });
  });

  describe('joinLiveStream (functional alias)', () => {
    it('is the same thing as LiveStream.join', async () => {
      mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));

      const stream = await joinLiveStream(RTC_ONLY_CREDENTIALS);

      expect(stream).toBeInstanceOf(LiveStream);
    });
  });
});

describe('LiveStream stage', () => {
  const CHAT = { token: 'chat-jwt', apiUrl: 'https://api', chatUrl: 'wss://chat', conversations: ['conv_1'] };
  const viewer: LiveStreamCredentials = {
    ...RTC_ONLY_CREDENTIALS,
    identity: 'dave',
    chat: CHAT,
  } as LiveStreamCredentials;
  beforeEach(() => jest.clearAllMocks());

  it('raises a hand as a tagged chat event', async () => {
    const chat = fakeChatClient();
    mockCreateChatClient.mockReturnValue(chat);
    mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));
    const stream = await LiveStream.join(viewer);
    await stream.raiseHand();
    expect(chat.sendMessage).toHaveBeenCalledWith({
      type: 'event',
      metadata: { livqeno: 'stage', action: 'raise_hand' },
    });
  });

  it('trusts invites only from the server, and says when they are for you', async () => {
    const chat = fakeChatClient();
    mockCreateChatClient.mockReturnValue(chat);
    mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));
    const stream = await LiveStream.join(viewer);
    const events: unknown[] = [];
    stream.on('stage', (e) => events.push(e));

    chat.fire('message', { senderId: 'mallory', metadata: { livqeno: 'stage', action: 'invited', identity: 'dave' } });
    chat.fire('message', { senderId: 'system', metadata: { livqeno: 'stage', action: 'invited', identity: 'dave' } });
    chat.fire('message', { senderId: 'erin', metadata: { livqeno: 'stage', action: 'raise_hand' } });
    chat.fire('message', { senderId: 'erin', metadata: { other: true } });

    expect(events).toEqual([
      { action: 'invited', identity: 'dave', role: undefined, forMe: true },
      { action: 'raise_hand', identity: 'erin', forMe: false },
    ]);
  });

  it('switchRole joins the new room before leaving the old one, then re-binds events', async () => {
    const oldRoom = fakeRoom();
    const oldRtc = fakeRtcClient(oldRoom);
    const newRoom = fakeRoom();
    const newRtc = fakeRtcClient(newRoom);
    const order: string[] = [];
    newRtc.join.mockImplementation(async () => {
      order.push('join-new');
      return newRoom;
    });
    oldRtc.leave.mockImplementation(async () => {
      order.push('leave-old');
    });
    mockCreateRTCClient.mockReturnValueOnce(oldRtc).mockReturnValueOnce(newRtc);
    const stream = await LiveStream.join(RTC_ONLY_CREDENTIALS);
    const roles: string[] = [];
    stream.on('roleChanged', (role) => roles.push(role));
    const perms: unknown[] = [];
    stream.on('permissionsChanged', (p) => perms.push(p));

    await stream.switchRole({ ...RTC_ONLY_CREDENTIALS, role: 'CO_HOST' });

    expect(order).toEqual(['join-new', 'leave-old']);
    expect(stream.room).toBe(newRoom);
    expect(stream.isHost).toBe(true);
    expect(roles).toEqual(['CO_HOST']);
    // A host on the new connection prefers H.264.
    expect(mockCreateRTCClient.mock.calls[1][0]).toMatchObject({ preferredVideoCodec: 'h264' });
    // Events now come from the new room, not the old one.
    oldRoom.fire('permissionsChanged', { publish: false });
    newRoom.fire('permissionsChanged', { publish: true });
    expect(perms).toEqual([{ publish: true }]);
  });

  it('passes refreshToken through to the RTC client', async () => {
    mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));
    const refreshToken = jest.fn().mockResolvedValue('new-jwt');
    await LiveStream.join(RTC_ONLY_CREDENTIALS, { refreshToken });
    expect(mockCreateRTCClient.mock.calls[0][0]).toMatchObject({ refreshToken });
  });
});

describe('LiveStream over HLS (BROADCAST viewers)', () => {
  beforeEach(() => jest.clearAllMocks());
  const playbackViewer = {
    streamId: 'stream_abc',
    role: 'VIEWER',
    identity: 'dave',
    playback: { url: 'https://cdn/stream_abc/master.m3u8', status: 'READY' },
  } as LiveStreamCredentials;

  it('joins without an RTC room and says so clearly', async () => {
    const stream = await LiveStream.join(playbackViewer);
    expect(stream.delivery).toBe('hls');
    expect(mockCreateRTCClient).not.toHaveBeenCalled();
    expect(() => stream.room).toThrow(/attachPlayer/);
  });

  it('refuses credentials with neither rtc nor a playback url', async () => {
    await expect(LiveStream.join({ ...playbackViewer, playback: { url: null, status: 'STARTING' } })).rejects.toThrow(
      /acceptPlayback/,
    );
  });

  it('an HLS viewer promoted on stage gets a room', async () => {
    const stream = await LiveStream.join(playbackViewer);
    mockCreateRTCClient.mockReturnValue(fakeRtcClient(fakeRoom()));
    await stream.switchRole({ ...RTC_ONLY_CREDENTIALS, role: 'CO_HOST' });
    expect(stream.delivery).toBe('rtc');
    expect(stream.isHost).toBe(true);
  });
});

describe('LiveStream.setPreferredQuality()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pins every remote video track (not audio) and follows tracks that arrive later', async () => {
    const camera = { kind: 'camera', setLayer: jest.fn() };
    const mic = { kind: 'microphone', setLayer: jest.fn() };
    const room = { ...fakeRoom(), remoteParticipants: [{ tracks: [camera, mic] }] };
    mockCreateRTCClient.mockReturnValue(fakeRtcClient(room as never));
    const stream = await LiveStream.join(RTC_ONLY_CREDENTIALS);

    stream.setPreferredQuality('low');
    expect(camera.setLayer).toHaveBeenCalledWith('low');
    expect(mic.setLayer).not.toHaveBeenCalled();
    expect(stream.preferredQuality).toBe('low');

    const screen = { kind: 'screenShare', setLayer: jest.fn() };
    room.fire('trackSubscribed', screen);
    expect(screen.setLayer).toHaveBeenCalledWith('low');

    stream.setPreferredQuality('auto');
    expect(camera.setLayer).toHaveBeenLastCalledWith('auto');
  });
});

describe('LiveStream captions and agents (phase6 §4)', () => {
  it('re-emits transcription and agent events from the room', async () => {
    const room = fakeRoom();
    mockCreateRTCClient.mockReturnValue(fakeRtcClient(room));
    const stream = await LiveStream.join(RTC_ONLY_CREDENTIALS);
    const seen: unknown[][] = [];
    (stream as unknown as { on: (e: string, h: (...a: unknown[]) => void) => void }).on(
      'transcriptionSegment',
      (...a) => seen.push(['seg', ...a]),
    );
    (stream as unknown as { on: (e: string, h: (...a: unknown[]) => void) => void }).on('agentStateChanged', (...a) =>
      seen.push(['agent', ...a]),
    );
    const segment = {
      type: 'transcription.segment',
      transcriptionId: 't1',
      participantId: 'host',
      segmentId: 's1',
      text: 'hello',
      final: false,
      language: 'en',
      startMs: 0,
      endMs: 500,
    };
    room.fire('transcriptionSegment', segment);
    room.fire('agentStateChanged', { identity: 'agent-1' }, 'speaking');
    expect(seen).toEqual([
      ['seg', segment],
      ['agent', { identity: 'agent-1' }, 'speaking'],
    ]);
  });
});
