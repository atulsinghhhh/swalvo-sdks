import type { DeviceKind } from '@swalvo/rtc';

/**
 * Two tiny per-room stores the video UI kit shares between components that
 * have no parent in common: a device picker and the toggle that later
 * enables that device; the audio renderer and the "start audio" button.
 *
 * Keyed by the `Room` object (a WeakMap, so a room that is gone takes its
 * entry with it), or by a module-level key outside a room, so `<PreJoin>`
 * and friends work standalone.
 */

const NO_ROOM: object = {};

type Listener = () => void;

class Observable {
  private readonly listeners = new Set<Listener>();
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected notify(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
}

/**
 * The device a user picked for each kind. The SDK only switches the device
 * behind a track that is already published, so a camera picked while the
 * camera is off has to be remembered here and applied when it is enabled.
 */
export class DevicePreferences extends Observable {
  private readonly preferred: Partial<Record<DeviceKind, string>> = {};

  get(kind: DeviceKind): string | undefined {
    return this.preferred[kind];
  }

  set(kind: DeviceKind, deviceId: string | undefined): void {
    if (this.preferred[kind] === deviceId) return;
    this.preferred[kind] = deviceId;
    this.notify();
  }
}

const devicePreferences = /* @__PURE__ */ new WeakMap<object, DevicePreferences>();

export function devicePreferencesFor(room: object | undefined): DevicePreferences {
  const key = room ?? NO_ROOM;
  let prefs = devicePreferences.get(key);
  if (!prefs) {
    prefs = new DevicePreferences();
    devicePreferences.set(key, prefs);
  }
  return prefs;
}

/**
 * Tracks whether the browser's autoplay policy blocked remote audio. Every
 * `<audio>` the kit renders registers here; a rejected `play()` with
 * `NotAllowedError` flips `blocked`, and `start()` — called from a user
 * gesture by `<StartAudio>` — retries them all.
 */
export class AudioPlayback extends Observable {
  private readonly elements = new Set<HTMLMediaElement>();
  private _blocked = false;

  get blocked(): boolean {
    return this._blocked;
  }

  private setBlocked(blocked: boolean): void {
    if (this._blocked === blocked) return;
    this._blocked = blocked;
    this.notify();
  }

  register(element: HTMLMediaElement): () => void {
    this.elements.add(element);
    this.tryPlay(element);
    return () => {
      this.elements.delete(element);
      if (this.elements.size === 0) this.setBlocked(false);
    };
  }

  private tryPlay(element: HTMLMediaElement): Promise<boolean> {
    let result: Promise<void> | undefined;
    try {
      result = element.play?.() as Promise<void> | undefined;
    } catch {
      return Promise.resolve(false);
    }
    if (!result || typeof result.then !== 'function') return Promise.resolve(true);
    return result.then(
      () => true,
      (error: { name?: string }) => {
        if (error?.name === 'NotAllowedError') this.setBlocked(true);
        return false;
      },
    );
  }

  /** Retries playback for every element. Call it from a click handler. */
  async start(): Promise<void> {
    const results = await Promise.all(Array.from(this.elements).map((element) => this.tryPlay(element)));
    if (results.every(Boolean)) this.setBlocked(false);
  }
}

const audioPlayback = /* @__PURE__ */ new WeakMap<object, AudioPlayback>();

export function audioPlaybackFor(room: object | undefined): AudioPlayback {
  const key = room ?? NO_ROOM;
  let playback = audioPlayback.get(key);
  if (!playback) {
    playback = new AudioPlayback();
    audioPlayback.set(key, playback);
  }
  return playback;
}
