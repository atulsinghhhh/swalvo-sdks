import { createLogger } from '../src/logger';
import { LocalTrack, RemoteTrack } from '../src/track';
import type { LocalTrackDelegate, RemoteTrackDelegate } from '../src/track';
import { Room } from '../src/room';
import { FakeAdapter } from './helpers/fake-adapter';

const logger = createLogger('silent');

describe('Room — connection state events', () => {
  it('emits "connected" the first time the adapter reports connected', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    const connected = jest.fn();
    room.on('connected', connected);

    adapter.setState('connected');

    expect(connected).toHaveBeenCalledTimes(1);
  });

  it('emits "reconnecting" then "reconnected" (not a second "connected") when recovering from a drop', () => {
    const adapter = new FakeAdapter();
    adapter.setState('connected');
    const room = new Room(adapter, 'room-1', logger);
    const connected = jest.fn();
    const reconnecting = jest.fn();
    const reconnected = jest.fn();
    room.on('connected', connected);
    room.on('reconnecting', reconnecting);
    room.on('reconnected', reconnected);

    adapter.setState('reconnecting');
    adapter.setState('connected');

    expect(reconnecting).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    expect(connected).not.toHaveBeenCalled();
  });

  it('emits "disconnected" on a clean disconnect, without an error event', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    const disconnected = jest.fn();
    const error = jest.fn();
    room.on('disconnected', disconnected);
    room.on('error', error);

    adapter.setState('disconnected');

    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('emits both "disconnected" and a CONNECTION_FAILED error when reconnection is exhausted', () => {
    const adapter = new FakeAdapter();
    adapter.setState('connected');
    const room = new Room(adapter, 'room-1', logger);
    const disconnected = jest.fn();
    const error = jest.fn();
    room.on('disconnected', disconnected);
    room.on('error', error);

    adapter.setState('reconnecting');
    adapter.setState('failed');

    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0].code).toBe('CONNECTION_FAILED');
  });

  it('always forwards the raw state via connectionStateChanged', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    const states: string[] = [];
    room.on('connectionStateChanged', (s) => states.push(s));

    adapter.setState('connecting');
    adapter.setState('connected');

    expect(states).toEqual(['connecting', 'connected']);
  });
});

