/**
 * Stands in for `react-native-incall-manager`.
 *
 * Records what the audio module asks of the native layer. The real module's
 * methods are synchronous and fire-and-forget, so these are too. The
 * adapter is the thing that makes them awaitable.
 */
export const __calls = {
  start: 0,
  stop: 0,
  forceSpeakerphone: [] as (boolean | null)[],
  chosenRoutes: [] as string[],
};

const InCallManager = {
  start: jest.fn((_options?: { media?: string; auto?: boolean }) => {
    __calls.start += 1;
  }),
  stop: jest.fn(() => {
    __calls.stop += 1;
  }),
  setForceSpeakerphoneOn: jest.fn((enabled: boolean | null) => {
    __calls.forceSpeakerphone.push(enabled);
  }),
  chooseAudioRoute: jest.fn(async (route: string) => {
    __calls.chosenRoutes.push(route);
    return {};
  }),
};

export function __resetCalls(): void {
  __calls.start = 0;
  __calls.stop = 0;
  __calls.forceSpeakerphone = [];
  __calls.chosenRoutes = [];
}

export default InCallManager;
