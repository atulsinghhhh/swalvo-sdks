import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  ChannelList,
  ChatProvider,
  MessageComposer,
  MessageList,
  useInbox,
  useModeration,
  usePresenceCount,
  useUnreadCount,
} from '../src/chat';
import { FakeChatClient, inboxRow, message } from './helpers/fake-chat-client';

/**
 * The Phase 3 hooks and the UI kit, rendered inside <ChatProvider client>
 * against a fake client. The inbox and moderation state are the real
 * @swalvo/chat classes (see helpers/fake-chat-client.ts).
 */
function renderWith(client: FakeChatClient, children: ReactNode) {
  return render(<ChatProvider client={client as never}>{children}</ChatProvider>);
}

/** Lets the stores' async start (join, first page) settle inside act. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useInbox / useUnreadCount', () => {
  it('loads the inbox once and keeps the badge current as messages arrive', async () => {
    const client = new FakeChatClient();
    client.inboxPages = [
      {
        conversations: [inboxRow('conv_1', { unreadCount: 2 }), inboxRow('conv_2', { unreadCount: 1 })],
        nextCursor: null,
      },
    ];
    let total = -1;
    let one = -1;
    let rows = 0;
    function Probe() {
      rows = useInbox().conversations.length;
      total = useUnreadCount();
      one = useUnreadCount('conv_2');
      return null;
    }

    renderWith(client, <Probe />);
    await settle();
    expect(rows).toBe(2);
    expect(total).toBe(3);
    expect(one).toBe(1);

    act(() => {
      client.emit('message', message('m_new', { roomId: 'conv_2', seq: '11', createdAt: '2026-01-03T00:00:00.000Z' }));
    });
    expect(total).toBe(4);
    expect(one).toBe(2);
  });

  it('is empty, and loads nothing, for a live-stream audience viewer', async () => {
    const client = new FakeChatClient();
    client.isAudienceViewer = true;
    const load = jest.spyOn(client.inbox, 'load');
    let total = -1;
    function Probe() {
      total = useUnreadCount();
      return null;
    }
    renderWith(client, <Probe />);
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(total).toBe(0);
  });
});

describe('useModeration', () => {
  it('re-renders when this user is muted and unmuted, and binds moderator actions to the room', async () => {
    const client = new FakeChatClient();
    let result: ReturnType<typeof useModeration> | undefined;
    function Probe() {
      result = useModeration('conv_1');
      return null;
    }
    renderWith(client, <Probe />);
    expect(result!.muted).toBe(false);

    act(() => client.emitModeration('muted', { userId: 'alice', expiresAt: '2999-01-01T00:00:00.000Z' }));
    expect(result!.muted).toBe(true);
    expect(result!.mutedUntil).toBe('2999-01-01T00:00:00.000Z');

    // Someone else's mute is not ours.
    act(() => client.emitModeration('unmuted', { userId: 'bob' }));
    expect(result!.muted).toBe(true);

    act(() => client.emitModeration('unmuted', { userId: 'alice' }));
    expect(result!.muted).toBe(false);

    await act(async () => {
      await result!.ban('bob', { durationSeconds: 60 });
    });
    expect(client.moderationRequests).toEqual([
      { type: 'moderation.ban', payload: { room: 'conv_1', userId: 'bob', durationSeconds: 60, reason: undefined } },
    ]);
  });
});

describe('usePresenceCount', () => {
  it('counts online members, then switches to the server count for a large room', async () => {
    const client = new FakeChatClient();
    let count = -1;
    function Probe() {
      count = usePresenceCount('conv_1');
      return null;
    }
    renderWith(client, <Probe />);
    await settle();

    act(() => {
      client.emit('presence', { userId: 'bob', roomId: 'conv_1', status: 'online', at: 'now' });
      client.emit('presence', { userId: 'carol', roomId: 'conv_1', status: 'away', at: 'now' });
    });
    expect(count).toBe(1);

    act(() => client.emit('presenceCount', { roomId: 'conv_1', online: 1234 }));
    expect(count).toBe(1234);
  });
});

describe('<ChannelList>', () => {
  it('renders conversations with an unread badge and reports a selection', async () => {
    const client = new FakeChatClient();
    client.inboxPages = [
      {
        conversations: [
          inboxRow('conv_1', { name: 'General', unreadCount: 3 }),
          inboxRow('conv_2', { name: 'Random' }),
        ],
        nextCursor: null,
      },
    ];
    const onSelect = jest.fn();
    renderWith(client, <ChannelList onSelect={onSelect} selectedId="conv_2" />);
    await settle();

    expect(screen.getByText('General')).toBeTruthy();
    expect(screen.getByLabelText('3 unread').textContent).toBe('3');
    expect(screen.getByText('Random').closest('button')!.getAttribute('data-selected')).toBe('true');

    fireEvent.click(screen.getByText('General'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'conv_1' }));
  });
});

describe('<MessageList>', () => {
  it('renders only the newest window, and reveals older rows on demand', async () => {
    const client = new FakeChatClient();
    const history = Array.from({ length: 30 }, (_, i) =>
      message(`m${i}`, {
        seq: String(i),
        text: `text ${i}`,
        createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      }),
    ).reverse();
    client.pages = [{ data: history, nextCursor: null, hasMore: false }];

    const { container } = renderWith(
      client,
      <MessageList room="conv_1" windowSize={10} overscan={0} markReadOnView={false} />,
    );
    await settle();

    expect(container.querySelectorAll('.swalvo-message')).toHaveLength(10);
    expect(screen.getByText('text 29')).toBeTruthy();
    expect(screen.queryByText('text 0')).toBeNull();

    fireEvent.click(screen.getByText('Load older messages'));
    expect(container.querySelectorAll('.swalvo-message')).toHaveLength(20);
  });

  it('shows a failed send with retry and delete buttons that drive the outbox', async () => {
    const client = new FakeChatClient();
    client.outboxEntries = [
      {
        clientMessageId: 'cm_f',
        room: 'conv_1',
        userId: 'alice',
        text: 'did not go',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'failed',
        attempts: 1,
        error: { code: 'MESSAGE_BLOCKED', message: 'Blocked by moderation' },
      },
    ];
    const { container } = renderWith(client, <MessageList room="conv_1" markReadOnView={false} />);
    await settle();

    const row = container.querySelector('.swalvo-message')!;
    expect(row.getAttribute('data-status')).toBe('failed');
    expect(row.getAttribute('data-own')).toBe('true');
    expect(screen.getByText('Blocked by moderation')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('Retry'));
    });
    expect(client.outbox.retry).toHaveBeenCalledWith('cm_f');
    await waitFor(() => expect(container.querySelector('.swalvo-message')!.getAttribute('data-status')).toBe('sent'));
  });

  it('renders a link preview card', async () => {
    const client = new FakeChatClient();
    client.pages = [
      {
        data: [
          message('m1', { linkPreview: { url: 'https://example.com/a', title: 'Example title', siteName: 'Example' } }),
        ],
        nextCursor: null,
        hasMore: false,
      },
    ];
    renderWith(client, <MessageList room="conv_1" markReadOnView={false} />);
    await settle();
    expect(screen.getByText('Example title').closest('a')!.getAttribute('href')).toBe('https://example.com/a');
  });
});

describe('<MessageComposer>', () => {
  it('sends on Enter with the picked mentions, and Shift+Enter does not send', async () => {
    const client = new FakeChatClient();
    renderWith(client, <MessageComposer room="conv_1" mentionCandidates={[{ id: 'user_bob', name: 'bob' }]} />);
    await settle();
    const input = screen.getByLabelText('Message');

    fireEvent.change(input, { target: { value: 'hey @b' } });
    fireEvent.click(screen.getByText('@bob'));
    expect((input as HTMLTextAreaElement).value).toBe('hey @bob ');

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(client.sent).toHaveLength(0);

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(client.sent).toEqual([
      expect.objectContaining({ room: 'conv_1', text: 'hey @bob', mentions: ['user_bob'] }),
    ]);
    expect((input as HTMLTextAreaElement).value).toBe('');
  });

  it('disables itself with a countdown when slow mode refuses a send', async () => {
    const client = new FakeChatClient();
    client.sendBehaviour = async () => {
      throw Object.assign(new Error('slow'), { code: 'SLOW_MODE', retryAfterSeconds: 30 });
    };
    renderWith(client, <MessageComposer room="conv_1" />);
    await settle();
    const input = screen.getByLabelText('Message');

    fireEvent.change(input, { target: { value: 'too soon' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect((input as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText('30s')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Slow mode: wait 30s/);
  });

  it('is disabled while this user is muted', async () => {
    const client = new FakeChatClient();
    renderWith(client, <MessageComposer room="conv_1" />);
    await settle();
    act(() => client.emitModeration('muted', { userId: 'alice' }));
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('uploads an attachment first and sends its id', async () => {
    const client = new FakeChatClient();
    const { container } = renderWith(client, <MessageComposer room="conv_1" />);
    await settle();
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    await act(async () => {
      fireEvent.click(screen.getByText('Send'));
    });
    expect(client.attachments.upload).toHaveBeenCalledWith(file, { room: 'conv_1' });
    expect(client.sent[0]).toMatchObject({ attachmentId: 'att_1' });
  });
});
