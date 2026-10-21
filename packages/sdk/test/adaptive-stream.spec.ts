import {
  ADAPTIVE_PAUSE_DELAY_MS,
  ADAPTIVE_DEBOUNCE_MS,
  ADAPTIVE_HIGH_THRESHOLD,
  ADAPTIVE_HYSTERESIS,
  ADAPTIVE_LOW_THRESHOLD,
  AdaptiveStreamController,
  layerForWidth,
  type VideoLayer,
} from '../src/internal/media/adaptive-stream';

/**
 * The size-to-layer rule behind `adaptiveStream`, and the observer that
 * drives it.
 *
 * The interesting behaviour is not "which layer for which width" — that is
 * a lookup — but what happens at the boundaries, where a naive threshold
 * oscillates. Every flip costs a real layer switch at the SFU: it waits for
 * a keyframe on the new layer and asks the publisher for one, and the tile
 * visibly stutters while that happens.
 */
describe('layerForWidth', () => {
  describe('from a standing start', () => {
    it('serves a 180px grid thumbnail with low', () => {
      expect(layerForWidth(180)).toBe('low');
    });

    it('serves a 480px tile with medium', () => {
      expect(layerForWidth(480)).toBe('medium');
    });

    it('serves a fullscreen view with high', () => {
      expect(layerForWidth(1920)).toBe('high');
    });

    it('breaks a tie downwards', () => {
      // The cost of being one layer too low for a moment is a little
      // softness; the cost of being too high is bitrate every participant
      // pays for.
      expect(layerForWidth(ADAPTIVE_LOW_THRESHOLD - 1)).toBe('low');
      expect(layerForWidth(ADAPTIVE_HIGH_THRESHOLD - 1)).toBe('medium');
    });
  });

  describe('hysteresis', () => {
    it('does not climb for a tile sitting just past a boundary', () => {
      // The case that makes an evenly divided grid flap: every tile lands
      // on the same width, a few pixels either side of a threshold.
      expect(layerForWidth(ADAPTIVE_LOW_THRESHOLD + 8, 'low')).toBe('low');
    });

    it('does climb for a tile that genuinely grows', () => {
      expect(layerForWidth(ADAPTIVE_LOW_THRESHOLD * ADAPTIVE_HYSTERESIS + 1, 'low')).toBe('medium');
    });

    it('falls without needing a margin', () => {
      // Asymmetric on purpose: dropping is cheap and immediately correct,
      // climbing costs a keyframe and a stutter.
      expect(layerForWidth(ADAPTIVE_LOW_THRESHOLD - 1, 'high')).toBe('low');
      expect(layerForWidth(ADAPTIVE_HIGH_THRESHOLD - 1, 'high')).toBe('medium');
    });

    it('settles instead of flapping when a tile is nudged around a boundary', () => {
      // Without hysteresis this sequence produces low, medium, low,
      // medium, ... and each pair is two layer switches.
      let layer: VideoLayer = layerForWidth(220);
      expect(layer).toBe('low');

      for (const width of [238, 242, 236, 245, 239, 250]) {
        layer = layerForWidth(width, layer);
        expect(layer).toBe('low');
      }
    });

    it('jumps straight to high when a thumbnail becomes fullscreen', () => {
      expect(layerForWidth(1920, 'low')).toBe('high');
    });
  });

  describe('parity with the Flutter SDK', () => {
    it('maps the documented sizes to the documented layers', () => {
      // sdks/flutter/swalvo_rtc/test/adaptive_layer_test.dart asserts the
      // identical triple against the identical thresholds. If one moves
      // without the other, the same call renders at different quality on a
      // phone and a laptop for no reason a user could discover.
      expect(layerForWidth(180)).toBe('low');
      expect(layerForWidth(480)).toBe('medium');
      expect(layerForWidth(1920)).toBe('high');
      expect(ADAPTIVE_LOW_THRESHOLD).toBe(240);
      expect(ADAPTIVE_HIGH_THRESHOLD).toBe(640);
    });
  });
});

