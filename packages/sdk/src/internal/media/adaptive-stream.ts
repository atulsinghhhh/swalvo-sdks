/**
 * Picking a simulcast layer from the size a video is actually rendered at.
 *
 * Without this, every subscriber receives whatever the SFU's `auto`
 * resolves to — the highest layer the publisher sends — however small the
 * element showing it. A 180px grid tile decoding a 1280-wide stream is the
 * waste this removes, and at six or eight participants it is the difference
 * between a call that works on a phone and one that does not.
 */

/** The layer names the protocol carries. Same three RIDs the publisher sends. */
export type VideoLayer = 'low' | 'medium' | 'high' | 'auto';

/**
 * Below this many CSS pixels wide, a tile is served by `low`.
 *
 * Identical to the Flutter SDK's `adaptiveLowThreshold`
 * (`sdks/flutter/swalvo_rtc/lib/src/internal/adaptive_layer.dart`). Two SDKs
 * against the same SFU disagreeing about what "small" means would show up
 * as the same call looking different on a phone and a laptop, for a reason
 * no user could discover.
 *
 * `low` is a quarter of the publisher's width, so a 1280-wide capture gives
 * a 320-wide layer: ample for anything under this threshold.
 */
export const ADAPTIVE_LOW_THRESHOLD = 240;

/**
 * Above this many CSS pixels wide, a tile is served by `high`. `medium` is
 * half the publisher's width — 640 of a 1280 capture — which covers
 * everything below.
 */
export const ADAPTIVE_HIGH_THRESHOLD = 640;

/**
 * How much a tile must overshoot a threshold before it climbs.
 *
 * Climbing costs a real layer switch: the SFU waits for a keyframe on the
 * new layer and asks the publisher for one, and the tile visibly stutters
 * while that happens. Falling is cheap by comparison, and the penalty for
 * falling too eagerly is a moment of softness. So the margin applies
 * upwards only.
 *
 * Without it, a grid that lands every tile on the same width a few pixels
 * either side of a threshold — which is exactly what an evenly divided
 * layout does — flips every tile on every small nudge.
 */
export const ADAPTIVE_HYSTERESIS = 1.2;

/**
 * How long a tile must hold a new size before the request goes out.
 *
 * A window resize, a CSS transition or a grid reflowing as somebody joins
 * all produce a burst of `ResizeObserver` callbacks. A message per frame
 * buys nothing and walks the connection towards its signaling rate limit.
 */
export const ADAPTIVE_DEBOUNCE_MS = 250;

/**
 * How long a track must stay out of sight before it is paused at the SFU.
 *
 * Longer than the size debounce on purpose. Pausing is cheap, but resuming
 * costs a keyframe and a visible beat of frozen picture, so a tile that
 * flicks past during a scroll, or a tab switched away from and straight
 * back, should not pay it. Coming back into view is never delayed.
 */
export const ADAPTIVE_PAUSE_DELAY_MS = 500;

/**
 * The layer that should serve a tile `width` CSS pixels wide.
 *
 * `current` is the layer already in use, which is what makes this sticky
 * rather than a plain threshold lookup. Pass undefined on first
 * measurement.
 */
export function layerForWidth(width: number, current?: VideoLayer): Exclude<VideoLayer, 'auto'> {
  const plain = (): Exclude<VideoLayer, 'auto'> => {
    if (width < ADAPTIVE_LOW_THRESHOLD) return 'low';
    if (width < ADAPTIVE_HIGH_THRESHOLD) return 'medium';
    return 'high';
  };

  switch (current) {
    case 'low':
      // Climbing out of low: clear the boundary by the margin, and only
      // jump straight to high if it clears that boundary by the margin too.
      if (width >= ADAPTIVE_LOW_THRESHOLD * ADAPTIVE_HYSTERESIS) {
        return width >= ADAPTIVE_HIGH_THRESHOLD * ADAPTIVE_HYSTERESIS ? 'high' : 'medium';
      }
      return 'low';

    case 'medium':
      // In the middle: climbing needs the margin, falling does not.
      if (width >= ADAPTIVE_HIGH_THRESHOLD * ADAPTIVE_HYSTERESIS) return 'high';
      return width < ADAPTIVE_LOW_THRESHOLD ? 'low' : 'medium';

    case 'high':
      // Falling from high: drops as soon as it is genuinely below.
      if (width < ADAPTIVE_LOW_THRESHOLD) return 'low';
      return width < ADAPTIVE_HIGH_THRESHOLD ? 'medium' : 'high';

    default:
      // `auto` is not a size, and undefined is the first measurement.
      // Neither has a previous layer to be sticky about.
      return plain();
  }
}

