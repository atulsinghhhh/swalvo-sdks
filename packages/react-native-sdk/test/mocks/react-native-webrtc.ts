/**
 * Stands in for the native WebRTC layer.
 *
 * Records `registerGlobals` calls so the bootstrap suite can assert the
 * once-only behaviour, and exposes `RTCView` as a string element name,
 * which is how React Native's own test setup represents a native component.
 */
export const __calls = {
  registerGlobals: 0,
};

export function registerGlobals(): void {
  __calls.registerGlobals += 1;
}

export const RTCView = 'RTCView';

export function __resetCalls(): void {
  __calls.registerGlobals = 0;
}
