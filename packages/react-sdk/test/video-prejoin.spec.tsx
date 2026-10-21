jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'));

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { resetFakeRtc, runConnectionTest } from './helpers/fake-rtc-client';
import { installMediaDevices, removeMediaDevices, renderInRoom, videoRoom } from './helpers/fake-video';
import { RoomAudioRenderer, StartAudio } from '../src/video/audio';
import { PreJoin } from '../src/video/pre-join';
import { ConnectionStateToast } from '../src/video/toast';
import { FakePeer } from './helpers/fake-video';

const DEVICES = [
  { deviceId: 'cam-1', kind: 'videoinput', label: 'FaceTime HD' },
  { deviceId: 'cam-2', kind: 'videoinput', label: 'USB Webcam' },
  { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Mic' },
];

function fakeStream(kind: 'video' | 'audio', deviceId: string) {
  const track = { kind, stop: jest.fn(), getSettings: () => ({ deviceId }) };
  return { track, stream: { getTracks: () => [track] } };
}

function installPreview() {
  const acquired: Array<ReturnType<typeof fakeStream>['track']> = [];
  const getUserMedia = jest.fn(async (constraints: { video?: unknown; audio?: unknown }) => {
    const kind = constraints.video ? 'video' : 'audio';
    const wanted = (constraints.video ?? constraints.audio) as true | { deviceId: { exact: string } };
    const id = wanted === true ? (kind === 'video' ? 'cam-1' : 'mic-1') : wanted.deviceId.exact;
    const { track, stream } = fakeStream(kind, id);
    acquired.push(track);
    return stream;
  });
  installMediaDevices(DEVICES, { getUserMedia });
  return { getUserMedia, acquired };
}

const REPORT = {
  ok: true,
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 5000,
  camera: { status: 'passed', devices: 2 },
  microphone: { status: 'passed', devices: 1 },
  signaling: { status: 'passed', durationMs: 120 },
  media: { status: 'passed', durationMs: 300 },
  route: { candidateType: 'relay', usedRelay: true, protocol: 'udp', relayProtocol: 'tls' },
  turn: { udp: 'failed', tcp: 'passed', tls: 'passed' },
  network: { rttMs: 48, jitterMs: 4, packetLossPercent: 0.4, upstreamKbps: 1450 },
  issues: [{ code: 'UDP_BLOCKED', severity: 'warning', message: 'UDP is blocked; calls are relayed over TLS.' }],
};

describe('<PreJoin>', () => {
  beforeEach(() => {
    resetFakeRtc();
    runConnectionTest.mockReset();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });
  afterAll(() => removeMediaDevices());

  it('previews the camera, meters the mic, and lists devices', async () => {
    const { getUserMedia } = installPreview();
    const { container } = render(<PreJoin onSubmit={jest.fn()} />);
    await waitFor(() => expect(container.querySelector('video.swalvo-prejoin__video')).not.toBeNull());
    expect(getUserMedia).toHaveBeenCalledWith({ video: true });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(screen.getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuenow', '0');
    const cameraSelect = await screen.findByLabelText('Camera device');
    await waitFor(() => expect((cameraSelect as HTMLSelectElement).value).toBe('cam-1'));
    expect(screen.getByRole('option', { name: 'USB Webcam' })).toBeInTheDocument();
  });

  it('turns the camera off (stopping the preview) and switches devices', async () => {
    const { getUserMedia, acquired } = installPreview();
    const { container } = render(<PreJoin onSubmit={jest.fn()} />);
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    const camera = screen.getByRole('button', { name: 'Camera' });
    expect(camera).toHaveAttribute('aria-pressed', 'true');

    act(() => camera.click());
    expect(camera).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('video')).toBeNull();
    expect(acquired.find((t) => t.kind === 'video')!.stop).toHaveBeenCalled();

    act(() => camera.click());
    await screen.findByRole('option', { name: 'USB Webcam' });
    fireEvent.change(screen.getByLabelText('Camera device'), { target: { value: 'cam-2' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { exact: 'cam-2' } } }));
  });

  it('requires a name, then submits the choices with the previews stopped', async () => {
    const { acquired } = installPreview();
    const onSubmit = jest.fn();
    render(<PreJoin onSubmit={onSubmit} persistUserChoices />);
    await screen.findByRole('option', { name: 'USB Webcam' });
    const join = screen.getByRole('button', { name: 'Join' });
    expect(join).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '  Ada ' } });
    act(() => screen.getByRole('button', { name: 'Microphone' }).click());
    expect(join).toBeEnabled();
    act(() => join.click());

    expect(onSubmit).toHaveBeenCalledWith({
      username: 'Ada',
      videoEnabled: true,
      audioEnabled: false,
      videoDeviceId: 'cam-1',
      audioDeviceId: undefined,
    });
    expect(acquired.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(JSON.parse(localStorage.getItem('raven-user-choices')!)).toMatchObject({
      username: 'Ada',
      audioEnabled: false,
    });
  });

  it('explains a denied camera permission', async () => {
    installMediaDevices(DEVICES, {
      getUserMedia: jest.fn(async (c: { video?: unknown }) => {
        if (c.video) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        return fakeStream('audio', 'mic-1').stream;
      }),
    });
    const onError = jest.fn();
    render(<PreJoin onSubmit={jest.fn()} onError={onError} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission to use the camera was denied');
    expect(onError).toHaveBeenCalled();
  });

  it('runs the connection test and shows the results panel', async () => {
    installPreview();
    let finish!: () => void;
    runConnectionTest.mockImplementation(
      (options: unknown) =>
        new Promise((resolve) => {
          (options as { onProgress: (s: string) => void }).onProgress('signaling');
          finish = () => resolve(REPORT as never);
        }) as never,
    );
    const getOptions = jest.fn(async () => ({ token: 'preflight-token', endpoint: 'wss://rtc.example.com' }));
    render(<PreJoin onSubmit={jest.fn()} connectionTest={getOptions} />);

    await act(async () => screen.getByRole('button', { name: 'Test connection' }).click());
    expect(getOptions).toHaveBeenCalled();
    expect(runConnectionTest).toHaveBeenCalledWith(expect.objectContaining({ token: 'preflight-token' }));
    expect(screen.getByText('Connecting to the server…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Testing…' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => finish());
    expect(screen.getByText('Your device can join calls.')).toBeInTheDocument();
    expect(screen.getByText('Relayed (TURN over TLS)')).toBeInTheDocument();
    expect(screen.getByText('48 ms')).toBeInTheDocument();
    expect(screen.getByText('1450 kbps')).toBeInTheDocument();
    expect(screen.getByText('UDP is blocked; calls are relayed over TLS.')).toHaveAttribute('data-severity', 'warning');
    expect(screen.getByRole('button', { name: 'Test again' })).toBeInTheDocument();
  });

  it('reports a connection test that throws', async () => {
    installPreview();
    runConnectionTest.mockRejectedValueOnce(new Error('needs the RTC token'));
    render(<PreJoin onSubmit={jest.fn()} connectionTest={{ token: 't', endpoint: 'wss://x' }} />);
    await act(async () => screen.getByRole('button', { name: 'Test connection' }).click());
    expect(screen.getByRole('alert')).toHaveTextContent('Connection test failed: needs the RTC token');
  });
});

