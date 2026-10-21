import { render, screen } from '@testing-library/react';
import { SwalvoStoreContext } from '../src/context';
import { LocalParticipantView, ParticipantView, SwalvoAudio, SwalvoVideo } from '../src/components';
import type { SwalvoSnapshot } from '../src/store';

function fakeTrack(kind: string) {
  return {
    kind,
    isMuted: false,
    attach: jest.fn((el?: HTMLMediaElement) => el ?? document.createElement('video')),
    detach: jest.fn(() => []),
  };
}

function fakeParticipant(identity: string, tracks: ReturnType<typeof fakeTrack>[]) {
  return { identity, tracks, metadata: undefined };
}

/** Minimal store double. Just enough for useLocalParticipant()'s useSyncExternalStore call. */
function fakeStore(snapshot: Partial<SwalvoSnapshot>) {
  const full: SwalvoSnapshot = { connectionState: 'connected', remoteParticipants: [], reconnectCount: 0, ...snapshot };
  return { subscribe: () => () => {}, getSnapshot: () => full };
}

describe('SwalvoVideo', () => {
  it('attaches the given track to its video element, and detaches on unmount', () => {
    const track = fakeTrack('camera');
    const { unmount } = render(<SwalvoVideo track={track as never} data-testid="video" />);

    expect(track.attach).toHaveBeenCalledTimes(1);

    unmount();
    expect(track.detach).toHaveBeenCalledTimes(1);
  });

  it('renders a bare <video> element with no track, without attaching anything', () => {
    render(<SwalvoVideo data-testid="video" />);
    expect(screen.getByTestId('video').tagName).toBe('VIDEO');
  });
});

describe('SwalvoAudio', () => {
  it('attaches the given track to its audio element', () => {
    const track = fakeTrack('microphone');
    render(<SwalvoAudio track={track as never} data-testid="audio" />);

    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('audio').tagName).toBe('AUDIO');
  });
});

describe('ParticipantView', () => {
  it('renders the video track, audio track, and identity label for a participant', () => {
    const camera = fakeTrack('camera');
    const mic = fakeTrack('microphone');
    const participant = fakeParticipant('alice', [camera, mic]);

    render(<ParticipantView participant={participant as never} />);

    expect(camera.attach).toHaveBeenCalledTimes(1);
    expect(mic.attach).toHaveBeenCalledTimes(1);
    expect(screen.getByText('alice')).toBeTruthy();
  });

  it('renders no video/audio elements for a participant with no tracks yet', () => {
    const participant = fakeParticipant('bob', []);
    const { container } = render(<ParticipantView participant={participant as never} />);

    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.getByText('bob')).toBeTruthy();
  });

  it('accepts a custom label overriding the identity text', () => {
    const participant = fakeParticipant('carol', []);
    render(<ParticipantView participant={participant as never} label="You" />);

    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.queryByText('carol')).toBeNull();
  });
});

describe('LocalParticipantView', () => {
  it('renders nothing before a local participant exists', () => {
    const store = fakeStore({ localParticipant: undefined });
    const { container } = render(
      <SwalvoStoreContext.Provider value={store as never}>
        <LocalParticipantView />
      </SwalvoStoreContext.Provider>,
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders the local participant once it exists on the store', () => {
    const local = fakeParticipant('local-user', []);
    const store = fakeStore({ localParticipant: local as never });

    render(
      <SwalvoStoreContext.Provider value={store as never}>
        <LocalParticipantView />
      </SwalvoStoreContext.Provider>,
    );

    expect(screen.getByText('local-user')).toBeTruthy();
  });
});
