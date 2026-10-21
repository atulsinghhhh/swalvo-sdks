import { reportViewVisibility, withdrawView } from '../src/internal/view-visibility';

/**
 * React Native's stand-in for the web SDK's element observation: views
 * report, this aggregates per track, the core gets one flag.
 */
const configs: Record<string, unknown>[] = [];
const coreTests: unknown[] = [];

jest.mock('@swalvo/rtc', () => ({
  createRTCClient: (config: Record<string, unknown>) => {
    configs.push(config);
    return { join: async () => ({}), leave: async () => undefined };
  },
  runConnectionTest: async (options: unknown) => {
    coreTests.push(options);
    return { ok: true };
  },
  RTCError: class RTCError extends Error {},
}));

function remoteTrack() {
  return { setVisible: jest.fn() };
}

describe('view visibility', () => {
  it('pushes a single view’s visibility straight through', () => {
    const track = remoteTrack();
    const view = {};
    reportViewVisibility(track, view, false);
    reportViewVisibility(track, view, true);
    expect(track.setVisible.mock.calls).toEqual([[false], [true]]);
  });

  it('keeps a track on while any view of it is visible', () => {
    const track = remoteTrack();
    const tile = {};
    const spotlight = {};
    reportViewVisibility(track, tile, true);
    reportViewVisibility(track, spotlight, true);
    reportViewVisibility(track, tile, false);
    expect(track.setVisible).toHaveBeenLastCalledWith(true);

    reportViewVisibility(track, spotlight, false);
    expect(track.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('counts the last view unmounting as hidden, like a web track detached from its last element', () => {
    const track = remoteTrack();
    const view = {};
    reportViewVisibility(track, view, true);
    withdrawView(track, view);
    expect(track.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('ignores a view it never heard from, and tracks without visibility (local tracks, older SDKs)', () => {
    const track = remoteTrack();
    withdrawView(track, {});
    expect(track.setVisible).not.toHaveBeenCalled();
    expect(() => reportViewVisibility({}, {}, false)).not.toThrow();
  });
});

describe('Swalvo media options', () => {
  it('hands adaptiveStream and autoSubscribe to the shared core', () => {
    const { Swalvo } = require('../src/swalvo') as typeof import('../src/swalvo');
    new Swalvo({ token: 't', endpoint: 'wss://rtc.example', adaptiveStream: false, autoSubscribe: false });
    expect(configs.at(-1)).toMatchObject({ adaptiveStream: false, autoSubscribe: false });
  });

  it('runs the core pre-call test with the WebRTC globals in place', async () => {
    const { runConnectionTest } = require('../src/preflight') as typeof import('../src/preflight');
    const result = await runConnectionTest({ token: 't', endpoint: 'wss://rtc.example' });
    expect(result).toEqual({ ok: true });
    expect(coreTests).toHaveLength(1);
  });
});