/** What the observer needs from the outside world. */
export interface AdaptiveStreamOptions {
  /** Sends the preference on. Called only when the layer actually changes. */
  request: (layer: Exclude<VideoLayer, 'auto'>) => void;
  /**
   * Told when the track goes out of sight (after `ADAPTIVE_PAUSE_DELAY_MS`)
   * or back into it (at once). Called only on a change. Starts visible.
   */
  visibility?: (visible: boolean) => void;
  /** Overridable so tests need neither a real clock nor a real DOM. */
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Watches the elements a track is attached to and keeps its layer in step.
 *
 * Sized off the **largest** attached element, not the most recent. The same
 * track is routinely shown twice — a grid tile and a spotlight, a thumbnail
 * and a fullscreen view — and the layer has to serve the biggest of them or
 * the large one renders visibly soft. Taking the last element to be
 * measured instead would make quality depend on resize ordering, which is
 * not something an application can control or debug.
 */
export class AdaptiveStreamController {
  private readonly elements = new Map<Element, number>();
  private observer?: ResizeObserver;
  private timer: unknown;
  private current?: Exclude<VideoLayer, 'auto'>;
  private disposed = false;

  // --- Visibility ------------------------------------------------------
  //
  // A track is visible while at least one element it is attached to is in
  // the document, has a size, intersects the viewport, and the page itself
  // is not hidden — or is the picture-in-picture element, which stays on
  // screen when the tab does not. A track that has never been attached is
  // visible: the SDK cannot see how it is being used (a canvas, a
  // recorder, a React Native view), and pausing what it cannot see would
  // break all of those.

  /** Last intersection report per element. Absent means "not reported", read as intersecting. */
  private readonly intersecting = new Map<Element, boolean>();
  private intersectionObserver?: IntersectionObserver;
  private everObserved = false;
  /** What the renderer said through `setVisible()`, for views the SDK cannot observe. */
  private manualVisible?: boolean;
  private reportedVisible = true;
  private visibilityTimer: unknown;
  private visibilityListener?: () => void;

  constructor(private readonly options: AdaptiveStreamOptions) {}

  /** Whether this environment can observe element size at all. */
  static get supported(): boolean {
    return typeof ResizeObserver !== 'undefined';
  }

