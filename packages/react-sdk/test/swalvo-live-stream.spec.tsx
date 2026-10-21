import { FakeParticipant, FakeRoom } from './helpers/fake-rtc-client';

class FakeChatClient {
  readonly userId = 'user-1';
  connectionState = 'connected';
  readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  readonly messages = {
    list: async () => ({ data: [], nextCursor: null, hasMore: false }),
    addReaction: async () => ({ reactions: [] }),
    removeReaction: async () => ({ reactions: [] }),
  };

  on(event: string, handler: (payload: unknown) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  emit(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  disconnect = jest.fn(async () => undefined);
  async getPresence(): Promise<unknown[]> {
    return [];
  }
  async getReadReceipts(): Promise<unknown[]> {
    return [];
  }
}

function fakeStream(overrides: { isHost?: boolean; room?: FakeRoom; chat?: FakeChatClient | null } = {}) {
  const room = overrides.room ?? new FakeRoom('room-1');
  const chat = overrides.chat === null ? undefined : (overrides.chat ?? new FakeChatClient());
  const role = overrides.isHost ? 'HOST' : 'VIEWER';
  return {
    streamId: 'stream_1',
    role,
    rtc: { leave: jest.fn(async () => undefined) },
    room,
    chat,
    isHost: Boolean(overrides.isHost),
    leave: jest.fn(async () => undefined),
    react: jest.fn(async () => undefined),
  };
}

const joinLiveStream = jest.fn();
jest.mock('@swalvo/live', () => ({ joinLiveStream: (...args: unknown[]) => joinLiveStream(...args) }));

import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { SwalvoLiveStream } from '../src/live/swalvo-live-stream';
import { useLiveStream, useLiveStreamHost, useLiveStreamViewer } from '../src/live/live-hooks';
import { useParticipants } from '../src/hooks';
import { useMessages } from '../src/chat/chat-hooks';

const CREDENTIALS = {
  streamId: 'stream_1',
  role: 'VIEWER' as const,
  rtc: { token: 't', endpoint: 'wss://rtc.example.com' },
};

function StatusProbe() {
  const { status, isHost } = useLiveStream();
  return (
    <div data-testid="status">
      {status}:{String(isHost)}
    </div>
  );
}

function ParticipantsProbe() {
  const participants = useParticipants();
  return <div data-testid="participants">{participants.length}</div>;
}

function MessagesProbe() {
  const { messages } = useMessages();
  return <div data-testid="messages">{messages.length}</div>;
}

describe('<SwalvoLiveStream>', () => {
  beforeEach(() => {
    joinLiveStream.mockReset();
  });

  it('shows the fallback while joining, then renders children once ready', async () => {
    let resolveJoin!: (stream: unknown) => void;
    joinLiveStream.mockReturnValue(new Promise((resolve) => (resolveJoin = resolve)));

    render(
      <SwalvoLiveStream credentials={CREDENTIALS} fallback={<div>Connecting…</div>}>
        <div>Live!</div>
      </SwalvoLiveStream>,
    );

    expect(screen.queryByText('Connecting…')).not.toBeNull();
    expect(screen.queryByText('Live!')).toBeNull();

    act(() => resolveJoin(fakeStream()));
    await waitFor(() => expect(screen.queryByText('Live!')).not.toBeNull());
  });

  it('calls onError and shows the fallback when joinLiveStream() rejects', async () => {
    const onError = jest.fn();
    joinLiveStream.mockRejectedValue(new Error('nope'));

    render(
      <SwalvoLiveStream credentials={CREDENTIALS} fallback={<div>Failed</div>} onError={onError}>
        <div>Live!</div>
      </SwalvoLiveStream>,
    );

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.queryByText('Live!')).toBeNull();
  });

  it('exposes role/isHost through useLiveStream()', async () => {
    joinLiveStream.mockResolvedValue(fakeStream({ isHost: true }));

    render(
      <SwalvoLiveStream credentials={{ ...CREDENTIALS, role: 'HOST' }}>
        <StatusProbe />
      </SwalvoLiveStream>,
    );

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready:true'));
  });

  it('makes useParticipants() work automatically, without a separate live-streaming hook', async () => {
    const room = new FakeRoom('room-1');
    joinLiveStream.mockResolvedValue(fakeStream({ room }));

    render(
      <SwalvoLiveStream credentials={CREDENTIALS}>
        <ParticipantsProbe />
      </SwalvoLiveStream>,
    );
    await waitFor(() => expect(screen.getByTestId('participants').textContent).toBe('1')); // local participant

    act(() => {
      room.remoteParticipants.push(new FakeParticipant('bob'));
      room.emit('participantJoined');
    });

    await waitFor(() => expect(screen.getByTestId('participants').textContent).toBe('2'));
  });

  it('makes useMessages() work automatically when the stream has chat', async () => {
    const chat = new FakeChatClient();
    joinLiveStream.mockResolvedValue(fakeStream({ chat }));

    render(
      <SwalvoLiveStream credentials={{ ...CREDENTIALS, chat: { token: 't', conversations: ['conv_1'] } }}>
        <MessagesProbe />
      </SwalvoLiveStream>,
    );
    await waitFor(() => expect(screen.getByTestId('messages').textContent).toBe('0'));

    act(() => chat.emit('message', { id: 'm1', reactions: [] }));

    await waitFor(() => expect(screen.getByTestId('messages').textContent).toBe('1'));
  });

  it('never calls client.connect()/disconnect() a chat client already connected before joining', async () => {
    const chat = new FakeChatClient();
    joinLiveStream.mockResolvedValue(fakeStream({ chat }));

    const { unmount } = render(
      <SwalvoLiveStream credentials={{ ...CREDENTIALS, chat: { token: 't', conversations: ['conv_1'] } }}>
        <div>Live!</div>
      </SwalvoLiveStream>,
    );
    await waitFor(() => expect(screen.queryByText('Live!')).not.toBeNull());

    unmount();

    // Teardown goes through stream.leave(), never the store's own
    // disconnect. Do both and the socket gets disconnected twice.
    expect(chat.disconnect).not.toHaveBeenCalled();
  });

  it('calls stream.leave() exactly once on unmount', async () => {
    const stream = fakeStream();
    joinLiveStream.mockResolvedValue(stream);

    const { unmount } = render(
      <SwalvoLiveStream credentials={CREDENTIALS}>
        <div>Live!</div>
      </SwalvoLiveStream>,
    );
    await waitFor(() => expect(screen.queryByText('Live!')).not.toBeNull());

    unmount();

    // Chained onto the settle-serialization promise now (see the
    // Strict-Mode-safety test below for why), so it resolves a tick or two
    // after unmount() returns rather than synchronously within it.
    await waitFor(() => expect(stream.leave).toHaveBeenCalledTimes(1));
  });

  it('under Strict Mode double-invoke, calls joinLiveStream() at most once and still reaches ready cleanly', async () => {
    // <StrictMode> makes React mount this effect, run its cleanup, then
    // mount it again — synchronously, inside render(), all before any
    // microtask (including the settle-chain's own `.then()`s) gets a
    // chance to run. That means the *first* invocation's `cancelled` flag
    // is already `true` by the time its chained call would fire, so it
    // never calls joinLiveStream() at all — only the surviving second
    // invocation's join actually reaches the network. Without the
    // settle-chain serialization, both invocations called joinLiveStream()
    // unconditionally and synchronously, so this is 2 calls on the old
    // code and 1 on the fixed code — the same asymmetry that let the
    // server see two live sessions for one identity in the real bug.
    const stream = fakeStream();
    joinLiveStream.mockResolvedValue(stream);

    render(
      <StrictMode>
        <SwalvoLiveStream credentials={CREDENTIALS}>
          <div>Live!</div>
        </SwalvoLiveStream>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.queryByText('Live!')).not.toBeNull());
    expect(joinLiveStream).toHaveBeenCalledTimes(1);
    // The surviving session was never mistaken for an abandoned one.
    expect(stream.leave).not.toHaveBeenCalled();
  });

  it('serializes overlapping joins when cancellation happens while the first join is still genuinely in flight', async () => {
    // Covers the case Strict Mode's synchronous timing doesn't: a real
    // remount (switching streams) while the first join hasn't resolved
    // yet. Here `cancelled` only becomes true *after* joinLiveStream() was
    // already called and is awaiting its result, so the abandoned stream
    // does need an explicit leave() once it arrives — and the next join
    // must wait for that leave() before it starts.
    let resolveJoin1!: (stream: unknown) => void;
    const join1 = new Promise((resolve) => (resolveJoin1 = resolve));
    joinLiveStream.mockReturnValueOnce(join1);

    const { rerender } = render(
      <SwalvoLiveStream credentials={CREDENTIALS}>
        <div>Live!</div>
      </SwalvoLiveStream>,
    );
    await waitFor(() => expect(joinLiveStream).toHaveBeenCalledTimes(1));

    // A genuine remount: different streamId, same component position, so
    // React tears down the old effect instance and runs a new one — the
    // first join is still pending.
    rerender(
      <SwalvoLiveStream credentials={{ ...CREDENTIALS, streamId: 'stream_2' }}>
        <div>Live!</div>
      </SwalvoLiveStream>,
    );
    await Promise.resolve();
    await Promise.resolve();
    // The second join must not have started yet — it's waiting on the
    // first's teardown, which can't happen until join1 resolves.
    expect(joinLiveStream).toHaveBeenCalledTimes(1);

    const stream1 = fakeStream();
    act(() => resolveJoin1(stream1));
    await waitFor(() => expect(stream1.leave).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(joinLiveStream).toHaveBeenCalledTimes(2));
  });

  it('useLiveStreamHost() throws for a VIEWER-role stream', async () => {
    joinLiveStream.mockResolvedValue(fakeStream({ isHost: false }));
    let caught: unknown;
    function HostProbe() {
      try {
        useLiveStreamHost();
      } catch (error) {
        caught = error;
      }
      return null;
    }

    render(
      <SwalvoLiveStream credentials={CREDENTIALS}>
        <HostProbe />
      </SwalvoLiveStream>,
    );

    await waitFor(() => expect(caught).toBeInstanceOf(Error));
  });

  it('useLiveStreamViewer() throws for a HOST-role stream', async () => {
    joinLiveStream.mockResolvedValue(fakeStream({ isHost: true }));
    let caught: unknown;
    function ViewerProbe() {
      try {
        useLiveStreamViewer();
      } catch (error) {
        caught = error;
      }
      return null;
    }

    render(
      <SwalvoLiveStream credentials={{ ...CREDENTIALS, role: 'HOST' }}>
        <ViewerProbe />
      </SwalvoLiveStream>,
    );

    await waitFor(() => expect(caught).toBeInstanceOf(Error));
  });
});