describe('Room — participants and tracks', () => {
  it('forwards participantJoined/participantLeft from the adapter', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    const joined = jest.fn();
    const left = jest.fn();
    room.on('participantJoined', joined);
    room.on('participantLeft', left);

    const participant = adapter.addRemoteParticipant('bob');
    adapter.removeRemoteParticipant(participant);

    expect(joined).toHaveBeenCalledWith(participant);
    expect(left).toHaveBeenCalledWith(participant);
    expect(room.remoteParticipants).toEqual([]);
  });

  it('forwards trackMuted/trackUnmuted from the adapter (Phase 11)', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    const muted = jest.fn();
    const unmuted = jest.fn();
    room.on('trackMuted', muted);
    room.on('trackUnmuted', unmuted);
    const participant = adapter.addRemoteParticipant('bob');

    adapter.emitTrackMuted('camera', participant);
    adapter.emitTrackUnmuted('camera', participant);

    expect(muted).toHaveBeenCalledWith('camera', participant);
    expect(unmuted).toHaveBeenCalledWith('camera', participant);
  });

  it('remoteParticipants reflects the adapter map live', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);

    adapter.addRemoteParticipant('bob');
    adapter.addRemoteParticipant('carol');

    expect(room.remoteParticipants.map((p) => p.identity).sort()).toEqual(['bob', 'carol']);
  });

  it('forwards trackSubscribed/trackUnsubscribed', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    const subscribed = jest.fn();
    room.on('trackSubscribed', subscribed);

    const participant = adapter.addRemoteParticipant('bob');
    const track = new RemoteTrack(
      {
        mediaStreamTrack: {} as MediaStreamTrack,
        isMuted: false,
        attach: jest.fn(),
        detach: jest.fn(() => []),
      },
      'camera',
    );
    adapter.emitTrackSubscribed(track, participant);

    expect(subscribed).toHaveBeenCalledWith(track, participant);
  });

  /**
   * The live-streaming case: every viewer joins a broadcast that is already
   * running, so the host's tracks are subscribed during `client.join()` —
   * before the caller has a `Room` to attach a handler to. Media arrived
   * and decoded, and the page rendered nothing.
   */
  describe('trackSubscribed replay for publishers who were already live', () => {
    function remoteTrack(kind: 'camera' | 'microphone'): RemoteTrack {
      return new RemoteTrack(
        {
          mediaStreamTrack: {} as MediaStreamTrack,
          isMuted: false,
          attach: jest.fn(),
          detach: jest.fn(() => []),
        },
        kind,
      );
    }

    it('replays tracks subscribed before the handler was added', async () => {
      const adapter = new FakeAdapter();
      const room = new Room(adapter, 'room-1', logger);

      // What join() does: subscribe to whoever is already publishing.
      const host = adapter.addRemoteParticipant('host');
      const camera = remoteTrack('camera');
      const microphone = remoteTrack('microphone');
      host.tracks.push(camera, microphone);

      const subscribed = jest.fn();
      room.on('trackSubscribed', subscribed);
      await Promise.resolve();

      expect(subscribed).toHaveBeenCalledTimes(2);
      expect(subscribed).toHaveBeenCalledWith(camera, host);
      expect(subscribed).toHaveBeenCalledWith(microphone, host);
    });

    it('does not deliver twice to a handler that was already listening', async () => {
      const adapter = new FakeAdapter();
      const room = new Room(adapter, 'room-1', logger);
      const subscribed = jest.fn();
      room.on('trackSubscribed', subscribed);

      const host = adapter.addRemoteParticipant('host');
      const camera = remoteTrack('camera');
      host.tracks.push(camera);
      adapter.emitTrackSubscribed(camera, host);
      await Promise.resolve();

      expect(subscribed).toHaveBeenCalledTimes(1);
    });

    it('replays only to the handler being added, never to the ones already attached', async () => {
      const adapter = new FakeAdapter();
      const room = new Room(adapter, 'room-1', logger);
      const first = jest.fn();
      room.on('trackSubscribed', first);

      const host = adapter.addRemoteParticipant('host');
      const camera = remoteTrack('camera');
      host.tracks.push(camera);
      adapter.emitTrackSubscribed(camera, host);

      const second = jest.fn();
      room.on('trackSubscribed', second);
      await Promise.resolve();

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledWith(camera, host);
    });

    it('replays nothing when nobody is publishing yet', async () => {
      const adapter = new FakeAdapter();
      const room = new Room(adapter, 'room-1', logger);
      adapter.addRemoteParticipant('host');

      const subscribed = jest.fn();
      room.on('trackSubscribed', subscribed);
      await Promise.resolve();

      expect(subscribed).not.toHaveBeenCalled();
    });

    it('does not re-enter the caller inside .on()', () => {
      const adapter = new FakeAdapter();
      const room = new Room(adapter, 'room-1', logger);
      const host = adapter.addRemoteParticipant('host');
      host.tracks.push(remoteTrack('camera'));

      const subscribed = jest.fn();
      room.on('trackSubscribed', subscribed);

      // Deferred to a microtask, so a handler can rely on anything the
      // caller sets up on the line after `.on(...)`.
      expect(subscribed).not.toHaveBeenCalled();
    });
  });
});

