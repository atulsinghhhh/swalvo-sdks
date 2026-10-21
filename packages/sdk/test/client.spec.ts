import { RTCClient, createRTCClient } from '../src/client';
import { RTCError } from '../src/errors';
import { FakeAdapter } from './helpers/fake-adapter';
import { makeToken } from './helpers/token';

describe('createRTCClient', () => {
  it('returns an RTCClient for a valid config', () => {
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const client = createRTCClient({ token, endpoint: 'wss://rtc.example.com' });
    expect(client).toBeInstanceOf(RTCClient);
  });

  it('throws INVALID_TOKEN synchronously for a missing token — never reaches the network', () => {
    expect(() => createRTCClient({ token: '', endpoint: 'wss://rtc.example.com' })).toThrow(RTCError);
  });
});

describe('RTCClient.join', () => {
  it('connects the adapter with the configured endpoint/token/iceServers and returns a Room for that roomId', async () => {
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const iceServers = [{ urls: 'stun:example.com:3478' }];
    let capturedAdapter: FakeAdapter | undefined;

    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        iceServers,
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: false,
        adaptiveStream: true,
      },
      () => {
        capturedAdapter = new FakeAdapter();
        return capturedAdapter;
      },
    );

    const room = await client.join('room-1');

    expect(room.roomId).toBe('room-1');
    expect(capturedAdapter?.connectCalls).toEqual([{ endpoint: 'wss://rtc.example.com', token, iceServers }]);
  });

  it('throws ROOM_NOT_FOUND before ever calling adapter.connect() when roomId does not match the token', async () => {
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    let capturedAdapter: FakeAdapter | undefined;

    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: false,
        adaptiveStream: true,
      },
      () => {
        capturedAdapter = new FakeAdapter();
        return capturedAdapter;
      },
    );

    await expect(client.join('a-different-room')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    expect(capturedAdapter).toBeUndefined();
  });

  it('defaults to the room named in the token when join() is called with no argument', async () => {
    // The whole point of createRTCClient(grant) + join(): the grant already
    // said which room, so the application should not have to repeat it.
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    let capturedAdapter: FakeAdapter | undefined;

    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: false,
        adaptiveStream: true,
      },
      () => {
        capturedAdapter = new FakeAdapter();
        return capturedAdapter;
      },
    );

    const room = await client.join();

    // The name, not the id: it is what logs and application code deal in.
    expect(room.roomId).toBe('support-room');
    expect(capturedAdapter?.connectCalls).toHaveLength(1);
  });

  it('falls back to the token room id when the token carries no room name', async () => {
    const token = makeToken({ rid: 'room-1' });
    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: false,
        adaptiveStream: true,
      },
      () => new FakeAdapter(),
    );

    const room = await client.join();

    expect(room.roomId).toBe('room-1');
  });

  it('throws ROOM_NOT_FOUND from join() with no argument when the token names no room at all', async () => {
    // assertTokenMatchesRoom deliberately lets a claimless token through as
    // a courtesy check, so this case has to be caught before it, or an
    // undefined room would reach the adapter.
    const token = makeToken({});
    let capturedAdapter: FakeAdapter | undefined;

    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: false,
        adaptiveStream: true,
      },
      () => {
        capturedAdapter = new FakeAdapter();
        return capturedAdapter;
      },
    );

    await expect(client.join()).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    expect(capturedAdapter).toBeUndefined();
  });

  it('accepts a whole RTC grant verbatim, extra mint-response fields and all', () => {
    // What the control plane actually returns, forwarded untouched. If this
    // ever stops type-checking or throwing-free, createRTCClient(grant) has
    // regressed as a documented convenience.
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const grant = {
      id: 'tok_1',
      token,
      endpoint: 'wss://rtc.example.com',
      roomId: 'room-1',
      roomName: 'support-room',
      participantIdentity: 'alice',
      permissions: { join: true, subscribe: true, publish: true },
      iceServers: [{ urls: 'stun:example.com:3478' }],
      telemetryUrl: 'https://api.example.com',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: new Date().toISOString(),
    };

    expect(createRTCClient(grant)).toBeInstanceOf(RTCClient);
  });

  it('propagates a connection failure from the adapter as a rejected promise', async () => {
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: false,
        adaptiveStream: true,
      },
      () => {
        const adapter = new FakeAdapter();
        adapter.connect = jest.fn().mockRejectedValue(new RTCError('NETWORK_ERROR', 'unreachable'));
        return adapter;
      },
    );

    await expect(client.join('room-1')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

describe('RTCClient.onDeviceChange (Phase 11)', () => {
  // jsdom has no navigator.mediaDevices whatsoever. Polyfill just enough
  // for this one test, shaped the way every real browser shapes it.
  const originalMediaDevices = (navigator as { mediaDevices?: unknown }).mediaDevices;
  const addEventListener = jest.fn();
  const removeEventListener = jest.fn();

  beforeEach(() => {
    addEventListener.mockClear();
    removeEventListener.mockClear();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { addEventListener, removeEventListener },
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: originalMediaDevices, configurable: true });
  });

  it('subscribes to the browser devicechange event and returns a working unsubscribe', () => {
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const client = createRTCClient({ token, endpoint: 'wss://rtc.example.com', telemetry: false });
    const callback = jest.fn();

    const unsubscribe = client.onDeviceChange(callback);
    expect(addEventListener).toHaveBeenCalledWith('devicechange', callback);

    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith('devicechange', callback);
  });
});

