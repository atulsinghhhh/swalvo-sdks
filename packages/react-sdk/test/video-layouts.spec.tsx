jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'));

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { lastClient, resetFakeRtc } from './helpers/fake-rtc-client';
import { FakePeer, FakeTrack, publishOnEnable, renderInRoom, videoRoom } from './helpers/fake-video';
import { GridLayout } from '../src/video/layouts';
import { VideoConference } from '../src/video/video-conference';
import { gridColumns, usePagination, useTracks } from '../src/video/video-hooks';

function peers(count: number): FakePeer[] {
  return Array.from({ length: count }, (_, i) => new FakePeer(`p${i + 1}`).withTracks('camera'));
}

describe('useTracks', () => {
  beforeEach(() => resetFakeRtc());

  it('lists cameras with placeholders plus screen shares, local first, and follows the roster', async () => {
    const alice = new FakePeer('alice').withTracks('camera', 'screenShare');
    const bob = new FakePeer('bob');
    const room = videoRoom([alice, bob]);
    function Probe() {
      const refs = useTracks();
      return (
        <div data-testid="refs">
          {refs
            .map(
              (r) => `${r.participant.identity}:${r.source}:${r.track ? 'track' : 'none'}${r.isLocal ? ':local' : ''}`,
            )
            .join(' ')}
        </div>
      );
    }
    await renderInRoom(<Probe />, room);
    expect(screen.getByTestId('refs').textContent).toBe(
      'local-user:camera:none:local alice:camera:track alice:screenShare:track bob:camera:none',
    );

    const carol = new FakePeer('carol');
    act(() => {
      room.remoteParticipants = [...room.remoteParticipants, carol as never];
      room.emit('participantJoined', carol);
    });
    expect(screen.getByTestId('refs').textContent).toContain('carol:camera:none');

    act(() => {
      room.remoteParticipants = room.remoteParticipants.filter((p) => p !== (alice as never));
      room.emit('participantLeft', alice);
    });
    expect(screen.getByTestId('refs').textContent).not.toContain('alice');
  });

  it('includes published-but-unsubscribed sources unless onlySubscribed', async () => {
    const bob = new FakePeer('bob');
    const room = videoRoom([bob]);
    function Probe({ onlySubscribed }: { onlySubscribed: boolean }) {
      const refs = useTracks(['screenShare'], { onlySubscribed });
      return (
        <div data-testid={`refs-${onlySubscribed}`}>{refs.map((r) => r.participant.identity).join(',') || 'none'}</div>
      );
    }
    await renderInRoom(
      <>
        <Probe onlySubscribed={false} />
        <Probe onlySubscribed />
      </>,
      room,
    );
    act(() => room.emit('trackPublished', 'screenShare', bob));
    expect(screen.getByTestId('refs-false').textContent).toBe('bob');
    expect(screen.getByTestId('refs-true').textContent).toBe('none');
  });

  it('keeps the same array while nothing relevant changed', async () => {
    const room = videoRoom([new FakePeer('a').withTracks('camera')]);
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useTracks());
      return null;
    }
    await renderInRoom(<Probe />, room);
    act(() => room.emit('trackMuted', 'microphone', room.remoteParticipants[0]));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(seen[seen.length - 2]);
  });
});

describe('pagination helpers', () => {
  it('picks square-ish grids', () => {
    expect([1, 2, 3, 4, 5, 9, 10, 16, 20].map((n) => gridColumns(n))).toEqual([1, 2, 2, 2, 3, 3, 4, 4, 5]);
    expect(gridColumns(2, true)).toBe(1);
    expect(gridColumns(4, true)).toBe(2);
  });

  it('clamps the page when the list shrinks', () => {
    let result!: ReturnType<typeof usePagination<number>>;
    function Probe({ items }: { items: number[] }) {
      result = usePagination(items, 4);
      return null;
    }
    const { rerender } = render(<Probe items={[1, 2, 3, 4, 5, 6, 7, 8, 9]} />);
    expect(result.totalPages).toBe(3);
    act(() => result.setPage(2));
    expect(result.pageItems).toEqual([9]);
    rerender(<Probe items={[1, 2, 3, 4, 5]} />);
    expect(result.page).toBe(1);
    expect(result.pageItems).toEqual([5]);
  });
});

