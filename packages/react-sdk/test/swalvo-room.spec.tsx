jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'));

import { act, render, screen, waitFor } from '@testing-library/react';
import { FakeRoom, lastClient, resetFakeRtc } from './helpers/fake-rtc-client';
import { SwalvoRoom } from '../src/swalvo-room';
import { useConnectionState } from '../src/hooks';

function Probe() {
  const state = useConnectionState();
  return <div data-testid="state">{state}</div>;
}

describe('<SwalvoRoom>', () => {
  beforeEach(() => {
    resetFakeRtc();
  });

  it('shows the fallback while joining, then renders children once connected', async () => {
    const room = new FakeRoom('room-1');
    render(
      <SwalvoRoom token="t" endpoint="wss://rtc.example.com" room="room-1" fallback={<div>Connecting…</div>}>
        <div>Joined!</div>
      </SwalvoRoom>,
    );

    expect(screen.queryByText('Connecting…')).not.toBeNull();
    expect(screen.queryByText('Joined!')).toBeNull();

    lastClient().pendingJoin.resolve(room);
    await waitFor(() => expect(screen.queryByText('Joined!')).not.toBeNull());
  });

  it('calls join() with the given room ID on mount (autoConnect default true)', async () => {
    render(
      <SwalvoRoom token="t" endpoint="wss://rtc.example.com" room="room-1">
        <div>Joined!</div>
      </SwalvoRoom>,
    );

    await waitFor(() => expect(lastClient().joinMock).toHaveBeenCalledWith('room-1'));
  });

  it('does not auto-join when autoConnect is false', () => {
    render(
      <SwalvoRoom token="t" endpoint="wss://rtc.example.com" room="room-1" autoConnect={false}>
        <Probe />
      </SwalvoRoom>,
    );

    expect(lastClient().joinMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('state').textContent).toBe('idle');
  });

  it('calls leave() on unmount', async () => {
    const room = new FakeRoom('room-1');
    const { unmount } = render(
      <SwalvoRoom token="t" endpoint="wss://rtc.example.com" room="room-1">
        <div>Joined!</div>
      </SwalvoRoom>,
    );
    lastClient().pendingJoin.resolve(room);
    await waitFor(() => expect(screen.queryByText('Joined!')).not.toBeNull());

    unmount();

    expect(lastClient().leaveMock).toHaveBeenCalledTimes(1);
  });

  it('calls onError and shows the fallback when join() rejects', async () => {
    const onError = jest.fn();
    render(
      <SwalvoRoom
        token="t"
        endpoint="wss://rtc.example.com"
        room="room-1"
        fallback={<div>Failed</div>}
        onError={onError}
      >
        <div>Joined!</div>
      </SwalvoRoom>,
    );
    lastClient().pendingJoin.reject(new Error('nope'));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.queryByText('Joined!')).toBeNull();
  });

  it('propagates connectionState changes down through useConnectionState()', async () => {
    const room = new FakeRoom('room-1');
    render(
      <SwalvoRoom token="t" endpoint="wss://rtc.example.com" room="room-1">
        <Probe />
      </SwalvoRoom>,
    );
    lastClient().pendingJoin.resolve(room);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('connected'));

    act(() => {
      room.connectionState = 'reconnecting';
      room.emit('connectionStateChanged', 'reconnecting');
    });

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('reconnecting'));
  });
});
