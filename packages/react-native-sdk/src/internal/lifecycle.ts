import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

export type SwalvoAppState = 'active' | 'background' | 'inactive';

export interface LifecycleHandlers {
  onForeground(): void;
  onBackground(): void;
  /** iOS only. A transient state during a phone call, Control Centre, or the app switcher. */
  onInactive?(): void;
}

/**
 * Watches the OS app lifecycle so the SDK can respond to a call being
 * backgrounded.
 *
 * What it very deliberately does *not* do is tear the connection down when
 * the app goes into the background. On both platforms a backgrounded app
 * with a live audio session keeps running, and dropping the socket turns
 * "switched to Messages for four seconds" into "left the meeting". Video
 * capture is the thing that actually stops: iOS suspends the camera, and
 * Android does the same without a foreground service. So the useful move
 * on return is re-checking state, not reconnecting.
 *
 * Anything more aggressive belongs to the app, not the SDK. Whether a
 * backgrounded user should stay in the room is a product decision, and
 * deciding it here takes it away from the developer.
 */
export class LifecycleWatcher {
  private subscription?: NativeEventSubscription;
  // AppState.currentState can genuinely be null/undefined for an instant
  // before the native module finishes initializing (and some
  // react-native/@types versions widen its declared type to reflect
  // that) — default to 'active' rather than assume the narrower type,
  // since the safe conservative reading is "no state change yet".
  private current: AppStateStatus = (AppState.currentState as AppStateStatus | null | undefined) ?? 'active';

  constructor(private readonly handlers: LifecycleHandlers) {}

  start(): void {
    if (this.subscription) {
      return;
    }
    this.subscription = AppState.addEventListener('change', this.handleChange);
  }

  stop(): void {
    this.subscription?.remove();
    this.subscription = undefined;
  }

  get state(): SwalvoAppState {
    return normalize(this.current);
  }

  private handleChange = (next: AppStateStatus): void => {
    const previous = normalize(this.current);
    const upcoming = normalize(next);
    this.current = next;

    if (previous === upcoming) {
      return;
    }

    if (upcoming === 'active') {
      this.handlers.onForeground();
      return;
    }
    if (upcoming === 'background') {
      this.handlers.onBackground();
      return;
    }
    this.handlers.onInactive?.();
  };
}

function normalize(status: AppStateStatus): SwalvoAppState {
  if (status === 'active') return 'active';
  // iOS reports 'inactive' during a call or the app switcher. Android never
  // does. Everything else ('extension', 'unknown') counts as backgrounded,
  // which is the conservative reading.
  if (status === 'inactive') return 'inactive';
  return 'background';
}

/**
 * Watches connectivity, so a Wi-Fi → cellular handover becomes a
 * deliberate reconnect instead of a slow timeout.
 *
 * `@react-native-community/netinfo` is an *optional* peer dependency. It's
 * the standard way to observe connectivity in React Native, but it's also
 * another native module to link, and Swalvo works fine without it: ICE
 * notices a dead path on its own eventually. Having it just makes recovery
 * quicker. So this resolves it lazily and falls back to a no-op when it
 * isn't installed.
 */
export class NetworkWatcher {
  private unsubscribe?: () => void;
  private lastReachable = true;

  constructor(private readonly onReconnected: () => void) {}

  start(): void {
    if (this.unsubscribe) {
      return;
    }

    const netInfo = loadNetInfo();
    if (!netInfo) {
      return;
    }

    this.unsubscribe = netInfo.addEventListener((state) => {
      const reachable = state.isConnected !== false;
      const regained = reachable && !this.lastReachable;
      this.lastReachable = reachable;

      // Only fire on the transition back to connectivity. Fire on every
      // NetInfo event and you'd reconnect on a signal-strength change.
      if (regained) {
        this.onReconnected();
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** True when we can actually observe connectivity. */
  get isObserving(): boolean {
    return this.unsubscribe !== undefined;
  }
}

interface NetInfoLike {
  addEventListener(listener: (state: { isConnected: boolean | null }) => void): () => void;
}

function loadNetInfo(): NetInfoLike | undefined {
  try {
    // Resolved at runtime on purpose. A static import would make an
    // optional peer dependency mandatory at bundle time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-community/netinfo');
    const candidate = (mod?.default ?? mod) as NetInfoLike | undefined;
    return typeof candidate?.addEventListener === 'function' ? candidate : undefined;
  } catch {
    return undefined;
  }
}
