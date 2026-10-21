jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'));

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { lastClient, resetFakeRtc } from './helpers/fake-rtc-client';
import {
  installMediaDevices,
  publishOnEnable,
  removeMediaDevices,
  renderInRoom,
  videoRoom,
} from './helpers/fake-video';
import { ControlBar, DisconnectButton, TrackToggle } from '../src/video/controls';
import { MediaDeviceMenu } from '../src/video/media-device-menu';
import { useMediaDevices, useTrackToggle } from '../src/video/video-hooks';

const DEVICES = [
  { deviceId: 'cam-1', kind: 'videoinput', label: 'FaceTime HD' },
  { deviceId: 'cam-2', kind: 'videoinput', label: 'USB Webcam' },
  { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Mic' },
  { deviceId: 'spk-1', kind: 'audiooutput', label: 'Speakers' },
];

describe('<TrackToggle> / useTrackToggle', () => {
  beforeEach(() => {
    resetFakeRtc();
    installMediaDevices(DEVICES);
  });
  afterAll(() => removeMediaDevices());

  it('turns the camera on and off, with a pending state in between', async () => {
    const room = videoRoom();
    publishOnEnable(room);
    let release!: () => void;
    room.enableCamera.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => {
            const track = { kind: 'camera', isMuted: false, attach: jest.fn(), detach: jest.fn(() => []) };
            room.localParticipant.tracks.push(track as never);
            room.emit('localTrackPublished', track);
            resolve(undefined);
          };
        }),
    );
    await renderInRoom(<TrackToggle source="camera" />, room);
    const button = screen.getByRole('button', { name: 'Camera' });
    expect(button).toHaveAttribute('aria-pressed', 'false');

    act(() => button.click());
    expect(room.enableCamera).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-busy', 'true');
    // A second click while pending is ignored rather than queued.
    act(() => button.click());
    expect(room.enableCamera).toHaveBeenCalledTimes(1);

    await act(async () => release());
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).not.toHaveAttribute('aria-busy');

    await act(async () => button.click());
    expect(room.disableCamera).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('surfaces a failure (permission denied) as data-error and onError', async () => {
    const room = videoRoom();
    const failure = Object.assign(new Error('Camera permission denied'), { code: 'CAMERA_PERMISSION_DENIED' });
    room.enableCamera.mockRejectedValueOnce(failure);
    const onError = jest.fn();
    await renderInRoom(<TrackToggle source="camera" onError={onError} />, room);
    const button = screen.getByRole('button', { name: 'Camera' });

    await act(async () => button.click());
    expect(onError).toHaveBeenCalledWith(failure);
    expect(button).toHaveAttribute('data-error', 'true');
    expect(button).toHaveAttribute('title', 'Camera: Camera permission denied');
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('unmutes a microphone the server muted instead of republishing it', async () => {
    const room = videoRoom();
    const mic = {
      kind: 'microphone',
      isMuted: true,
      unmute: jest.fn(async () => {
        mic.isMuted = false;
      }),
    };
    room.localParticipant.tracks = [mic as never];
    function Probe() {
      const { enabled, toggle } = useTrackToggle('microphone');
      return (
        <button type="button" onClick={() => void toggle()}>
          {enabled ? 'on' : 'off'}
        </button>
      );
    }
    await renderInRoom(<Probe />, room);
    await act(async () => screen.getByRole('button').click());
    expect(mic.unmute).toHaveBeenCalled();
    expect(room.enableMicrophone).not.toHaveBeenCalled();
  });

  it('applies a device picked while the camera was off when it is turned on', async () => {
    const room = videoRoom();
    publishOnEnable(room);
    await renderInRoom(
      <>
        <TrackToggle source="camera" />
        <MediaDeviceMenu kind="videoinput" />
      </>,
      room,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose camera' }));
    await screen.findByRole('menuitemradio', { name: 'USB Webcam' });
    await act(async () => fireEvent.click(screen.getByRole('menuitemradio', { name: 'USB Webcam' })));
    // Nothing published yet: the SDK call is a no-op, the preference is kept.
    expect(room.setCameraDevice).toHaveBeenCalledWith('cam-2');

    room.setCameraDevice.mockClear();
    await act(async () => screen.getByRole('button', { name: 'Camera' }).click());
    expect(room.enableCamera).toHaveBeenCalled();
    expect(room.setCameraDevice).toHaveBeenCalledWith('cam-2');
  });
});

describe('<MediaDeviceMenu>', () => {
  beforeEach(() => {
    resetFakeRtc();
    installMediaDevices(DEVICES);
  });
  afterAll(() => removeMediaDevices());

  it('opens with the active device focused, moves with arrows, picks with Enter and closes with Escape', async () => {
    const room = videoRoom();
    const camera = { kind: 'camera', isMuted: false, mediaStreamTrack: { getSettings: () => ({ deviceId: 'cam-1' }) } };
    room.localParticipant.tracks = [camera as never];
    const onChange = jest.fn();
    await renderInRoom(<MediaDeviceMenu kind="videoinput" onActiveDeviceChange={onChange} />, room);

    const trigger = screen.getByRole('button', { name: 'Choose camera' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    act(() => trigger.click());
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const first = await screen.findByRole('menuitemradio', { name: 'FaceTime HD' });
    expect(first).toHaveAttribute('aria-checked', 'true');
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = screen.getByRole('menuitemradio', { name: 'USB Webcam' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(first).toHaveFocus(); // wraps

    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();

    act(() => trigger.click());
    const usb = await screen.findByRole('menuitemradio', { name: 'USB Webcam' });
    await act(async () => fireEvent.keyDown(usb, { key: 'Enter' }));
    expect(room.setCameraDevice).toHaveBeenCalledWith('cam-2');
    expect(onChange).toHaveBeenCalledWith('videoinput', 'cam-2');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('switches the speaker through room.setSpeakerDevice where setSinkId exists', async () => {
    const proto = HTMLMediaElement.prototype as unknown as { setSinkId?: unknown };
    proto.setSinkId = jest.fn();
    try {
      const room = videoRoom();
      await renderInRoom(<MediaDeviceMenu kinds={['audioinput', 'audiooutput']} />, room);
      act(() => screen.getByRole('button', { name: 'Choose microphone and speaker' }).click());
      expect(await screen.findByRole('group', { name: 'Speaker' })).toBeInTheDocument();
      await act(async () => fireEvent.click(screen.getByRole('menuitemradio', { name: 'Speakers' })));
      expect(room.setSpeakerDevice).toHaveBeenCalledWith('spk-1');
    } finally {
      delete proto.setSinkId;
    }
  });

  it('drops the speaker section where the browser cannot pick an output', async () => {
    await renderInRoom(<MediaDeviceMenu kinds={['audioinput', 'audiooutput']} />, videoRoom());
    expect(screen.getByRole('button', { name: 'Choose microphone' })).toBeInTheDocument();
  });
});

describe('useMediaDevices', () => {
  afterAll(() => removeMediaDevices());

  it('lists devices of one kind and refreshes on devicechange', async () => {
    const devices = [...DEVICES];
    const md = installMediaDevices(devices);
    function Probe() {
      return (
        <div data-testid="list">
          {useMediaDevices('videoinput')
            .map((d) => d.label)
            .join(',')}
        </div>
      );
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('list').textContent).toBe('FaceTime HD,USB Webcam'));

    devices.push({ deviceId: 'cam-3', kind: 'videoinput', label: '' });
    await act(async () => md.fireDeviceChange());
    await waitFor(() => expect(screen.getByTestId('list').textContent).toBe('FaceTime HD,USB Webcam,Camera 3'));
  });
});

describe('<ControlBar> / <DisconnectButton>', () => {
  beforeEach(() => {
    resetFakeRtc();
    installMediaDevices(DEVICES);
  });
  afterAll(() => removeMediaDevices());

  it('is a labelled toolbar with mic, camera and leave; screen share only where supported', async () => {
    await renderInRoom(<ControlBar />, videoRoom());
    const toolbar = screen.getByRole('toolbar', { name: 'Call controls' });
    expect(toolbar).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Microphone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Camera' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
    // jsdom has no getDisplayMedia.
    expect(screen.queryByRole('button', { name: 'Share screen' })).toBeNull();
    // No chat panel was wired up, so no chat button.
    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull();
  });

  it('shows screen share when getDisplayMedia exists, and moves focus with arrow keys', async () => {
    installMediaDevices(DEVICES, { getDisplayMedia: jest.fn() });
    const room = videoRoom();
    publishOnEnable(room);
    await renderInRoom(<ControlBar variation="minimal" showDeviceMenus={false} />, room);
    const share = screen.getByRole('button', { name: 'Share screen' });
    await act(async () => share.click());
    expect(room.enableScreenShare).toHaveBeenCalled();
    expect(share).toHaveAttribute('aria-pressed', 'true');

    const mic = screen.getByRole('button', { name: 'Microphone' });
    mic.focus();
    fireEvent.keyDown(mic, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: 'Camera' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Camera' }), { key: 'ArrowLeft' });
    expect(mic).toHaveFocus();
  });

  it('leaves through the store and then calls onLeave', async () => {
    const onLeave = jest.fn();
    await renderInRoom(<DisconnectButton onLeave={onLeave} />, videoRoom());
    await act(async () => screen.getByRole('button', { name: 'Leave' }).click());
    expect(lastClient().leaveMock).toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
