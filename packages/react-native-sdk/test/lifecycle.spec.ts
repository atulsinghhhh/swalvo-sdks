import { LifecycleWatcher, NetworkWatcher } from '../src/internal/lifecycle';
import { __appState, __emitAppState } from './mocks/react-native';

beforeEach(() => {
  __appState.listeners.clear();
  __appState.current = 'active';
});

describe('LifecycleWatcher', () => {
  it('reports foreground and background transitions', () => {
    const events: string[] = [];
    const watcher = new LifecycleWatcher({
      onForeground: () => events.push('foreground'),
      onBackground: () => events.push('background'),
    });

    watcher.start();
    __emitAppState('background');
    __emitAppState('active');

    expect(events).toEqual(['background', 'foreground']);
  });

  it('ignores repeats of the state it is already in', () => {
    const events: string[] = [];
    const watcher = new LifecycleWatcher({
      onForeground: () => events.push('foreground'),
      onBackground: () => events.push('background'),
    });

    watcher.start();
    __emitAppState('background');
    __emitAppState('background');

    // Android emits duplicate change events in some situations. Act on
    // each one and you tear down and rebuild media over and over.
    expect(events).toEqual(['background']);
  });

  it('treats iOS "inactive" as its own state, not as backgrounded', () => {
    const events: string[] = [];
    const watcher = new LifecycleWatcher({
      onForeground: () => events.push('foreground'),
      onBackground: () => events.push('background'),
      onInactive: () => events.push('inactive'),
    });

    watcher.start();
    // Raised by a phone call or the app switcher. The app is still running,
    // so treating it as a background would end calls every time someone
    // glanced at Control Centre.
    __emitAppState('inactive');

    expect(events).toEqual(['inactive']);
    expect(watcher.state).toBe('inactive');
  });

  it('detaches on stop, so a torn-down screen stops receiving events', () => {
    const events: string[] = [];
    const watcher = new LifecycleWatcher({
      onForeground: () => events.push('foreground'),
      onBackground: () => events.push('background'),
    });

    watcher.start();
    watcher.stop();
    __emitAppState('background');

    expect(events).toEqual([]);
    expect(__appState.listeners.size).toBe(0);
  });

  it('does not register twice when started twice', () => {
    const watcher = new LifecycleWatcher({ onForeground: () => {}, onBackground: () => {} });

    watcher.start();
    watcher.start();

    // A second listener doubles every callback, and leaks, because stop()
    // only removes one subscription.
    expect(__appState.listeners.size).toBe(1);
    watcher.stop();
  });
});

describe('NetworkWatcher', () => {
  it('degrades to a no-op when NetInfo is not installed', () => {
    // NetInfo is an optional peer dependency. Going without should cost you
    // faster reconnects, not a crash at construction.
    const watcher = new NetworkWatcher(() => {});
    expect(() => watcher.start()).not.toThrow();
    expect(watcher.isObserving).toBe(false);
    expect(() => watcher.stop()).not.toThrow();
  });
});
