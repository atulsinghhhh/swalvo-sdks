jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'));

import { act, render, screen, waitFor } from '@testing-library/react';
import { FakeParticipant, FakeRoom, lastClient, resetFakeRtc } from './helpers/fake-rtc-client';
import { SwalvoRoom } from '../src/swalvo-room';
import { useCamera, useMicrophone, useParticipants, useRemoteParticipants } from '../src/hooks';

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

describe('useParticipants / useRemoteParticipants', () => {
  beforeEach(() => resetFakeRtc());

  it('useRemoteParticipants starts empty and grows as participants join', async () => {
    let latest: unknown[] = [];
    function Probe() {
      latest = useRemoteParticipants();
      return <div>{latest.length}</div>;
    }

    const room = await renderJoined(<Probe />);
    expect(screen.getByText('0')).toBeTruthy();

    const bob = new FakeParticipant('bob');
    act(() => {
      room.remoteParticipants.push(bob);
      room.emit('participantJoined', bob);
    });

    await waitFor(() => expect(screen.getByText('1')).toBeTruthy());
    expect(latest).toEqual([bob]);
  });

  it('useParticipants puts the local participant first, then remote ones', async () => {
    let identities: string[] = [];
    function Probe() {
      identities = useParticipants().map((p) => p.identity);
      return null;
    }

    const room = await renderJoined(<Probe />);
    const bob = new FakeParticipant('bob');
    act(() => {
      room.remoteParticipants.push(bob);
      room.emit('participantJoined', bob);
    });

    await waitFor(() => expect(identities).toEqual(['local-user', 'bob']));
  });
});

describe('useCamera / useMicrophone', () => {
  beforeEach(() => resetFakeRtc());

  it('starts disabled, and enable() calls room.enableCamera()', async () => {
    let camera!: ReturnType<typeof useCamera>;
    function Probe() {
      camera = useCamera();
      return <div>{camera.enabled ? 'on' : 'off'}</div>;
    }

    const room = await renderJoined(<Probe />);
    expect(screen.getByText('off')).toBeTruthy();

    await act(async () => {
      await camera.enable();
    });

    expect(room.enableCamera).toHaveBeenCalledTimes(1);
  });

  it('reflects enabled: true once localTrackPublished fires for a camera track', async () => {
    function Probe() {
      const camera = useCamera();
      return <div>{camera.enabled ? 'on' : 'off'}</div>;
    }

    const room = await renderJoined(<Probe />);
    act(() => {
      room.localParticipant.tracks.push({ kind: 'camera' });
      room.emit('localTrackPublished', { kind: 'camera' });
    });

    await waitFor(() => expect(screen.getByText('on')).toBeTruthy());
  });

  it('microphone enable()/disable() call the matching room methods, independent of camera', async () => {
    let mic!: ReturnType<typeof useMicrophone>;
    function Probe() {
      mic = useMicrophone();
      return null;
    }

    const room = await renderJoined(<Probe />);
    await act(async () => {
      await mic.enable();
    });
    expect(room.enableMicrophone).toHaveBeenCalledTimes(1);
    expect(room.enableCamera).not.toHaveBeenCalled();

    await act(async () => {
      await mic.disable();
    });
    expect(room.disableMicrophone).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error from enable() without throwing out of the hook silently', async () => {
    let camera!: ReturnType<typeof useCamera>;
    function Probe() {
      camera = useCamera();
      return <div>{camera.error ? 'error' : 'no-error'}</div>;
    }

    const room = await renderJoined(<Probe />);
    room.enableCamera.mockRejectedValueOnce(new Error('permission denied'));

    await act(async () => {
      await expect(camera.enable()).rejects.toThrow('permission denied');
    });

    await waitFor(() => expect(screen.getByText('error')).toBeTruthy());
  });
});