describe('Room — actions delegate to the adapter', () => {
  it('enableCamera()/disableCamera() call adapter.enableCamera(true/false)', async () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);

    await room.enableCamera();
    await room.disableCamera();

    expect(adapter.enableCameraCalls).toEqual([true, false]);
  });

  it('enableMicrophone()/disableMicrophone() call adapter.enableMicrophone(true/false)', async () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);

    await room.enableMicrophone();
    await room.disableMicrophone();

    expect(adapter.enableMicrophoneCalls).toEqual([true, false]);
  });

  it('setCameraDevice()/setMicrophoneDevice() delegate with the right device kind', async () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);

    await room.setCameraDevice('camera-42');
    await room.setMicrophoneDevice('mic-7');

    expect(adapter.setDeviceCalls).toEqual([
      { kind: 'videoinput', deviceId: 'camera-42' },
      { kind: 'audioinput', deviceId: 'mic-7' },
    ]);
  });

  describe('setSpeakerDevice() (Phase 11)', () => {
    afterEach(() => {
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    });

    it('throws DEVICE_NOT_FOUND when the browser has no setSinkId support (e.g. Safari, or jsdom by default)', async () => {
      const adapter = new FakeAdapter();
      const room = new Room(adapter, 'room-1', logger);

      await expect(room.setSpeakerDevice('speaker-1')).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
      expect(adapter.setDeviceCalls).toEqual([]);
    });

    it('delegates to the adapter with kind "audiooutput" when setSinkId is supported', async () => {
      (HTMLMediaElement.prototype as unknown as { setSinkId: () => void }).setSinkId = jest.fn();
      const adapter = new FakeAdapter();
      const room = new Room(adapter, 'room-1', logger);

      await room.setSpeakerDevice('speaker-1');

      expect(adapter.setDeviceCalls).toEqual([{ kind: 'audiooutput', deviceId: 'speaker-1' }]);
    });
  });

  it('provisions a data channel as soon as something listens for data', () => {
    // Receiving needs a channel of one's own — the SFU fans data out over
    // each recipient's — and one is only created on demand. Subscribing to
    // the event is the demand; without this, a page that never sends could
    // not receive.
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);

    expect(adapter.ensureDataChannelCalls).toBe(0);

    room.on('dataReceived', () => undefined);
    expect(adapter.ensureDataChannelCalls).toBe(1);

    // `once()` registers through `on()`, so it is covered by the same hook.
    room.once('dataReceived', () => undefined);
    expect(adapter.ensureDataChannelCalls).toBe(2);

    // Any other event is none of this concern.
    room.on('connected', () => undefined);
    expect(adapter.ensureDataChannelCalls).toBe(2);
  });

  it('sendData() encodes a string payload to bytes before handing it to the adapter', async () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);

    await room.sendData('hello');

    expect(adapter.sendDataCalls).toHaveLength(1);
    expect(new TextDecoder().decode(adapter.sendDataCalls[0])).toBe('hello');
  });

  it('leave() calls adapter.disconnect()', async () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);

    await room.leave();

    expect(adapter.disconnectCalls).toBe(1);
  });
});

