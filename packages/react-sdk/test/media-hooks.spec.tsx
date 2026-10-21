jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'));

import { act, render, screen } from '@testing-library/react';
import { FakeEmitter, FakeRoom, lastClient, resetFakeRtc } from './helpers/fake-rtc-client';
import { SwalvoRoom } from '../src/swalvo-room';
import { ParticipantView } from '../src/components';
import { useActiveSpeakers, useConnectionQuality, useIsSpeaking, useTrackSubscriptionState } from '../src/hooks';

/**
 * The Phase 2 hooks: speakers, connection quality, subscription state.
 * Driven through the same events the real SDK emits, on doubles shaped
 * like its participants and tracks.
 */

class SpeakingParticipant extends FakeEmitter {
  tracks: unknown[] = [];
  isSpeaking = false;
  audioLevel = 0;
  connectionQuality = 'unknown';
  constructor(public identity: string) {
    super();
  }
  speak(speaking: boolean): void {
    this.isSpeaking = speaking;
    this.emit('isSpeakingChanged', speaking);
  }
  score(quality: string): void {
    this.connectionQuality = quality;
    this.emit('connectionQualityChanged', quality);
  }
}

async function renderJoined(children: React.ReactNode) {
  const room = new FakeRoom('room-1');
  render(
    <SwalvoRoom token="t" endpoint="wss://rtc.example.com" room="room-1">
      {children}
    </SwalvoRoom>,
  );
  await act(async () => {
    lastClient().pendingJoin.resolve(room);
    await lastClient().pendingJoin.promise;
  });
  return room;
}

describe('useActiveSpeakers', () => {
  beforeEach(() => resetFakeRtc());

  it('follows the room speaker set', async () => {
    function Probe() {
      const speakers = useActiveSpeakers() as unknown as SpeakingParticipant[];
      return <div data-testid="speakers">{speakers.map((p) => p.identity).join(',') || 'none'}</div>;
    }
    const room = await renderJoined(<Probe />);
    expect(screen.getByTestId('speakers').textContent).toBe('none');

    const bob = new SpeakingParticipant('bob');
    act(() => {
      room.activeSpeakers = [bob];
      room.emit('activeSpeakersChanged', [bob]);
    });
    expect(screen.getByTestId('speakers').textContent).toBe('bob');

    act(() => {
      room.activeSpeakers = [];
      room.emit('activeSpeakersChanged', []);
    });
    expect(screen.getByTestId('speakers').textContent).toBe('none');
  });

  it('is empty, not an error, outside <SwalvoRoom>', () => {
    function Probe() {
      return <div data-testid="speakers">{useActiveSpeakers().length}</div>;
    }
    render(<Probe />);
    expect(screen.getByTestId('speakers').textContent).toBe('0');
  });
});

describe('useIsSpeaking / useConnectionQuality', () => {
  it('track one participant, without a room', () => {
    const bob = new SpeakingParticipant('bob');
    function Probe() {
      const speaking = useIsSpeaking(bob as never);
      const quality = useConnectionQuality(bob as never);
      return <div data-testid="state">{`${speaking}/${quality}`}</div>;
    }
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('state').textContent).toBe('false/unknown');

    act(() => bob.speak(true));
    act(() => bob.score('poor'));
    expect(screen.getByTestId('state').textContent).toBe('true/poor');

    unmount();
    // Unsubscribed on unmount: emitting afterwards must not touch anything.
    expect(() => bob.speak(false)).not.toThrow();
  });

  it('answer conservatively for no participant', () => {
    function Probe() {
      return <div data-testid="state">{`${useIsSpeaking(undefined)}/${useConnectionQuality(undefined)}`}</div>;
    }
    render(<Probe />);
    expect(screen.getByTestId('state').textContent).toBe('false/unknown');
  });
});

describe('useTrackSubscriptionState', () => {
  beforeEach(() => resetFakeRtc());

  it('updates for its own track only', async () => {
    const track = { kind: 'camera', subscriptionState: 'active', layer: undefined as string | undefined };
    const other = { kind: 'camera', subscriptionState: 'active', layer: undefined };
    function Probe() {
      const info = useTrackSubscriptionState(track as never);
      return <div data-testid="state">{`${info.state}:${info.layer ?? '-'}`}</div>;
    }
    const room = await renderJoined(<Probe />);
    expect(screen.getByTestId('state').textContent).toBe('active:-');

    act(() => {
      track.subscriptionState = 'paused_bandwidth';
      track.layer = 'off';
      room.emit('trackSubscriptionStateChanged', other, {});
    });
    expect(screen.getByTestId('state').textContent).toBe('active:-');

    act(() => room.emit('trackSubscriptionStateChanged', track, {}));
    expect(screen.getByTestId('state').textContent).toBe('paused_bandwidth:off');
  });
});

describe('ParticipantView speaking and quality', () => {
  it('exposes both as attributes, with an opt-in class and indicator', () => {
    const bob = new SpeakingParticipant('bob');
    const { container } = render(
      <ParticipantView
        participant={bob as never}
        className="tile"
        speakingClassName="speaking"
        showConnectionQuality
      />,
    );
    const tile = container.querySelector('[data-swalvo-participant="bob"]')!;
    expect(tile.getAttribute('data-swalvo-speaking')).toBe('false');
    expect(tile.className).toBe('tile');

    act(() => {
      bob.speak(true);
      bob.score('good');
    });
    expect(tile.getAttribute('data-swalvo-speaking')).toBe('true');
    expect(tile.className).toBe('tile speaking');
    expect(tile.getAttribute('data-swalvo-connection-quality')).toBe('good');
    expect(screen.getByRole('img', { name: 'Good connection' })).toBeTruthy();
  });
});
