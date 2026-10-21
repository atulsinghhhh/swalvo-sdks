import { SwalvoLiveStream, joinLiveStream } from '../src/live-stream';
import type { LiveStreamCredentials } from '../src/types';
import { __resetCalls as resetWebrtcCalls } from './mocks/react-native-webrtc';
import { __calls as audioCalls, __resetCalls as resetAudioCalls } from './mocks/react-native-incall-manager';
import { __appState, PermissionsAndroid, __setPlatform } from './mocks/react-native';

/**
 * Drives `SwalvoLiveStream` against the same fake `@swalvo/rtc` client
 * `swalvo.spec.ts` uses.
 *
 * The class is a thin wrapper round `Swalvo`, so what's worth testing is the
 * *translation*: credentials -> Swalvo config, role -> isHost, reactions.
 * Not the join/leave mechanics `Swalvo` already covers.
 */
const rtcState = {
  joins: [] as string[],
  leaves: 0,
};

jest.mock('@swalvo/rtc', () => ({
  createRTCClient: () => ({
    join: async (roomId: string) => {
      rtcState.joins.push(roomId);
      return {
        connectionState: 'connected',
        leave: async () => {
          rtcState.leaves += 1;
        },
      };
    },
    leave: async () => {
      rtcState.leaves += 1;
    },
  }),
  RTCError: class RTCError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

function credentials(overrides: Partial<LiveStreamCredentials> = {}): LiveStreamCredentials {
  return {
    streamId: 'stream_1',
    role: 'VIEWER',
    rtc: { token: 'rtc-token', endpoint: 'wss://rtc.example.com' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetWebrtcCalls();
  resetAudioCalls();
  __appState.listeners.clear();
  __appState.current = 'active';
  __setPlatform('android');
  PermissionsAndroid.requestMultiple.mockResolvedValue({
    'android.permission.CAMERA': 'granted',
    'android.permission.RECORD_AUDIO': 'granted',
  } as never);

  rtcState.joins = [];
  rtcState.leaves = 0;
});

describe('SwalvoLiveStream', () => {
  it('derives isHost from role, never something the SDK infers on its own', () => {
    expect(new SwalvoLiveStream(credentials({ role: 'HOST' })).isHost).toBe(true);
    expect(new SwalvoLiveStream(credentials({ role: 'CO_HOST' })).isHost).toBe(true);
    expect(new SwalvoLiveStream(credentials({ role: 'VIEWER' })).isHost).toBe(false);
  });

  it('join() joins the room named by streamId', async () => {
    const stream = new SwalvoLiveStream(credentials());
    await stream.join();

    expect(rtcState.joins).toEqual(['stream_1']);
    expect(stream.room).toBeDefined();
  });

  it("join() follows the credential's rtcRoom (a cascaded viewer's edge room)", async () => {
    const stream = new SwalvoLiveStream(credentials({ rtcRoom: 'stream_1__e3' }));
    await stream.join();
    expect(rtcState.joins).toEqual(['stream_1__e3']);
    expect(stream.delivery).toBe('rtc');
  });

  it('an HLS viewer (playback, no rtc) never joins RTC and exposes the playback url', async () => {
    const stream = new SwalvoLiveStream(
      credentials({ rtc: undefined, playback: { url: 'https://cdn/stream_1/master.m3u8', status: 'READY' } }),
    );
    await expect(stream.join()).resolves.toBeUndefined();
    expect(rtcState.joins).toEqual([]);
    expect(stream.delivery).toBe('hls');
    expect(stream.playbackUrl).toBe('https://cdn/stream_1/master.m3u8');
  });

  it('refuses credentials with neither rtc nor a playback url', async () => {
    const stream = new SwalvoLiveStream(credentials({ rtc: undefined, playback: { url: null, status: 'STARTING' } }));
    await expect(stream.join()).rejects.toThrow(/acceptPlayback/);
  });

  it('does not prompt for camera/microphone permission for a VIEWER by default', async () => {
    await new SwalvoLiveStream(credentials({ role: 'VIEWER' })).join();
    expect(PermissionsAndroid.requestMultiple).not.toHaveBeenCalled();
  });

  it('prompts for permission for a HOST by default', async () => {
    await new SwalvoLiveStream(credentials({ role: 'HOST' })).join();
    expect(PermissionsAndroid.requestMultiple).toHaveBeenCalled();
  });

  it('an explicit requestPermissions overrides the role-based default', async () => {
    await new SwalvoLiveStream(credentials({ role: 'VIEWER' })).join({ requestPermissions: true });
    expect(PermissionsAndroid.requestMultiple).toHaveBeenCalled();
  });

  it('has no chat handle when credentials carry no chat token', () => {
    expect(new SwalvoLiveStream(credentials()).chat).toBeUndefined();
  });

  it('react() throws when the stream has no chat conversation attached', async () => {
    const stream = new SwalvoLiveStream(credentials());
    await stream.join();

    await expect(stream.react('❤️')).rejects.toThrow(/no chat conversation attached/);
  });

  it('leave() disposes the underlying Swalvo instance', async () => {
    const stream = new SwalvoLiveStream(credentials());
    await stream.join();

    await stream.leave();

    expect(rtcState.leaves).toBe(1);
    expect(stream.room).toBeUndefined();
  });

  it('joinLiveStream() constructs and joins in one call', async () => {
    const stream = await joinLiveStream(credentials());

    expect(stream).toBeInstanceOf(SwalvoLiveStream);
    expect(rtcState.joins).toEqual(['stream_1']);
  });

  it('forwards onAppStateChange/onNetworkReconnect to the underlying Swalvo instance', async () => {
    const onAppStateChange = jest.fn();
    const stream = new SwalvoLiveStream(credentials({ role: 'HOST' }), { onAppStateChange });
    await stream.join();

    expect(__appState.listeners.size).toBe(1);
    expect(audioCalls.start).toBe(1);
  });
});