describe('Room — telemetry (best-effort, Phase 9)', () => {
  function fakeTelemetry() {
    return { connectionId: 'conn_test123', send: jest.fn() };
  }

  it("exposes the telemetry client's connectionId as its own public connectionId", () => {
    const adapter = new FakeAdapter();
    const telemetry = fakeTelemetry();
    const room = new Room(adapter, 'room-1', logger, telemetry);

    expect(room.connectionId).toBe('conn_test123');
  });

  it('sends "connected" (not "reconnected") on the first successful connection', () => {
    const adapter = new FakeAdapter();
    const telemetry = fakeTelemetry();
    const room = new Room(adapter, 'room-1', logger, telemetry);

    adapter.setState('connected');

    expect(telemetry.send).toHaveBeenCalledWith('connected');
    expect(telemetry.send).not.toHaveBeenCalledWith('reconnected');
    void room;
  });

  it('sends "reconnecting" then "reconnected" (not a second "connected") when recovering', () => {
    const adapter = new FakeAdapter();
    adapter.setState('connected');
    const telemetry = fakeTelemetry();
    new Room(adapter, 'room-1', logger, telemetry);
    telemetry.send.mockClear();

    adapter.setState('reconnecting');
    adapter.setState('connected');

    expect(telemetry.send).toHaveBeenCalledWith('reconnecting');
    expect(telemetry.send).toHaveBeenCalledWith('reconnected');
    expect(telemetry.send).not.toHaveBeenCalledWith('connected');
  });

  it('increments reconnectCount (visible via getDiagnostics) only on an actual reconnect', () => {
    const adapter = new FakeAdapter();
    adapter.setState('connected');
    const room = new Room(adapter, 'room-1', logger, fakeTelemetry());

    adapter.setState('reconnecting');
    adapter.setState('connected');
    adapter.setState('reconnecting');
    adapter.setState('connected');

    expect(room.getDiagnostics().reconnectCount).toBe(2);
  });

  it('sends "connection_failed" and an "error" event when the adapter reports failed', () => {
    const adapter = new FakeAdapter();
    adapter.setState('connected');
    const telemetry = fakeTelemetry();
    new Room(adapter, 'room-1', logger, telemetry);
    telemetry.send.mockClear();

    adapter.setState('failed');

    expect(telemetry.send).toHaveBeenCalledWith('connection_failed');
    expect(telemetry.send).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'CONNECTION_FAILED' }));
  });

  it('sends "disconnected" (not "connection_failed") on a clean disconnect', () => {
    const adapter = new FakeAdapter();
    adapter.setState('connected');
    const telemetry = fakeTelemetry();
    new Room(adapter, 'room-1', logger, telemetry);
    telemetry.send.mockClear();

    adapter.setState('disconnected');

    expect(telemetry.send).toHaveBeenCalledWith('disconnected');
    expect(telemetry.send).not.toHaveBeenCalledWith('connection_failed');
  });

  it('sends participant_joined/participant_left with the participant identity', () => {
    const adapter = new FakeAdapter();
    const telemetry = fakeTelemetry();
    new Room(adapter, 'room-1', logger, telemetry);

    const participant = adapter.addRemoteParticipant('bob');
    adapter.removeRemoteParticipant(participant);

    expect(telemetry.send).toHaveBeenCalledWith('participant_joined', { participantIdentity: 'bob' });
    expect(telemetry.send).toHaveBeenCalledWith('participant_left', { participantIdentity: 'bob' });
  });

  it('getDiagnostics() never includes a token or any secret-shaped field', () => {
    const adapter = new FakeAdapter();
    adapter.setState('connected');
    const room = new Room(adapter, 'room-1', logger, fakeTelemetry());

    const diagnostics = room.getDiagnostics();

    expect(diagnostics).toEqual({
      connectionState: 'connected',
      iceConnectionState: undefined,
      signalingState: undefined,
      reconnectCount: 0,
      sdkVersion: expect.any(String),
      platform: expect.any(String),
      browser: expect.any(String),
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(/token|secret|credential/i);
  });

  it('defaults to a working no-op telemetry client when none is provided, without throwing', () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);

    expect(() => adapter.setState('connected')).not.toThrow();
    expect(room.connectionId).toMatch(/^conn_/);
  });
});