  observe(element: Element): void {
    if (this.disposed || !AdaptiveStreamController.supported) return;

    if (!this.observer) {
      this.observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          this.elements.set(entry.target, this.widthOf(entry));
        }
        this.schedule();
        this.updateVisibility();
      });
    }

    // Seeded from the element's current size rather than waiting for the
    // first callback. An element attached at its final size may never
    // resize again, and a track that stayed on the SFU's default layer
    // because nothing ever fired is the failure mode that looks exactly
    // like adaptive streaming not existing.
    this.elements.set(element, this.currentWidthOf(element));
    this.observer.observe(element);
    this.everObserved = true;
    this.observeVisibility(element);
    this.schedule();
    this.updateVisibility();
  }

  unobserve(element: Element): void {
    this.elements.delete(element);
    this.intersecting.delete(element);
    this.observer?.unobserve(element);
    this.intersectionObserver?.unobserve(element);
    if (this.elements.size > 0) {
      this.schedule();
    }
    this.updateVisibility();
  }

  /**
   * A visibility report from a renderer the SDK cannot observe (see
   * `RemoteTrack.setVisible`). `false` hides the track whatever its
   * elements say; `true` hands the decision back to them.
   */
  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.manualVisible = visible;
    this.updateVisibility();
  }

  /** Whether the track currently counts as on screen (after debouncing). */
  get visible(): boolean {
    return this.reportedVisible;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.clearVisibilityTimer();
    this.observer?.disconnect();
    this.observer = undefined;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = undefined;
    if (this.visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
    }
    this.visibilityListener = undefined;
    this.elements.clear();
    this.intersecting.clear();
  }

  /**
   * Re-checks visibility now, skipping the pause delay. For tests, and for
   * a caller that knows the layout settled.
   */
  flushVisibility(): void {
    this.clearVisibilityTimer();
    const visible = this.computeVisible();
    if (visible !== this.reportedVisible) {
      this.reportedVisible = visible;
      this.options.visibility?.(visible);
    }
  }

  private observeVisibility(element: Element): void {
    if (typeof IntersectionObserver !== 'undefined') {
      if (!this.intersectionObserver) {
        this.intersectionObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (this.elements.has(entry.target)) {
              this.intersecting.set(entry.target, entry.isIntersecting);
            }
          }
          this.updateVisibility();
        });
      }
      this.intersectionObserver.observe(element);
    }
    if (!this.visibilityListener && typeof document !== 'undefined' && document.addEventListener) {
      this.visibilityListener = () => this.updateVisibility();
      document.addEventListener('visibilitychange', this.visibilityListener);
    }
  }

  private computeVisible(): boolean {
    if (this.manualVisible === false) return false;
    if (!this.everObserved) return true;
    // Attached once and detached from everything since: nothing shows it.
    if (this.elements.size === 0) return false;

    const pip = typeof document !== 'undefined' ? (document as Document).pictureInPictureElement : null;
    const pageHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';

    for (const [element, width] of this.elements) {
      if (pip && pip === element) return true;
      if (pageHidden) continue;
      if ((element as { isConnected?: boolean }).isConnected === false) continue;
      if (!(width > 0) && !(this.currentWidthOf(element) > 0)) continue;
      if (this.intersecting.get(element) === false) continue;
      return true;
    }
    return false;
  }

  private updateVisibility(): void {
    if (this.disposed) return;
    const visible = this.computeVisible();
    if (visible) {
      // Back on screen: never make anyone wait for their video.
      this.clearVisibilityTimer();
      if (!this.reportedVisible) {
        this.reportedVisible = true;
        this.options.visibility?.(true);
      }
      return;
    }
    if (!this.reportedVisible || this.visibilityTimer !== undefined) return;
    const setTimer = this.options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
    this.visibilityTimer = setTimer(() => {
      this.visibilityTimer = undefined;
      if (this.disposed || this.computeVisible() || !this.reportedVisible) return;
      this.reportedVisible = false;
      this.options.visibility?.(false);
    }, ADAPTIVE_PAUSE_DELAY_MS);
  }

  private clearVisibilityTimer(): void {
    if (this.visibilityTimer === undefined) return;
    const clear = this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never));
    clear(this.visibilityTimer);
    this.visibilityTimer = undefined;
  }

  /**
   * Re-evaluates now, skipping the debounce.
   *
   * For the caller that already knows the size settled — a test, or a
   * resubscribe after reconnect where the SFU has forgotten the preference
   * and waiting 250ms would leave the tile on the wrong layer meanwhile.
   */
  flush(): void {
    this.clearTimer();
    this.evaluate();
  }

  private schedule(): void {
    if (this.disposed) return;
    this.clearTimer();
    const setTimer = this.options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
    this.timer = setTimer(() => this.evaluate(), ADAPTIVE_DEBOUNCE_MS);
  }

  private evaluate(): void {
    if (this.disposed || this.elements.size === 0) return;

    const widest = Math.max(...this.elements.values());
    if (!Number.isFinite(widest) || widest <= 0) return;

    const next = layerForWidth(widest, this.current);
    if (next === this.current) return;

    this.current = next;
    this.options.request(next);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    const clear = this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never));
    clear(this.timer);
    this.timer = undefined;
  }

  private widthOf(entry: ResizeObserverEntry): number {
    // contentBoxSize is the modern shape; contentRect is what older
    // implementations report. Neither is guaranteed, hence the fallback to
    // the element itself.
    const box = Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0] : entry.contentBoxSize;
    if (box && typeof box.inlineSize === 'number' && box.inlineSize > 0) {
      return box.inlineSize;
    }
    if (entry.contentRect && entry.contentRect.width > 0) {
      return entry.contentRect.width;
    }
    return this.currentWidthOf(entry.target);
  }

  private currentWidthOf(element: Element): number {
    const width = (element as HTMLElement).clientWidth;
    return typeof width === 'number' && width > 0 ? width : 0;
  }
}