/**
 * A ResizeObserver stand-in.
 *
 * jsdom has none, and installing a real one would not help: the point of
 * these tests is what the controller does with the sizes, not whether the
 * browser reports them.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
  }

  /** Delivers a size change, as the browser would. */
  resize(element: Element, width: number): void {
    this.callback(
      [{ target: element, contentRect: { width } as DOMRectReadOnly } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

function elementOfWidth(width: number): HTMLElement {
  const element = document.createElement('video');
  Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
  return element;
}

describe('AdaptiveStreamController', () => {
  // Keyed by a monotonic id rather than an array index: the controller
  // clears a timer it scheduled several resizes ago, and an index into an
  // array that has since been drained points at the wrong callback.
  let timers: Map<number, () => void>;
  let nextTimerId: number;
  let requested: VideoLayer[];

  const controllerFor = () => {
    timers = new Map();
    nextTimerId = 0;
    requested = [];
    return new AdaptiveStreamController({
      request: (layer) => requested.push(layer),
      // The debounce is driven by hand so a test never waits on a clock.
      setTimer: (callback) => {
        const id = nextTimerId++;
        timers.set(id, callback);
        return id;
      },
      clearTimer: (handle) => {
        timers.delete(handle as number);
      },
    });
  };

  const runTimers = () => {
    const pending = Array.from(timers.values());
    timers.clear();
    for (const timer of pending) timer();
  };

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  });

  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  it('asks for a layer matching the element it was attached to', () => {
    const controller = controllerFor();
    controller.observe(elementOfWidth(180));
    runTimers();

    expect(requested).toEqual(['low']);
    controller.dispose();
  });

  it('does not wait for a resize that may never come', () => {
    // An element attached at its final size can legitimately never fire
    // ResizeObserver again. A controller that only acted on callbacks would
    // leave the track on the SFU's default layer forever, which looks
    // exactly like adaptive streaming not existing.
    const controller = controllerFor();
    controller.observe(elementOfWidth(1920));
    runTimers();

    expect(requested).toEqual(['high']);
    controller.dispose();
  });

  it('coalesces a burst of resizes into one request', () => {
    const controller = controllerFor();
    const element = elementOfWidth(180);
    controller.observe(element);

    const observer = FakeResizeObserver.instances[0];
    for (const width of [300, 500, 700, 900, 1200]) {
      observer.resize(element, width);
    }
    runTimers();

    // A window drag produces one of these per frame. One message at the end
    // is the whole point; a message per frame walks the connection towards
    // its signaling rate limit and buys nothing.
    expect(requested).toEqual(['high']);
    controller.dispose();
  });

  it('never requests the same layer twice', () => {
    const controller = controllerFor();
    const element = elementOfWidth(180);
    controller.observe(element);
    runTimers();

    const observer = FakeResizeObserver.instances[0];
    observer.resize(element, 190);
    runTimers();
    observer.resize(element, 200);
    runTimers();

    expect(requested).toEqual(['low']);
    controller.dispose();
  });

  it('sizes off the largest element when a track is shown twice', () => {
    // A grid tile and a spotlight of the same speaker. Serving the smaller
    // one would render the large view visibly soft, and taking whichever
    // resized last would make quality depend on layout ordering — not
    // something an application can control or debug.
    const controller = controllerFor();
    controller.observe(elementOfWidth(160));
    controller.observe(elementOfWidth(1280));
    runTimers();

    expect(requested).toEqual(['high']);
    controller.dispose();
  });

  it('drops back down when the large element goes away', () => {
    const controller = controllerFor();
    const thumbnail = elementOfWidth(160);
    const spotlight = elementOfWidth(1280);
    controller.observe(thumbnail);
    controller.observe(spotlight);
    runTimers();
    expect(requested).toEqual(['high']);

    controller.unobserve(spotlight);
    runTimers();

    expect(requested).toEqual(['high', 'low']);
    controller.dispose();
  });

  it('stops asking for anything once disposed', () => {
    const controller = controllerFor();
    controller.observe(elementOfWidth(1280));
    controller.dispose();
    runTimers();

    expect(requested).toEqual([]);
  });

  it('degrades to doing nothing where ResizeObserver does not exist', () => {
    // Rather than throwing. An environment without it still has to be able
    // to hold a call; it just holds it at the SFU's default layer.
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

    const controller = controllerFor();
    expect(() => controller.observe(elementOfWidth(180))).not.toThrow();
    runTimers();
    expect(requested).toEqual([]);
    controller.dispose();
  });

  it('debounces for a quarter of a second', () => {
    // Long enough to swallow a CSS transition, short enough that a genuine
    // layout change is served well inside a second.
    expect(ADAPTIVE_DEBOUNCE_MS).toBe(250);
  });
});

/** An IntersectionObserver stand-in; jsdom has none either. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
  }

  report(element: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target: element, isIntersecting } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

/**
 * Visibility: the half of adaptive streaming that pauses a video nobody
 * can see (docs/architecture/phase2-media-contracts.md §4, layer `off`).
 */
describe('AdaptiveStreamController visibility', () => {
  let timers: Map<number, { callback: () => void; ms: number }>;
  let nextTimerId: number;
  let visibility: boolean[];

  const controllerFor = () => {
    timers = new Map();
    nextTimerId = 0;
    visibility = [];
    return new AdaptiveStreamController({
      request: () => undefined,
      visibility: (visible) => visibility.push(visible),
      setTimer: (callback, ms) => {
        const id = nextTimerId++;
        timers.set(id, { callback, ms });
        return id;
      },
      clearTimer: (handle) => {
        timers.delete(handle as number);
      },
    });
  };

  /** Runs only the pause timers, which are the ones scheduled with the pause delay. */
  const runPauseTimers = () => {
    for (const [id, timer] of Array.from(timers)) {
      if (timer.ms === ADAPTIVE_PAUSE_DELAY_MS) {
        timers.delete(id);
        timer.callback();
      }
    }
  };

  const onScreen = (width = 320): HTMLElement => {
    const element = elementOfWidth(width);
    document.body.appendChild(element);
    return element;
  };

  let pageState: DocumentVisibilityState;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    FakeIntersectionObserver.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
    pageState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => pageState });
  });

  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    document.body.innerHTML = '';
  });

  it('waits half a second before pausing', () => {
    expect(ADAPTIVE_PAUSE_DELAY_MS).toBe(500);
  });

  it('pauses a tile scrolled out of view, after the delay, and resumes it at once', () => {
    const controller = controllerFor();
    const element = onScreen();
    controller.observe(element);
    expect(visibility).toEqual([]);

    FakeIntersectionObserver.instances[0].report(element, false);
    expect(visibility).toEqual([]);
    runPauseTimers();
    expect(visibility).toEqual([false]);

    FakeIntersectionObserver.instances[0].report(element, true);
    expect(visibility).toEqual([false, true]);
    controller.dispose();
  });

  it('does not pause a tile that comes back before the delay', () => {
    const controller = controllerFor();
    const element = onScreen();
    controller.observe(element);

    FakeIntersectionObserver.instances[0].report(element, false);
    FakeIntersectionObserver.instances[0].report(element, true);
    runPauseTimers();

    expect(visibility).toEqual([]);
    controller.dispose();
  });

  it('stays visible while any one of its elements is', () => {
    // A thumbnail scrolled away while the spotlight of the same person is
    // still showing must not pause the spotlight.
    const controller = controllerFor();
    const thumbnail = onScreen(160);
    const spotlight = onScreen(1280);
    controller.observe(thumbnail);
    controller.observe(spotlight);

    FakeIntersectionObserver.instances[0].report(thumbnail, false);
    runPauseTimers();

    expect(visibility).toEqual([]);
    controller.dispose();
  });

  it('pauses when the page is hidden', () => {
    const controller = controllerFor();
    controller.observe(onScreen());

    pageState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    runPauseTimers();
    expect(visibility).toEqual([false]);

    pageState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(visibility).toEqual([false, true]);
    controller.dispose();
  });

  it('keeps a picture-in-picture video going with the page hidden', () => {
    const controller = controllerFor();
    const element = onScreen();
    controller.observe(element);
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: element });

    pageState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    runPauseTimers();

    expect(visibility).toEqual([]);
    delete (document as { pictureInPictureElement?: unknown }).pictureInPictureElement;
    controller.dispose();
  });

  it('pauses an element taken out of the document, or collapsed to nothing', () => {
    const controller = controllerFor();
    const element = onScreen();
    controller.observe(element);

    element.remove();
    FakeResizeObserver.instances[0].resize(element, 0);
    runPauseTimers();

    expect(visibility).toEqual([false]);
    controller.dispose();
  });

  it('pauses once the last element is detached', () => {
    const controller = controllerFor();
    const element = onScreen();
    controller.observe(element);

    controller.unobserve(element);
    runPauseTimers();

    expect(visibility).toEqual([false]);
    controller.dispose();
  });

  it('never pauses a track it has never seen attached', () => {
    // A canvas, a recorder or a React Native view: the SDK cannot see how
    // it is used, and pausing what it cannot see would break all of them.
    const controller = controllerFor();
    runPauseTimers();
    expect(controller.visible).toBe(true);
    expect(visibility).toEqual([]);
    controller.dispose();
  });

  it('takes a manual report from renderers it cannot observe, without ResizeObserver', () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const controller = controllerFor();

    controller.setVisible(false);
    runPauseTimers();
    controller.setVisible(true);

    expect(visibility).toEqual([false, true]);
    controller.dispose();
  });

  it('says nothing more once disposed', () => {
    const controller = controllerFor();
    controller.setVisible(false);
    controller.dispose();
    runPauseTimers();
    expect(visibility).toEqual([]);
  });
});