describe('Room — getConnectionStats()', () => {
  function fakeLocalDelegate(getSenderStats: LocalTrackDelegate['getSenderStats']): LocalTrackDelegate {
    return {
      mediaStreamTrack: { id: 'local', stop: jest.fn() } as unknown as MediaStreamTrack,
      mediaStream: undefined,
      isMuted: false,
      attach: jest.fn(() => document.createElement('audio')),
      detach: jest.fn(() => []),
      mute: jest.fn(),
      unmute: jest.fn(),
      getSenderStats,
    };
  }

  function fakeRemoteDelegate(getReceiverStats: RemoteTrackDelegate['getReceiverStats']): RemoteTrackDelegate {
    return {
      mediaStreamTrack: { id: 'remote', stop: jest.fn() } as unknown as MediaStreamTrack,
      mediaStream: undefined,
      isMuted: false,
      attach: jest.fn(() => document.createElement('video')),
      detach: jest.fn(() => []),
      getReceiverStats,
    };
  }

  it('reports empty local/remote arrays before anything is published or subscribed', async () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);

    const stats = await room.getConnectionStats();

    expect(stats.local).toEqual([]);
    expect(stats.remote).toEqual([]);
  });

  it('collects stats for every locally published track', async () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    adapter.localParticipant.tracks.push(
      new LocalTrack(fakeLocalDelegate(jest.fn().mockResolvedValue({ timestamp: 1, jitter: 0.01 })), 'microphone'),
      new LocalTrack(fakeLocalDelegate(jest.fn().mockResolvedValue({ timestamp: 1, frameWidth: 640 })), 'camera'),
    );

    const stats = await room.getConnectionStats();

    expect(stats.local).toHaveLength(2);
    expect(stats.local.map((s) => s.kind).sort()).toEqual(['camera', 'microphone']);
  });

  it('collects stats across every remote participant, not just the first', async () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    const alice = adapter.addRemoteParticipant('alice');
    const bob = adapter.addRemoteParticipant('bob');
    alice.tracks.push(new RemoteTrack(fakeRemoteDelegate(jest.fn().mockResolvedValue({ timestamp: 1 })), 'microphone'));
    bob.tracks.push(new RemoteTrack(fakeRemoteDelegate(jest.fn().mockResolvedValue({ timestamp: 1 })), 'camera'));

    const stats = await room.getConnectionStats();

    expect(stats.remote).toHaveLength(2);
  });

  it('drops a track that had nothing to report rather than a hole in the array', async () => {
    const adapter = new FakeAdapter();
    const room = new Room(adapter, 'room-1', logger);
    adapter.localParticipant.tracks.push(
      new LocalTrack(fakeLocalDelegate(jest.fn().mockResolvedValue(undefined)), 'microphone'),
      new LocalTrack(fakeLocalDelegate(jest.fn().mockResolvedValue({ timestamp: 1 })), 'camera'),
    );

    const stats = await room.getConnectionStats();

    expect(stats.local).toHaveLength(1);
    expect(stats.local[0].kind).toBe('camera');
  });

  it('reports the adapter’s connection quality and current connection state', async () => {
    const adapter = new FakeAdapter();
    adapter.connectionQuality = 'poor';
    const room = new Room(adapter, 'room-1', logger);
    adapter.setState('connected');

    const stats = await room.getConnectionStats();

    expect(stats).toMatchObject({ connectionState: 'connected', connectionQuality: 'poor' });
  });
});

