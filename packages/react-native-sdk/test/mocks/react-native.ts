/**
 * Stand-in for react-native's JS surface.
 *
 * The real package won't import under plain Jest; it ships Flow types and
 * expects Metro. Only the bits this SDK actually touches are modelled here.
 * `__setPlatform` lets one test run exercise both platforms, which is the
 * entire point of testing the permissions layer.
 */
export const __platformState = { OS: 'ios' as 'ios' | 'android' | 'web' };

export const Platform = {
  get OS() {
    return __platformState.OS;
  },
  select: <T>(spec: Record<string, T>): T | undefined => spec[__platformState.OS] ?? spec.default,
};

export function __setPlatform(os: 'ios' | 'android' | 'web'): void {
  __platformState.OS = os;
}

export const PermissionsAndroid = {
  PERMISSIONS: {
    CAMERA: 'android.permission.CAMERA',
    RECORD_AUDIO: 'android.permission.RECORD_AUDIO',
  },
  RESULTS: {
    GRANTED: 'granted',
    DENIED: 'denied',
    NEVER_ASK_AGAIN: 'never_ask_again',
  },
  check: jest.fn(async () => false),
  request: jest.fn(async () => 'granted'),
  requestMultiple: jest.fn(async () => ({})),
};

type AppStateListener = (state: string) => void;

export const __appState = {
  listeners: new Set<AppStateListener>(),
  current: 'active' as string,
};

export const AppState = {
  get currentState() {
    return __appState.current;
  },
  addEventListener(_event: string, listener: AppStateListener) {
    __appState.listeners.add(listener);
    return {
      remove() {
        __appState.listeners.delete(listener);
      },
    };
  },
};

/** Fakes an OS lifecycle transition in a test. */
export function __emitAppState(next: string): void {
  __appState.current = next;
  for (const listener of Array.from(__appState.listeners)) listener(next);
}

export const StyleSheet = {
  create: <T>(styles: T): T => styles,
  flatten: (style: unknown) => style,
};

export const View = 'View';
export type ViewStyle = Record<string, unknown>;
export type NativeEventSubscription = { remove(): void };
export type AppStateStatus = string;
