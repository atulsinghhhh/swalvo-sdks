jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'));

import { act, render, screen } from '@testing-library/react';
import { FakeRoom, lastClient, resetFakeRtc } from './helpers/fake-rtc-client';
import { SwalvoRoom } from '../src/swalvo-room';
import { useE2EEState } from '../src/hooks';

describe('useE2EEState', () => {
  beforeEach(() => resetFakeRtc());

  it("follows the room's e2eeStateChanged for its own participant only", async () => {
    const bob = { identity: 'bob' };
    const carol = { identity: 'carol' };
    function Probe() {
      return <div data-testid="state">{useE2EEState(bob as never) ?? 'none'}</div>;
    }
    const room = new FakeRoom('room-1');
    render(
      <SwalvoRoom
        token="t"
        endpoint="wss://rtc.example.com"
        room="room-1"
        e2ee={{ keyProvider: { sharedKey: true, ratchetWindow: 8 } }}
      >
        <Probe />
      </SwalvoRoom>,
    );
    await act(async () => {
      lastClient().pendingJoin.resolve(room);
      await lastClient().pendingJoin.promise;
    });
    expect(lastClient().config).toMatchObject({ e2ee: { keyProvider: { sharedKey: true } } });
    expect(screen.getByTestId('state').textContent).toBe('none');

    act(() => room.emit('e2eeStateChanged', carol, 'decrypt_failed'));
    expect(screen.getByTestId('state').textContent).toBe('none');

    act(() => room.emit('e2eeStateChanged', bob, 'missing_key'));
    expect(screen.getByTestId('state').textContent).toBe('missing_key');

    act(() => room.emit('e2eeStateChanged', bob, 'ok'));
    expect(screen.getByTestId('state').textContent).toBe('ok');
  });
});