describe('Room — periodic stats monitor', () => {
  function fakeTelemetryWithSend() {
    return { connectionId: 'conn_test123', send: jest.fn() };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not report stats before the room has ever connected', () => {
    const adapter = new FakeAdapter();
    const telemetry = fakeTelemetryWithSend();
    new Room(adapter, 'room-1', logger, telemetry);

    jest.advanceTimersByTime(30_000);

    expect(telemetry.send).not.toHaveBeenCalledWith('stats', expect.anything());
  });

  it('reports stats on an interval once connected', async () => {
    const adapter = new FakeAdapter();
    const telemetry = fakeTelemetryWithSend();
    new Room(adapter, 'room-1', logger, telemetry);

    adapter.setState('connected');
    await jest.advanceTimersByTimeAsync(5_000);

    expect(telemetry.send).toHaveBeenCalledWith('stats', expect.objectContaining({ connectionState: 'connected' }));
  });

  it('stops reporting once the room disconnects', async () => {
    const adapter = new FakeAdapter();
    const telemetry = fakeTelemetryWithSend();
    new Room(adapter, 'room-1', logger, telemetry);
    adapter.setState('connected');
    await jest.advanceTimersByTimeAsync(5_000);
    telemetry.send.mockClear();

    adapter.setState('disconnected');
    await jest.advanceTimersByTimeAsync(30_000);

    expect(telemetry.send).not.toHaveBeenCalledWith('stats', expect.anything());
  });

  it('stops reporting once leave() is called, even without a disconnect event', async () => {
    // leave() is what most apps call directly. Wait on the adapter to
    // separately emit "disconnected" and the timer keeps running in
    // between for however long that takes.
    const adapter = new FakeAdapter();
    const telemetry = fakeTelemetryWithSend();
    const room = new Room(adapter, 'room-1', logger, telemetry);
    adapter.setState('connected');
    await jest.advanceTimersByTimeAsync(5_000);
    telemetry.send.mockClear();

    await room.leave();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(telemetry.send).not.toHaveBeenCalledWith('stats', expect.anything());
  });

  it('does not start a second timer on a reconnect, doubling the report rate', async () => {
    const adapter = new FakeAdapter();
    const telemetry = fakeTelemetryWithSend();
    new Room(adapter, 'room-1', logger, telemetry);
    adapter.setState('connected');
    adapter.setState('reconnecting');
    adapter.setState('connected');
    telemetry.send.mockClear();

    await jest.advanceTimersByTimeAsync(5_000);

    // Exactly one 'stats' call per interval tick. Two live timers would
    // report twice a tick.
    const statsCalls = telemetry.send.mock.calls.filter(([type]) => type === 'stats');
    expect(statsCalls).toHaveLength(1);
  });
});

/**
 * `waitUntilConnected()` exists because `join()` resolves on the
 * control-plane join, not on the media connection. That's a genuine
 * behaviour difference from the LiveKit-backed SDK, where `connect()` only
 * resolved once media was up. See docs/migration/from-livekit.md.
 */
describe('Room — waitUntilConnected', () => {
  it('resolves immediately when already connected', async () => {
    const adapter = new FakeAdapter();
    adapter.setState('connected');
    const room = new Room(adapter, 'room-1', logger);

    await expect(room.waitUntilConnected()).resolves.toBeUndefined();
  });

  it('resolves when the connection comes up after joining', async () => {
    const adapter = new FakeAdapter();
    adapter.setState('connecting');
    const room = new Room(adapter, 'room-1', logger);

    const waiting = room.waitUntilConnected(1_000);
    adapter.setState('connected');

    await expect(waiting).resolves.toBeUndefined();
  });

  it('rejects rather than hanging when the connection fails', async () => {
    const adapter = new FakeAdapter();
    adapter.setState('connecting');
    const room = new Room(adapter, 'room-1', logger);

    const waiting = room.waitUntilConnected(1_000);
    adapter.setState('failed');

    await expect(waiting).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });

  it('rejects on timeout, naming the state it was stuck in', async () => {
    // A subscriber in a room where nobody publishes can quite legitimately
    // sit at 'connecting'; there's nothing to negotiate. Reporting the
    // state is what tells those two cases apart.
    jest.useFakeTimers();
    try {
      const adapter = new FakeAdapter();
      adapter.setState('connecting');
      const room = new Room(adapter, 'room-1', logger);

      const waiting = room.waitUntilConnected(5_000);
      const assertion = expect(waiting).rejects.toThrow(/Still connecting after 5000ms/);
      await jest.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops listening once settled, so a later transition cannot double-settle', async () => {
    const adapter = new FakeAdapter();
    adapter.setState('connecting');
    const room = new Room(adapter, 'room-1', logger);

    const waiting = room.waitUntilConnected(1_000);
    adapter.setState('connected');
    await waiting;

    // Throws an unhandled rejection if the handler is still bound.
    expect(() => adapter.setState('failed')).not.toThrow();
  });
});
