import { Swalvo } from '../src/swalvo';
import { __calls as audioCalls, __resetCalls as resetAudioCalls } from './mocks/react-native-incall-manager';
import { PermissionsAndroid, __setPlatform } from './mocks/react-native';

/**
 * React Native and Phase 5: react-native-webrtc has no frame cryptor, so
 * an end-to-end encrypted room is refused with a typed error; RED and the
 * camera codec pass straight through to @swalvo/rtc.
 */
const state = {
  configs: [] as Record<string, unknown>[],
  joins: 0,
  leaves: 0,
  roomIsE2EE: false,
};

jest.mock('@swalvo/rtc', () => ({
  createRTCClient: (config: Record<string, unknown>) => {
    state.configs.push(config);
    return {
      join: async () => {
        state.joins += 1;
        return {
          connectionState: 'connected',
          get isE2EE() {
            return state.roomIsE2EE;
          },
          leave: async () => {
            state.leaves += 1;
          },
        };
      },
    };
  },
  RTCError: class RTCError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ sub: 'alice', rid: 'room_1', ...claims })}.sig`;
}

beforeEach(() => {
  jest.clearAllMocks();
  state.configs = [];
  state.joins = 0;
  state.leaves = 0;
  state.roomIsE2EE = false;
  resetAudioCalls();
  __setPlatform('android');
  PermissionsAndroid.requestMultiple.mockResolvedValue({
    'android.permission.CAMERA': 'granted',
    'android.permission.RECORD_AUDIO': 'granted',
  } as never);
});

describe('E2EE on React Native', () => {
  it('refuses a token for an encrypted room before prompting or connecting', async () => {
    const swalvo = new Swalvo({ token: token({ e2ee: true }), endpoint: 'wss://rtc.example.com' });
    await expect(swalvo.join('room_1')).rejects.toMatchObject({ code: 'E2EE_NOT_SUPPORTED' });
    expect(state.joins).toBe(0);
    expect(PermissionsAndroid.requestMultiple).not.toHaveBeenCalled();
  });

  it('leaves again when the server says the room is encrypted', async () => {
    state.roomIsE2EE = true;
    const swalvo = new Swalvo({ token: token({}), endpoint: 'wss://rtc.example.com' });
    await expect(swalvo.join('room_1', { requestPermissions: false })).rejects.toMatchObject({
      code: 'E2EE_NOT_SUPPORTED',
    });
    expect(state.leaves).toBe(1);
    expect(swalvo.room).toBeUndefined();
    // The audio session started for the join is released too.
    expect(audioCalls.stop).toBeGreaterThanOrEqual(1);
  });

  it('joins an ordinary room', async () => {
    const swalvo = new Swalvo({ token: token({}), endpoint: 'wss://rtc.example.com' });
    await expect(swalvo.join('room_1', { requestPermissions: false })).resolves.toBeDefined();
  });
});

describe('codec options', () => {
  it('passes audioRed and videoCodec through to the RTC client', () => {
    new Swalvo({ token: token({}), endpoint: 'wss://rtc.example.com', audioRed: false, videoCodec: 'h264' });
    expect(state.configs[0]).toMatchObject({ audioRed: false, videoCodec: 'h264' });
  });
});
