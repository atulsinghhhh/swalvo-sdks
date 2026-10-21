import { act, render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SwalvoRoom } from '../../src/swalvo-room';
import { FakeEmitter, FakeRoom, lastClient } from './fake-rtc-client';

/**
 * Doubles for the video UI kit specs: participants and tracks shaped like
 * @swalvo/rtc's, plus a renderer that mounts <SwalvoRoom> and completes
 * the join. Same approach as media-hooks.spec.tsx.
 */

// jsdom implements no media playback; the kit calls play() for autoplay detection.
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  writable: true,
  value: jest.fn(() => Promise.resolve()),
});

export class FakeTrack {
  isMuted = false;
  subscriptionState = 'active';
  layer?: string;
  readonly attach = jest.fn((el?: HTMLMediaElement) => el ?? document.createElement('video'));
  readonly detach = jest.fn(() => [] as HTMLMediaElement[]);
  readonly setVisible = jest.fn();
  readonly mute = jest.fn(async () => {
    this.isMuted = true;
  });
  readonly unmute = jest.fn(async () => {
    this.isMuted = false;
  });
  readonly mediaStreamTrack: { getSettings: () => { deviceId?: string }; stop: jest.Mock };

  constructor(
    public kind: string,
    deviceId?: string,
  ) {
    this.mediaStreamTrack = { getSettings: () => ({ deviceId }), stop: jest.fn() };
  }
}

export class FakePeer extends FakeEmitter {
  tracks: FakeTrack[] = [];
  isSpeaking = false;
  audioLevel = 0;
  connectionQuality = 'unknown';
  constructor(
    public identity: string,
    public metadata?: string,
  ) {
    super();
  }
  withTracks(...kinds: string[]): this {
    this.tracks = kinds.map((kind) => new FakeTrack(kind));
    return this;
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

export interface VideoRoom extends FakeRoom {
  localParticipant: FakePeer & FakeRoom['localParticipant'];
  remoteParticipants: Array<FakePeer & FakeRoom['localParticipant']>;
}

/** A FakeRoom whose participants are FakePeers. */
export function videoRoom(remotes: FakePeer[] = [], local = new FakePeer('local-user')): VideoRoom {
  const room = new FakeRoom('room-1') as unknown as VideoRoom;
  room.localParticipant = local as never;
  room.remoteParticipants = remotes as never;
  return room;
}

/** Makes `room.enableCamera()` etc. behave like the SDK: publish, then emit. */
export function publishOnEnable(room: VideoRoom): void {
  const wire = (enable: string, disable: string, kind: string) => {
    (room as unknown as Record<string, jest.Mock>)[enable].mockImplementation(async () => {
      const track = new FakeTrack(kind, `${kind}-default`);
      room.localParticipant.tracks.push(track);
      room.emit('localTrackPublished', track);
      return track;
    });
    (room as unknown as Record<string, jest.Mock>)[disable].mockImplementation(async () => {
      const track = room.localParticipant.tracks.find((t) => t.kind === kind);
      room.localParticipant.tracks = room.localParticipant.tracks.filter((t) => t.kind !== kind);
      room.emit('localTrackUnpublished', track);
    });
  };
  wire('enableCamera', 'disableCamera', 'camera');
  wire('enableMicrophone', 'disableMicrophone', 'microphone');
  wire('enableScreenShare', 'disableScreenShare', 'screenShare');
}

export async function renderInRoom(
  children: ReactNode,
  room: VideoRoom = videoRoom(),
): Promise<RenderResult & { room: VideoRoom }> {
  const result = render(
    <SwalvoRoom token="t" endpoint="wss://rtc.example.com" room="room-1">
      {children}
    </SwalvoRoom>,
  );
  await act(async () => {
    lastClient().pendingJoin.resolve(room as unknown as FakeRoom);
    await lastClient().pendingJoin.promise;
  });
  return Object.assign(result, { room });
}

/** Installs a fake `navigator.mediaDevices`. Returns it for assertions. */
export function installMediaDevices(
  devices: Array<{ deviceId: string; kind: string; label: string }>,
  extra: Record<string, unknown> = {},
) {
  const listeners = new Set<() => void>();
  const md = {
    enumerateDevices: jest.fn(async () => devices.map((d) => ({ ...d, groupId: '', toJSON() {} }))),
    addEventListener: jest.fn((_: string, fn: () => void) => listeners.add(fn)),
    removeEventListener: jest.fn((_: string, fn: () => void) => listeners.delete(fn)),
    fireDeviceChange: () => listeners.forEach((fn) => fn()),
    ...extra,
  };
  Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true, writable: true });
  return md;
}

export function removeMediaDevices(): void {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true, writable: true });
}