describe('RTCClient.leave', () => {
  it('leaves the most recently joined room', async () => {
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    let capturedAdapter: FakeAdapter | undefined;
    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: false,
        adaptiveStream: true,
      },
      () => {
        capturedAdapter = new FakeAdapter();
        return capturedAdapter;
      },
    );

    await client.join('room-1');
    await client.leave();

    expect(capturedAdapter?.disconnectCalls).toBe(1);
  });

  it('is a no-op when no room has been joined', async () => {
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const client = createRTCClient({ token, endpoint: 'wss://rtc.example.com' });
    await expect(client.leave()).resolves.toBeUndefined();
  });
});

describe('RTCClient.setCamera / setMicrophone', () => {
  it('throws when called before joining a room', async () => {
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const client = createRTCClient({ token, endpoint: 'wss://rtc.example.com' });

    await expect(client.setCamera('device-1')).rejects.toBeInstanceOf(RTCError);
    await expect(client.setMicrophone('device-2')).rejects.toBeInstanceOf(RTCError);
  });

  it('delegates to the joined room once one exists', async () => {
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    let capturedAdapter: FakeAdapter | undefined;
    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: false,
        adaptiveStream: true,
      },
      () => {
        capturedAdapter = new FakeAdapter();
        return capturedAdapter;
      },
    );

    await client.join('room-1');
    await client.setCamera('device-1');
    await client.setMicrophone('device-2');

    expect(capturedAdapter?.setDeviceCalls).toEqual([
      { kind: 'videoinput', deviceId: 'device-1' },
      { kind: 'audioinput', deviceId: 'device-2' },
    ]);
  });
});

describe('RTCClient.join — telemetry (Phase 9, best-effort, never blocking)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('the RTC connection succeeds even when the telemetry endpoint is completely unreachable', async () => {
    // The load-bearing guarantee from Phase 9 spec §11. A telemetry outage
    // must never surface as an RTC failure.
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: true,
        adaptiveStream: true,
        telemetryUrl: 'http://telemetry.example.com',
      },
      () => new FakeAdapter(),
    );

    const room = await client.join('room-1');

    expect(room.roomId).toBe('room-1');
    expect(room.connectionState).toBe('connected');
  });

  it('sends a "connection_started" telemetry event before the adapter connects', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: true,
        adaptiveStream: true,
        telemetryUrl: 'http://telemetry.example.com',
      },
      () => new FakeAdapter(),
    );

    await client.join('room-1');

    const types = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).type);
    expect(types).toContain('connection_started');
  });

  it('sends "connection_failed" and an error event, then still rejects, when the adapter fails to connect', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: true,
        adaptiveStream: true,
        telemetryUrl: 'http://telemetry.example.com',
      },
      () => {
        const adapter = new FakeAdapter();
        adapter.connect = jest.fn().mockRejectedValue(new RTCError('NETWORK_ERROR', 'unreachable'));
        return adapter;
      },
    );

    await expect(client.join('room-1')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    const events = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(events.some((e) => e.type === 'connection_failed')).toBe(true);
    expect(events.some((e) => e.type === 'error' && e.data.code === 'NETWORK_ERROR')).toBe(true);
  });

  it('never calls fetch at all when telemetry is disabled', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: false,
        adaptiveStream: true,
      },
      () => new FakeAdapter(),
    );

    await client.join('room-1');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getDiagnostics() throws before join(), and delegates to the room after', async () => {
    const token = makeToken({ rid: 'room-1', rnm: 'support-room' });
    const client = new RTCClient(
      {
        token,
        endpoint: 'wss://rtc.example.com',
        logLevel: 'silent',
        autoReconnect: true,
        telemetry: false,
        adaptiveStream: true,
      },
      () => new FakeAdapter(),
    );

    expect(() => client.getDiagnostics()).toThrow(RTCError);

    await client.join('room-1');

    expect(client.getDiagnostics().connectionState).toBe('connected');
  });
});