describe('<RoomAudioRenderer> + <StartAudio>', () => {
  beforeEach(() => resetFakeRtc());

  it('asks for a click when autoplay is blocked, and unblocks on click', async () => {
    const play = HTMLMediaElement.prototype.play as jest.Mock;
    play.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })));
    const alice = new FakePeer('alice').withTracks('microphone');
    await renderInRoom(
      <>
        <RoomAudioRenderer />
        <StartAudio />
      </>,
      videoRoom([alice]),
    );
    const button = await screen.findByRole('button', { name: 'Start audio' });
    expect(alice.tracks[0].attach).toHaveBeenCalled();

    await act(async () => button.click());
    expect(screen.queryByRole('button', { name: 'Start audio' })).toBeNull();
  });
});

describe('<ConnectionStateToast>', () => {
  beforeEach(() => resetFakeRtc());

  it('announces reconnecting, then restored', async () => {
    const { room } = await renderInRoom(<ConnectionStateToast resumedDurationMs={20} />, videoRoom());
    expect(screen.queryByRole('status')).toBeNull();

    act(() => room.emit('connectionStateChanged', 'reconnecting'));
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');

    act(() => room.emit('connectionStateChanged', 'connected'));
    expect(screen.getByRole('status')).toHaveTextContent('Connection restored');
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('says why the server ended the call, and nothing when you left', async () => {
    const { room } = await renderInRoom(<ConnectionStateToast />, videoRoom());
    act(() => {
      room.emit('disconnected', 'REMOVED');
      room.emit('connectionStateChanged', 'disconnected');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('You were removed from the call');
    expect(screen.getByRole('alert')).toHaveAttribute('data-reason', 'REMOVED');

    act(() => {
      room.emit('connectionStateChanged', 'connected');
      room.emit('connected');
      room.emit('disconnected', 'CLIENT_INITIATED');
      room.emit('connectionStateChanged', 'disconnected');
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