describe('<GridLayout>', () => {
  beforeEach(() => resetFakeRtc());

  it('paginates beyond maxTilesPerPage and pauses off-page videos at the SFU', async () => {
    const remotes = peers(20);
    const { container } = await renderInRoom(<GridLayout maxTilesPerPage={9} />, videoRoom(remotes));
    const tiles = () => container.querySelectorAll('.swalvo-participant-tile');

    // 21 tiles (you + 20) over pages of 9.
    expect(tiles()).toHaveLength(9);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    // Page 1 holds you + p1…p8: those are visible, p9…p20 are paused.
    expect(remotes[0].tracks[0].setVisible).toHaveBeenLastCalledWith(true);
    expect(remotes[8].tracks[0].setVisible).toHaveBeenLastCalledWith(false);
    expect(remotes[19].tracks[0].setVisible).toHaveBeenLastCalledWith(false);

    act(() => screen.getByRole('button', { name: 'Next page' }).click());
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    expect(within(container).getByRole('group', { name: 'p9' })).toBeInTheDocument();
    expect(remotes[0].tracks[0].setVisible).toHaveBeenLastCalledWith(false);
    expect(remotes[8].tracks[0].setVisible).toHaveBeenLastCalledWith(true);

    // PageDown / PageUp work from inside the grid.
    fireEvent.keyDown(container.querySelector('.swalvo-grid-layout')!, { key: 'PageDown' });
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();
    expect(tiles()).toHaveLength(3);
    fireEvent.keyDown(container.querySelector('.swalvo-grid-layout')!, { key: 'PageUp' });
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
  });

  it('hands visibility back to the SDK on unmount', async () => {
    const remotes = peers(12);
    const { unmount } = await renderInRoom(<GridLayout maxTilesPerPage={4} />, videoRoom(remotes));
    expect(remotes[11].tracks[0].setVisible).toHaveBeenLastCalledWith(false);
    unmount();
    expect(remotes[11].tracks[0].setVisible).toHaveBeenLastCalledWith(true);
  });

  it('has no pagination when everyone fits', async () => {
    const { container } = await renderInRoom(<GridLayout maxTilesPerPage={9} />, videoRoom(peers(3)));
    expect(container.querySelectorAll('.swalvo-participant-tile')).toHaveLength(4);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(container.querySelector('.swalvo-grid-layout')).toHaveStyle('--swalvo-grid-columns: 2');
  });
});

describe('<VideoConference>', () => {
  beforeEach(() => resetFakeRtc());

  it('renders a grid, the control bar and an audio element per remote mic', async () => {
    const alice = new FakePeer('alice').withTracks('camera', 'microphone');
    const { container } = await renderInRoom(<VideoConference />, videoRoom([alice]));
    const root = container.querySelector('.swalvo-video-conference')!;
    expect(root).toHaveAttribute('data-layout', 'grid');
    expect(screen.getByRole('toolbar', { name: 'Call controls' })).toBeInTheDocument();
    expect(container.querySelectorAll('.swalvo-room-audio audio')).toHaveLength(1);
    // Tiles render no audio of their own.
    expect(container.querySelectorAll('.swalvo-participant-tile audio')).toHaveLength(0);
  });

  it('focuses a remote screen share, and a pinned tile', async () => {
    const alice = new FakePeer('alice').withTracks('camera');
    const bob = new FakePeer('bob').withTracks('camera');
    const room = videoRoom([alice, bob]);
    const { container } = await renderInRoom(<VideoConference />, room);
    const root = container.querySelector('.swalvo-video-conference')!;

    const share = new FakeTrack('screenShare');
    act(() => {
      bob.tracks.push(share);
      room.emit('trackSubscribed', share, bob);
    });
    expect(root).toHaveAttribute('data-layout', 'focus');
    const main = container.querySelector('.swalvo-focus-layout__main')!;
    expect(within(main as HTMLElement).getByRole('group', { name: 'bob, screen share' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Other participants' })).toBeInTheDocument();

    // Pinning alice beats the screen share.
    act(() => screen.getByRole('button', { name: 'Pin alice' }).click());
    expect(
      within(container.querySelector('.swalvo-focus-layout__main') as HTMLElement).getByRole('group', {
        name: 'alice',
      }),
    ).toBeInTheDocument();

    // The share ending and the pin removed: back to the grid.
    act(() => screen.getAllByRole('button', { name: 'Pin alice' })[0].click());
    act(() => {
      bob.tracks = bob.tracks.filter((t) => t !== share);
      room.emit('trackUnsubscribed', share, bob);
    });
    expect(root).toHaveAttribute('data-layout', 'grid');
  });

  it('opens and closes the chat panel slot from the control bar', async () => {
    await renderInRoom(<VideoConference chat={<div>chat goes here</div>} />, videoRoom());
    const toggle = screen.getByRole('button', { name: 'Chat' });
    const panel = screen.getByText('chat goes here').closest('aside')!;
    expect(panel).not.toBeVisible();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    act(() => toggle.click());
    expect(panel).toBeVisible();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('complementary', { name: 'Chat' })).toBeInTheDocument();
  });

  it('publishes camera and mic from userChoices once connected, on the chosen devices', async () => {
    const room = videoRoom();
    publishOnEnable(room);
    await renderInRoom(
      <VideoConference
        userChoices={{ videoEnabled: true, audioEnabled: false, videoDeviceId: 'cam-2', username: 'Ada' }}
      />,
      room,
    );
    await act(async () => {});
    expect(room.enableCamera).toHaveBeenCalledTimes(1);
    expect(room.setCameraDevice).toHaveBeenCalledWith('cam-2');
    expect(room.enableMicrophone).not.toHaveBeenCalled();
  });

  it('calls onLeave after leaving', async () => {
    const onLeave = jest.fn();
    await renderInRoom(<VideoConference onLeave={onLeave} />, videoRoom());
    await act(async () => screen.getByRole('button', { name: 'Leave' }).click());
    expect(lastClient().leaveMock).toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalled();
  });
});
