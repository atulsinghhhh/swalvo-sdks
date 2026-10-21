jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'));

import { act, render, screen } from '@testing-library/react';
import { resetFakeRtc } from './helpers/fake-rtc-client';
import { FakePeer, renderInRoom, videoRoom } from './helpers/fake-video';
import { ConnectionQualityIndicator } from '../src/video/connection-quality-indicator';
import { LayoutContextProvider } from '../src/video/layout-context';
import { ParticipantTile } from '../src/video/participant-tile';
import { participantDisplayName, type TrackReference } from '../src/video/types';

function cameraRef(peer: FakePeer, isLocal = false): TrackReference {
  return {
    participant: peer as never,
    source: 'camera',
    track: peer.tracks.find((t) => t.kind === 'camera') as never,
    isLocal,
  };
}

describe('<ParticipantTile>', () => {
  beforeEach(() => resetFakeRtc());

  it('renders the video when the camera is on, and an initials avatar when it is off', async () => {
    const alice = new FakePeer('alice', JSON.stringify({ name: 'Alice Doe' })).withTracks('camera', 'microphone');
    const bob = new FakePeer('bob');
    const room = videoRoom([alice, bob]);
    const { container } = await renderInRoom(
      <>
        <ParticipantTile trackRef={cameraRef(alice)} />
        <ParticipantTile trackRef={cameraRef(bob)} />
      </>,
      room,
    );

    const [aliceTile, bobTile] = Array.from(container.querySelectorAll('.swalvo-participant-tile'));
    expect(aliceTile.querySelector('video')).not.toBeNull();
    expect(alice.tracks[0].attach).toHaveBeenCalled();
    expect(screen.getByText('Alice Doe')).toBeInTheDocument();
    expect(aliceTile).not.toHaveAttribute('data-video-muted');
    expect(aliceTile).not.toHaveAttribute('data-audio-muted');

    expect(bobTile.querySelector('video')).toBeNull();
    expect(bobTile).toHaveAttribute('data-video-muted', 'true');
    expect(bobTile).toHaveAttribute('data-audio-muted', 'true');
    expect(bobTile.querySelector('.swalvo-avatar')?.textContent).toBe('B');
    expect(screen.getAllByRole('img', { name: 'Microphone off' })).toHaveLength(1);
  });

  it('follows remote mute and unmute', async () => {
    const alice = new FakePeer('alice').withTracks('camera', 'microphone');
    const room = videoRoom([alice]);
    const { container } = await renderInRoom(<ParticipantTile trackRef={cameraRef(alice)} />, room);
    const tile = container.querySelector('.swalvo-participant-tile')!;

    act(() => {
      alice.tracks[0].isMuted = true;
      alice.tracks[1].isMuted = true;
      room.emit('trackMuted', 'camera', alice);
    });
    expect(tile).toHaveAttribute('data-video-muted', 'true');
    expect(tile).toHaveAttribute('data-audio-muted', 'true');
    expect(tile.querySelector('video')).toBeNull();

    act(() => {
      alice.tracks[0].isMuted = false;
      room.emit('trackUnmuted', 'camera', alice);
    });
    expect(tile.querySelector('video')).not.toBeNull();
  });

  it('shows a speaking ring and connection-quality bars', async () => {
    const alice = new FakePeer('alice').withTracks('camera');
    const { container } = await renderInRoom(<ParticipantTile trackRef={cameraRef(alice)} />, videoRoom([alice]));
    const tile = container.querySelector('.swalvo-participant-tile')!;
    expect(tile).not.toHaveAttribute('data-speaking');

    act(() => alice.speak(true));
    expect(tile).toHaveAttribute('data-speaking', 'true');

    act(() => alice.score('poor'));
    const quality = screen.getByRole('img', { name: 'Poor connection' });
    expect(quality).toHaveAttribute('data-quality', 'poor');
    expect(quality.querySelectorAll('[data-active]')).toHaveLength(1);
  });

  it('says a video is paused to save bandwidth when the SFU pauses it', async () => {
    const alice = new FakePeer('alice').withTracks('camera');
    const room = videoRoom([alice]);
    const { container } = await renderInRoom(<ParticipantTile trackRef={cameraRef(alice)} />, room);
    expect(screen.queryByText('Video paused to save bandwidth')).toBeNull();

    act(() => {
      alice.tracks[0].subscriptionState = 'paused_bandwidth';
      room.emit('trackSubscriptionStateChanged', alice.tracks[0], alice);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Video paused to save bandwidth');
    expect(container.querySelector('.swalvo-participant-tile')).toHaveAttribute(
      'data-subscription',
      'paused_bandwidth',
    );
  });

  it('shows an E2EE lock, and a warning when the participant cannot be decrypted', async () => {
    const alice = new FakePeer('alice').withTracks('camera');
    const room = videoRoom([alice]);
    await renderInRoom(<ParticipantTile trackRef={cameraRef(alice)} />, room);
    expect(screen.queryByRole('img', { name: 'End-to-end encrypted' })).toBeNull();

    act(() => room.emit('e2eeStateChanged', alice, 'ok'));
    expect(screen.getByRole('img', { name: 'End-to-end encrypted' })).toBeInTheDocument();

    act(() => room.emit('e2eeStateChanged', alice, 'decrypt_failed'));
    expect(screen.queryByRole('img', { name: 'End-to-end encrypted' })).toBeNull();
    expect(screen.getByRole('img', { name: "Can't decrypt this participant's media" })).toBeInTheDocument();
  });

  it('mirrors only the local camera, and labels it as you', async () => {
    const local = new FakePeer('me').withTracks('camera');
    const room = videoRoom([], local);
    const { container } = await renderInRoom(<ParticipantTile trackRef={cameraRef(local, true)} />, room);
    expect(container.querySelector('video')).toHaveAttribute('data-mirrored', 'true');
    expect(screen.getByRole('group', { name: 'me (you)' })).toBeInTheDocument();
  });

  it('pins and unpins through the layout context, with aria-pressed', async () => {
    const alice = new FakePeer('alice').withTracks('camera');
    await renderInRoom(
      <LayoutContextProvider>
        <ParticipantTile trackRef={cameraRef(alice)} />
      </LayoutContextProvider>,
      videoRoom([alice]),
    );
    const pin = screen.getByRole('button', { name: 'Pin alice' });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    act(() => pin.click());
    expect(pin).toHaveAttribute('aria-pressed', 'true');
    act(() => pin.click());
    expect(pin).toHaveAttribute('aria-pressed', 'false');
  });

  it('has no pin button outside a layout context', async () => {
    const alice = new FakePeer('alice').withTracks('camera');
    await renderInRoom(<ParticipantTile trackRef={cameraRef(alice)} />, videoRoom([alice]));
    expect(screen.queryByRole('button', { name: /Pin/ })).toBeNull();
  });
});

describe('<ConnectionQualityIndicator>', () => {
  it('renders three bars, all inactive while unknown, and can hide itself', () => {
    const peer = new FakePeer('p');
    const { container, rerender } = render(<ConnectionQualityIndicator participant={peer as never} />);
    expect(container.querySelectorAll('.swalvo-connection-quality__bar')).toHaveLength(3);
    expect(container.querySelectorAll('[data-active]')).toHaveLength(0);
    rerender(<ConnectionQualityIndicator participant={peer as never} hideWhenUnknown />);
    expect(container.firstChild).toBeNull();
    act(() => peer.score('excellent'));
    expect(container.querySelectorAll('[data-active]')).toHaveLength(3);
  });
});

describe('participantDisplayName', () => {
  it('prefers a JSON metadata name and falls back to the identity', () => {
    expect(participantDisplayName({ identity: 'u1', metadata: '{"name":"Ada"}' })).toBe('Ada');
    expect(participantDisplayName({ identity: 'u1', metadata: '{"displayName":"Grace"}' })).toBe('Grace');
    expect(participantDisplayName({ identity: 'u1', metadata: 'not json' })).toBe('u1');
    expect(participantDisplayName({ identity: 'u1', metadata: '{broken' })).toBe('u1');
  });
});
